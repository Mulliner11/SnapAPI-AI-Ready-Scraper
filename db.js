import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

export function getPool() {
  return pool;
}

function sslOption(connectionString) {
  if (process.env.DATABASE_SSL === "false") return false;
  if (process.env.PGSSLMODE === "require" || /sslmode=require/i.test(connectionString || "")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export async function initDb() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.warn(
      "[SnapAPI] DATABASE_URL is not set. POST /screenshot and /pdf will return 503; dashboard auth disabled."
    );
    return;
  }

  const newPool = new Pool({
    connectionString: url,
    max: 10,
    ssl: sslOption(url),
  });

  try {
    await newPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      usage_count INT NOT NULL DEFAULT 0,
      max_limit INT NOT NULL DEFAULT 100,
      usage_month TEXT NOT NULL DEFAULT (to_char(timezone('utc', now()), 'YYYY-MM'))
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      target_url TEXT,
      result_path TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_request_logs_user_created ON request_logs (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS login_codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email);

    CREATE TABLE IF NOT EXISTS magic_login_tokens (
      id SERIAL PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_magic_login_expires ON magic_login_tokens (expires_at);
  `);

    await newPool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `);

    await newPool.query(`
    ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';
  `);

    await newPool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nowpayments_subscription_id TEXT;
  `);

    await newPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nowpayments_subscription_id
    ON users (nowpayments_subscription_id) WHERE nowpayments_subscription_id IS NOT NULL;
  `);

    pool = newPool;
    console.log("[SnapAPI] PostgreSQL schema ready.");
  } catch (e) {
    await newPool.end().catch(() => {});
    pool = null;
    console.error("[SnapAPI] PostgreSQL connection or schema init failed:", e?.message || e);
  }
}

function generateLiveApiKey() {
  return `sk-live-${crypto.randomBytes(18).toString("hex")}`;
}

/**
 * First-time sign-in: create user with sk-live-* key. Existing users keep their key.
 * @returns {Promise<{ id: number, email: string, api_key: string, plan: string, status: string, usage_count: number, max_limit: number, usage_month: string } | null>}
 */
export async function ensureUserByEmail(email) {
  if (!pool) return null;
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return null;

  const existing = await pool.query(
    `SELECT id, email, api_key, plan, status, usage_count, max_limit, usage_month
     FROM users WHERE lower(email) = lower($1)`,
    [normalized]
  );
  if (existing.rows[0]) return existing.rows[0];

  const apiKey = generateLiveApiKey();
  try {
    const ins = await pool.query(
      `INSERT INTO users (email, api_key, plan, status, max_limit)
       VALUES ($1, $2, 'free', 'active', 100)
       RETURNING id, email, api_key, plan, status, usage_count, max_limit, usage_month`,
      [normalized, apiKey]
    );
    return ins.rows[0] || null;
  } catch (e) {
    if (e.code === "23505") {
      const again = await pool.query(
        `SELECT id, email, api_key, plan, status, usage_count, max_limit, usage_month
         FROM users WHERE lower(email) = lower($1)`,
        [normalized]
      );
      return again.rows[0] || null;
    }
    throw e;
  }
}

function currentUsageMonth() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Resolve user by API key; reset monthly usage when month changes.
 * @returns {Promise<{ id: number, email: string, api_key: string, plan: string, usage_count: number, max_limit: number } | null>}
 */
export async function findUserForApiKey(apiKey) {
  if (!pool || !apiKey || typeof apiKey !== "string") return null;

  const r = await pool.query(
    `SELECT id, email, api_key, plan, status, usage_count, max_limit, usage_month
     FROM users
     WHERE api_key = $1 AND status = 'active'`,
    [apiKey.trim()]
  );
  const row = r.rows[0];
  if (!row) return null;

  const month = currentUsageMonth();
  if (row.usage_month !== month) {
    await pool.query(`UPDATE users SET usage_count = 0, usage_month = $1 WHERE id = $2`, [month, row.id]);
    row.usage_count = 0;
    row.usage_month = month;
  }

  return row;
}

export async function upsertPaidUserByEmail(email, plan, apiKey, status = "active") {
  if (!pool) throw new Error("Database not configured");
  const normalized = String(email || "").trim().toLowerCase();
  const r = await pool.query(
    `INSERT INTO users (email, api_key, plan, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email)
     DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, api_key = EXCLUDED.api_key
     RETURNING id, email, api_key, plan, status, usage_count, max_limit, usage_month`,
    [normalized, apiKey.trim(), plan, status]
  );
  return r.rows[0];
}

const PLAN_MAX_LIMIT = { free: 100, pro: 5000, business: 50_000 };

function normalizedPlan(plan) {
  const p = String(plan || "free").toLowerCase();
  if (p === "business") return "business";
  if (p === "pro") return "pro";
  return "free";
}

/**
 * Apply a paid plan after NOWPayments (or similar): update plan + quota, keep existing api_key.
 * If no user row exists, insert with a new sk-live-* key.
 */
export async function upgradeUserSubscriptionByEmail(email, plan) {
  if (!pool) throw new Error("Database not configured");
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) throw new Error("Invalid email");
  const p = normalizedPlan(plan);
  const maxLimit = PLAN_MAX_LIMIT[p] ?? PLAN_MAX_LIMIT.free;

  const upd = await pool.query(
    `UPDATE users SET plan = $2, max_limit = $3, status = 'active' WHERE lower(email) = lower($1)
     RETURNING id, email, api_key, plan, status, usage_count, max_limit, usage_month, nowpayments_subscription_id`,
    [normalized, p, maxLimit]
  );
  if (upd.rows[0]) return upd.rows[0];

  const apiKey = generateLiveApiKey();
  const ins = await pool.query(
    `INSERT INTO users (email, api_key, plan, status, max_limit)
     VALUES ($1, $2, $3, 'active', $4)
     RETURNING id, email, api_key, plan, status, usage_count, max_limit, usage_month, nowpayments_subscription_id`,
    [normalized, apiKey, p, maxLimit]
  );
  return ins.rows[0];
}

/**
 * After NOWPayments IPN (payment finished): upgrade plan, store subscription id, issue new api_key when upgrading from free.
 * @returns {Promise<{ user: object, rotatedKey: boolean }>}
 */
export async function finalizeSubscriptionFromIpn(email, plan, nowpaymentsSubscriptionId) {
  if (!pool) throw new Error("Database not configured");
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) throw new Error("Invalid email");
  const p = normalizedPlan(plan);
  const maxLimit = PLAN_MAX_LIMIT[p] ?? PLAN_MAX_LIMIT.free;
  const subId = nowpaymentsSubscriptionId != null && nowpaymentsSubscriptionId !== ""
    ? String(nowpaymentsSubscriptionId)
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT id, email, api_key, plan FROM users WHERE lower(email) = lower($1) FOR UPDATE`,
      [normalized]
    );

    if (!sel.rows[0]) {
      let apiKey = generateLiveApiKey();
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const ins = await client.query(
            `INSERT INTO users (email, api_key, plan, status, max_limit, nowpayments_subscription_id)
             VALUES ($1, $2, $3, 'active', $4, $5)
             RETURNING id, email, api_key, plan, status, usage_count, max_limit, usage_month, nowpayments_subscription_id`,
            [normalized, apiKey, p, maxLimit, subId]
          );
          await client.query("COMMIT");
          return { user: ins.rows[0], rotatedKey: true };
        } catch (e) {
          if (e.code === "23505") {
            apiKey = generateLiveApiKey();
            continue;
          }
          throw e;
        }
      }
      throw new Error("Could not allocate unique api_key");
    }

    const row = sel.rows[0];
    const wasFree = row.plan === "free";
    if (wasFree) {
      let apiKey = generateLiveApiKey();
      let ok = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await client.query(
            `UPDATE users SET plan = $2, max_limit = $3, status = 'active', api_key = $4,
               nowpayments_subscription_id = COALESCE($5, nowpayments_subscription_id)
             WHERE id = $1`,
            [row.id, p, maxLimit, apiKey, subId]
          );
          ok = true;
          break;
        } catch (e) {
          if (e.code === "23505") {
            apiKey = generateLiveApiKey();
            continue;
          }
          throw e;
        }
      }
      if (!ok) throw new Error("Could not rotate api_key");
    } else {
      await client.query(
        `UPDATE users SET plan = $2, max_limit = $3, status = 'active',
           nowpayments_subscription_id = COALESCE($4, nowpayments_subscription_id)
         WHERE id = $1`,
        [row.id, p, maxLimit, subId]
      );
    }

    await client.query("COMMIT");
    const out = await pool.query(
      `SELECT id, email, api_key, plan, status, usage_count, max_limit, usage_month, nowpayments_subscription_id
       FROM users WHERE id = $1`,
      [row.id]
    );
    return { user: out.rows[0], rotatedKey: wasFree };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export function isOverQuota(user) {
  return user.usage_count >= user.max_limit;
}

/**
 * After successful screenshot/PDF: increment usage + insert log (transaction).
 */
export async function recordApiUsage(userId, endpoint, targetUrl, resultPath) {
  if (!pool) throw new Error("Database not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE users SET usage_count = usage_count + 1 WHERE id = $1`, [userId]);
    await client.query(
      `INSERT INTO request_logs (user_id, endpoint, target_url, result_path) VALUES ($1, $2, $3, $4)`,
      [userId, endpoint, targetUrl, resultPath]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email) {
  if (!pool) return null;
  const r = await pool.query(`SELECT id, email FROM users WHERE lower(email) = lower($1)`, [email.trim()]);
  return r.rows[0] || null;
}

export async function saveLoginCode(email, code, ttlMinutes = 10) {
  if (!pool) throw new Error("Database not configured");
  const expires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await pool.query(`DELETE FROM login_codes WHERE email = $1 OR expires_at < now()`, [email.trim()]);
  await pool.query(`INSERT INTO login_codes (email, code, expires_at) VALUES ($1, $2, $3)`, [
    email.trim(),
    code,
    expires,
  ]);
}

export async function consumeLoginCode(email, code) {
  if (!pool) return false;
  const r = await pool.query(
    `DELETE FROM login_codes WHERE email = $1 AND code = $2 AND expires_at > now() RETURNING id`,
    [email.trim(), code.trim()]
  );
  return r.rowCount > 0;
}

/**
 * Replace the user's API key with a new sk-live-* value. Old key stops working immediately.
 * @returns {Promise<{ id: number, email: string, api_key: string, plan: string, usage_count: number, max_limit: number, usage_month: string } | null>}
 */
export async function rotateApiKeyForUserId(userId) {
  if (!pool) return null;
  const id = Number(userId);
  if (!Number.isFinite(id) || id < 1) return null;

  for (let attempt = 0; attempt < 12; attempt++) {
    const apiKey = generateLiveApiKey();
    try {
      const r = await pool.query(
        `UPDATE users SET api_key = $2 WHERE id = $1 AND status = 'active'
         RETURNING id, email, api_key, plan, usage_count, max_limit, usage_month`,
        [id, apiKey]
      );
      return r.rows[0] || null;
    } catch (e) {
      if (e.code === "23505") continue;
      throw e;
    }
  }
  throw new Error("Could not allocate unique api_key");
}

export async function getUserDashboardRow(userId) {
  if (!pool) return null;
  const month = currentUsageMonth();
  const r = await pool.query(
    `SELECT id, email, api_key, plan, usage_count, max_limit, usage_month, nowpayments_subscription_id
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.usage_month !== month) {
    await pool.query(`UPDATE users SET usage_count = 0, usage_month = $1 WHERE id = $2`, [month, userId]);
    row.usage_count = 0;
    row.usage_month = month;
  }
  return row;
}

export async function getRecentLogs(userId, limit = 20) {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT id, endpoint, target_url, result_path, created_at
     FROM request_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

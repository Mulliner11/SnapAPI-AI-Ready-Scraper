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

  pool = new Pool({
    connectionString: url,
    max: 10,
    ssl: sslOption(url),
  });

  await pool.query(`
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
  `);

  console.log("[SnapAPI] PostgreSQL schema ready.");
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
  const r = await pool.query(
    `INSERT INTO users (email, api_key, plan, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email)
     DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, api_key = EXCLUDED.api_key
     RETURNING id, email, api_key, plan, status, usage_count, max_limit, usage_month`,
    [email.trim(), apiKey.trim(), plan, status]
  );
  return r.rows[0];
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

export async function getUserDashboardRow(userId) {
  if (!pool) return null;
  const month = currentUsageMonth();
  const r = await pool.query(
    `SELECT id, email, api_key, plan, usage_count, max_limit, usage_month FROM users WHERE id = $1`,
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

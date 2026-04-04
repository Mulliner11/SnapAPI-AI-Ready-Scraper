import "./polyfills.js";
import "dotenv/config";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { rateLimitRegisterOptions } from "./rateLimitOptions.js";
import session from "@fastify/session";
import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import {
  findUserForApiKey,
  getPool,
  getUserDashboardRow,
  initDb,
  isOverQuota,
  recordScrapeRequest,
  getDashboardInsights,
  rotateApiKeyForUserId,
} from "./db.js";
import { prisma } from "./prismaClient.js";
import { extractReadableMarkdown } from "./scrapeCore.js";
import { loadPageHtml } from "./scrapeLoadPage.js";
import { postPaymentCreateInvoice } from "./paymentCreateInvoice.js";
import { postSubscribeHandler } from "./subscribeInvoice.js";
import { postNowpaymentsWebhook } from "./nowpaymentsWebhook.js";
import { getUserIdFromRequest } from "./authContext.js";
import { getAuthVerify, postAuthPendingRedirect, postAuthSendMagicLink } from "./authMagicLinkApi.js";

/** HMAC for NOWPayments IPN: `nowpaymentsIpn.js` uses `import crypto from "node:crypto"`. */

const SESSION_SECRET_RAW = process.env.SESSION_SECRET || "snapapi-development-session-secret-min-32-chars-long!!";
const SESSION_SECRET =
  SESSION_SECRET_RAW.length >= 32
    ? SESSION_SECRET_RAW
    : SESSION_SECRET_RAW.padEnd(32, "0");
if (!process.env.SESSION_SECRET) {
  console.warn(
    "[SnapAPI] SESSION_SECRET not set in env; using padded development default. Set SESSION_SECRET in production (Railway Variables)."
  );
} else if (process.env.NODE_ENV === "production" && String(process.env.SESSION_SECRET).trim().length < 32) {
  console.error(
    "[SnapAPI] CONFIG: SESSION_SECRET should be at least 32 characters in production. Current value is short — session signing may be weak."
  );
}

const fastify = Fastify({
  logger: true,
  trustProxy: true,
});

fastify.decorateRequest("snapUser", null);

/** Earliest trace: any URL containing `nowpayments` (NP may use trailing slash or proxies rewrite). */
fastify.addHook("onRequest", async (request) => {
  const u = String(request.url || "");
  if (u.toLowerCase().includes("nowpayments")) {
    console.log("!!! RAW REQUEST ARRIVED !!!", request.url);
  }
  if (u.toLowerCase().includes("webhook")) {
    console.log("!!! WEBHOOK HIT AT ONREQUEST LEVEL !!!", request.method, request.url);
  }
});

fastify.setErrorHandler((error, request, reply) => {
  console.error("[SnapAPI error]", request.method, request.url, error);
  console.error("[SnapAPI error] message:", error?.message);
  if (error?.stack) {
    console.error("[SnapAPI error] stack:\n" + error.stack);
  } else {
    console.error("[SnapAPI error] (no stack)", String(error));
  }
  if (error.validation) {
    console.error("[SnapAPI validation]", JSON.stringify(error.validation, null, 2));
  }

  const statusCode =
    typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;

  const message = error.message || "Internal Server Error";
  const payload = { error: message };
  if (error?.code && typeof error.code === "string") {
    payload.code = error.code;
  }
  return reply.status(statusCode).send(payload);
});

const CHROMIUM_LAUNCH_OPTIONS = {
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
};

/** Railway / PaaS set PORT; local default 3000. Reject invalid values. */
function resolveListenPort() {
  const raw = process.env.PORT;
  if (raw == null || String(raw).trim() === "") return 3000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 3000;
}

const PORT = resolveListenPort();
const LISTEN_HOST = process.env.LISTEN_HOST?.trim() || "0.0.0.0";
const gotoTimeoutMs =
  Number(process.env.SCRAPE_GOTO_TIMEOUT_MS || process.env.SCREENSHOT_GOTO_TIMEOUT_MS) || 60_000;
const DEMO_API_KEY = process.env.DEMO_API_KEY || "sk-test-666";

const scrapeBodySchema = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1 },
  },
};

const scrapeResponseSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    markdown: { type: "string" },
    text_content: { type: "string" },
    metadata: {
      type: "object",
      properties: {
        word_count: { type: "integer" },
        estimated_reading_time: { type: "integer" },
        language: { type: "string" },
      },
      required: ["word_count", "estimated_reading_time", "language"],
    },
  },
  required: ["title", "markdown", "text_content", "metadata"],
};

function headerApiKey(request) {
  const raw = request.headers["x-api-key"];
  if (raw == null) return "";
  return Array.isArray(raw) ? raw[0] : raw;
}

function normalizeSourceUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    const err = new Error("url is required");
    err.statusCode = 400;
    throw err;
  }

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      candidate = "https://" + candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    } else {
      candidate = "https://" + candidate;
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    const err = new Error("Invalid url");
    err.statusCode = 400;
    throw err;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    const err = new Error("url must use http or https protocol");
    err.statusCode = 400;
    throw err;
  }

  return parsed.toString();
}

/** Static HTML/JS from project root (`process.cwd()`), matching Railway deploy layout. */
function sendCwdFile(reply, filename, contentType) {
  const full = join(process.cwd(), filename);
  if (!existsSync(full)) {
    return reply
      .code(404)
      .type("text/plain; charset=utf-8")
      .send(`Not found: ${filename}\ncwd=${process.cwd()}`);
  }
  const buf = readFileSync(full);
  return reply.type(contentType).send(buf);
}

async function registerRoutes() {
  fastify.get("/", async (request, reply) => {
    return sendCwdFile(reply, "index.html", "text/html; charset=utf-8");
  });

  fastify.get("/index.html", async (request, reply) => {
    return sendCwdFile(reply, "index.html", "text/html; charset=utf-8");
  });

  fastify.get("/app.js", async (request, reply) => {
    return sendCwdFile(reply, "app.js", "application/javascript; charset=utf-8");
  });

  fastify.get("/paymentConfirmModal.js", async (request, reply) => {
    return sendCwdFile(reply, "paymentConfirmModal.js", "application/javascript; charset=utf-8");
  });

  fastify.get("/login", async (request, reply) => {
    return sendCwdFile(reply, "login.html", "text/html; charset=utf-8");
  });

  fastify.get("/login.html", async (request, reply) => {
    return sendCwdFile(reply, "login.html", "text/html; charset=utf-8");
  });

  fastify.get("/verify", async (request, reply) => {
    return sendCwdFile(reply, "verify.html", "text/html; charset=utf-8");
  });

  fastify.get("/verify.html", async (request, reply) => {
    return sendCwdFile(reply, "verify.html", "text/html; charset=utf-8");
  });

  fastify.get("/dashboard", async (request, reply) => {
    return sendCwdFile(reply, "dashboard.html", "text/html; charset=utf-8");
  });

  fastify.get("/dashboard/mcp", async (request, reply) => {
    return sendCwdFile(reply, "dashboard-mcp.html", "text/html; charset=utf-8");
  });

  fastify.get("/checkout", async (request, reply) => {
    return sendCwdFile(reply, "checkout.html", "text/html; charset=utf-8");
  });

  fastify.get("/checkout.html", async (request, reply) => {
    return sendCwdFile(reply, "checkout.html", "text/html; charset=utf-8");
  });

  fastify.get("/docs", async (request, reply) => {
    return sendCwdFile(reply, "docs.html", "text/html; charset=utf-8");
  });

  fastify.get("/docs.html", async (request, reply) => {
    return sendCwdFile(reply, "docs.html", "text/html; charset=utf-8");
  });

  fastify.get("/privacy", async (request, reply) => {
    return sendCwdFile(reply, "privacy.html", "text/html; charset=utf-8");
  });

  fastify.get("/privacy.html", async (request, reply) => {
    return sendCwdFile(reply, "privacy.html", "text/html; charset=utf-8");
  });

  fastify.get("/terms", async (request, reply) => {
    return sendCwdFile(reply, "terms.html", "text/html; charset=utf-8");
  });

  fastify.get("/terms.html", async (request, reply) => {
    return sendCwdFile(reply, "terms.html", "text/html; charset=utf-8");
  });

  fastify.get("/success", async (request, reply) => {
    return sendCwdFile(reply, "success.html", "text/html; charset=utf-8");
  });

  fastify.post(
    "/api/subscribe",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", minLength: 3 },
            planType: { type: "string", enum: ["pro", "business"] },
            plan_type: { type: "string", enum: ["pro", "business"] },
          },
        },
      },
    },
    postSubscribeHandler
  );

  fastify.post(
    "/api/payment/create-invoice",
    {
      schema: {
        body: {
          type: "object",
          required: ["plan"],
          properties: {
            plan: { type: "string", enum: ["pro", "business"] },
            planType: { type: "string", enum: ["pro", "business"] },
          },
        },
      },
    },
    postPaymentCreateInvoice
  );

  const nowpaymentsIpnOpts = { config: { rawBody: true } };
  fastify.post("/webhooks/nowpayments", nowpaymentsIpnOpts, postNowpaymentsWebhook);
  fastify.post("/webhooks/nowpayments/", nowpaymentsIpnOpts, postNowpaymentsWebhook);
  fastify.post("/api/webhooks/nowpayments", nowpaymentsIpnOpts, postNowpaymentsWebhook);
  fastify.post("/api/webhooks/nowpayments/", nowpaymentsIpnOpts, postNowpaymentsWebhook);

  fastify.post(
    "/api/auth/send-magic-link",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", minLength: 3 } },
        },
      },
    },
    postAuthSendMagicLink
  );

  fastify.get("/api/auth/verify", { logLevel: "silent" }, getAuthVerify);

  fastify.post(
    "/api/auth/pending-redirect",
    {
      schema: {
        body: {
          type: "object",
          required: ["redirect", "plan"],
          properties: {
            redirect: { type: "string", minLength: 1 },
            plan: { type: "string", enum: ["pro", "business"] },
          },
        },
      },
    },
    postAuthPendingRedirect
  );

  /**
   * Current user profile + usage. Requires session cookie or `Authorization: Bearer` JWT.
   * Unauthenticated: 401. No database pool: 503.
   */
  fastify.get("/api/user/me", async (request, reply) => {
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
    reply.header("Pragma", "no-cache");
    const uid = await getUserIdFromRequest(request);
    if (!uid) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const pool = getPool();
    if (!pool) {
      return reply.code(503).send({ error: "Database not configured" });
    }
    const row = await getUserDashboardRow(uid);
    if (!row) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const used = row.usage_count ?? 0;
    const limit = row.max_limit ?? 0;
    return reply.send({
      email: row.email,
      apiKey: row.api_key,
      plan: row.plan,
      usage: { used, limit },
      loggedIn: true,
      api_key: row.api_key,
      usage_count: used,
      max_limit: limit,
    });
  });

  fastify.post("/api/user/rotate-key", async (request, reply) => {
    const pool = getPool();
    if (!pool) {
      return reply.code(503).send({ error: "Database not configured" });
    }
    const uid = await getUserIdFromRequest(request);
    if (!uid) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    try {
      const row = await rotateApiKeyForUserId(uid);
      if (!row) {
        return reply.code(404).send({ error: "User not found" });
      }
      return reply.send({
        ok: true,
        api_key: row.api_key,
        apiKey: row.api_key,
      });
    } catch (err) {
      request.log.error(err, "[user] rotate-key");
      return reply.code(500).send({ error: err?.message || "Could not rotate key" });
    }
  });

  fastify.post("/auth/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  fastify.get("/api/dashboard/summary", async (request, reply) => {
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
    reply.header("Pragma", "no-cache");
    const pool = getPool();
    if (!pool) {
      return reply.code(503).send({ error: "Database not configured" });
    }
    const uid = await getUserIdFromRequest(request);
    if (!uid) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const row = await getUserDashboardRow(uid);
    if (!row) {
      return reply.code(404).send({ error: "User not found" });
    }
    const insights = await getDashboardInsights(uid);
    return reply.send({
      email: row.email,
      api_key: row.api_key,
      plan: row.plan,
      usage_count: row.usage_count,
      max_limit: row.max_limit,
      usage: { used: row.usage_count, limit: row.max_limit },
      insights: insights || {
        successRatePct: null,
        scrapeSamples: 0,
        tokensSavedLast100: 0,
        recentLogs: [],
      },
    });
  });

  fastify.post(
    "/api/scrape",
    {
      schema: {
        body: scrapeBodySchema,
        response: { 200: scrapeResponseSchema },
      },
    },
    async (request, reply) => {
      const user = request.snapUser;
      let sourceUrl = "";
      try {
        sourceUrl = normalizeSourceUrl(request.body.url);
        const html = await loadPageHtml(sourceUrl, {
          launchOptions: CHROMIUM_LAUNCH_OPTIONS,
          gotoTimeoutMs,
        });
        const { title, markdown, text_content, metadata } = extractReadableMarkdown(html, sourceUrl);
        const rawTokensEst = Math.ceil(html.length / 4);
        const cleanTokensEst = Math.ceil(String(markdown || text_content || "").length / 4);

        if (user?.id && getPool()) {
          await recordScrapeRequest(user.id, sourceUrl, 200, { rawTokensEst, cleanTokensEst });
        }

        return reply.send({ title, markdown, text_content, metadata });
      } catch (err) {
        const code = Number(err?.statusCode);
        const st = code >= 400 && code < 600 ? code : 500;
        const logUrl =
          sourceUrl ||
          (typeof request.body?.url === "string" ? String(request.body.url).slice(0, 2000) : "(invalid url)");
        if (user?.id && getPool()) {
          try {
            await recordScrapeRequest(user.id, logUrl, st, null);
          } catch (logErr) {
            request.log.error(logErr, "[scrape] recordScrapeRequest");
          }
        }
        return reply.code(st).send({ error: err?.message || "Scrape failed" });
      }
    }
  );

  fastify.get("/health", async () => ({ ok: true }));
}

function logDatabaseConfig() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    console.warn(
      "[SnapAPI] DATABASE_URL is not set. Link the Railway Postgres plugin to this service (Variables → reference DATABASE_URL)."
    );
    return;
  }
  try {
    const u = new URL(raw.replace(/^postgresql:\/\//i, "http://"));
    console.log(
      `[SnapAPI] DATABASE_URL is set (host=${u.hostname}; Railway internal networking must reach this host).`
    );
  } catch {
    console.log("[SnapAPI] DATABASE_URL is set.");
  }
}

async function start() {
  logDatabaseConfig();
  await initDb();

  try {
    await prisma.$connect();
  } catch (e) {
    console.warn(
      "[SnapAPI] Prisma could not connect (run `npx prisma migrate deploy` and ensure DATABASE_URL). /api/subscribe will fail until fixed:",
      e?.message || e
    );
  }

  if (process.env.NODE_ENV === "production") {
    if (!String(process.env.NP_IPN_SECRET || process.env.NOWPAYMENTS_IPN_SECRET || "").trim()) {
      console.error(
        "[SnapAPI] CONFIG: NP_IPN_SECRET (or NOWPAYMENTS_IPN_SECRET) is missing. Webhook HMAC will return 503 until set. App still starts."
      );
    }
    if (!String(process.env.NP_API_KEY || "").trim()) {
      console.error("Missing API Key: NP_API_KEY");
      console.error(
        "[SnapAPI] NOWPayments invoices require NP_API_KEY (Railway → Variables → NP_API_KEY)."
      );
    }
    const jwtSecret = String(process.env.JWT_SECRET || "").trim();
    if (!jwtSecret || jwtSecret.length < 32) {
      console.warn("[SnapAPI] Set JWT_SECRET (min 32 chars) if you use Bearer JWT with /api/user/me.");
    }
  }

  await fastify.register(cookie);
  await fastify.register(session, {
    secret: SESSION_SECRET,
    cookieName: "snap_session",
    cookie: {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
    },
  });

  try {
    await fastify.register(fastifyRawBody, {
      field: "rawBody",
      global: false,
      encoding: false,
      runFirst: false,
    });
  } catch (e) {
    console.error("[SnapAPI] FATAL: fastify-raw-body failed to register:", e?.message || e);
    throw e;
  }

  await fastify.register(rateLimit, rateLimitRegisterOptions);

  /** Global onRequest: NOWPayments webhook bypasses x-api-key before any other POST logic. */
  fastify.addHook("onRequest", async (request, reply) => {
    const rawUrl = String(request.url || "");
    if (request.method === "POST" && rawUrl.toLowerCase().includes("nowpayments")) {
      return;
    }

    if (request.method === "GET") {
      return;
    }

    const pathname = rawUrl.split("?")[0].split("#")[0];

    const needsApiKey = request.method === "POST" && pathname === "/api/scrape";

    if (needsApiKey) {
      const key = headerApiKey(request);
      if (!key) {
        return reply.code(401).send({ error: "Missing x-api-key header" });
      }

      const pool = getPool();
      if (!pool) {
        if (key !== DEMO_API_KEY) {
          return reply.code(401).send({
            error: "Invalid API key for demo mode. Use sk-test-666 or set DATABASE_URL for real keys.",
          });
        }
        request.snapUser = null;
        return;
      }

      const user = await findUserForApiKey(key);
      if (!user) {
        return reply.code(401).send({ error: "Invalid API key" });
      }
      if (isOverQuota(user)) {
        return reply.code(429).send({ error: "Quota exceeded for current period" });
      }
      request.snapUser = user;
    }
  });

  await registerRoutes();

  try {
    await fastify.listen({ port: PORT, host: LISTEN_HOST });
    fastify.log.info(`Listening on http://${LISTEN_HOST}:${PORT} (set PORT in production)`);
  } catch (err) {
    console.error("[SnapAPI listen failed]", err);
    if (err?.stack) console.error(err.stack);
    fastify.log.error(err);
    process.exit(1);
  }
}

start().catch((err) => {
  console.error("[SnapAPI] Fatal startup error:", err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});

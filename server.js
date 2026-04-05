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
import { getUserPlanPayloadByEmail } from "./userPlanApi.js";
import {
  listRequestLogsForLegacyUserId,
  recordPrismaRequestLogForScrape,
} from "./requestLogsService.js";

/** HMAC for NOWPayments IPN: `nowpaymentsIpn.js` uses `import crypto from "node:crypto"`. */

const MIN_SECRET_LEN = 32;

function requireSecretEnv(name) {
  const v = String(process.env[name] ?? "").trim();
  if (!v) {
    console.error(
      `[SnapAPI] FATAL: ${name} is not set. Set a strong secret (at least ${MIN_SECRET_LEN} characters) in your environment (e.g. Railway Variables). Refusing to start.`
    );
    process.exit(1);
  }
  if (v.length < MIN_SECRET_LEN) {
    console.error(
      `[SnapAPI] FATAL: ${name} must be at least ${MIN_SECRET_LEN} characters. Refusing to start.`
    );
    process.exit(1);
  }
  return v;
}

const SESSION_SECRET = requireSecretEnv("SESSION_SECRET");
requireSecretEnv("JWT_SECRET");

const fastify = Fastify({
  logger: true,
  trustProxy: true,
});

fastify.decorateRequest("snapUser", null);

/** Earliest onRequest: capture any request whose URL mentions nowpayments (any method / casing / proxy path). */
fastify.addHook("onRequest", async (request, _reply) => {
  const url = String(request.url || "");
  if (url.toLowerCase().includes("nowpayments")) {
    console.log("!!! WEBHOOK SIGNAL DETECTED !!!", {
      method: request.method,
      url: request.url,
      headers: request.headers,
    });
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

const NOWPAYMENTS_IPN_OPTS = { config: { rawBody: true } };

/** Must run after `fastify-raw-body` is registered; before global rate-limit and API-key onRequest hooks. */
function registerNowpaymentsWebhookRoutes(instance) {
  instance.post("/webhooks/nowpayments", NOWPAYMENTS_IPN_OPTS, postNowpaymentsWebhook);
  instance.post("/webhooks/nowpayments/", NOWPAYMENTS_IPN_OPTS, postNowpaymentsWebhook);
  instance.post("/api/webhooks/nowpayments", NOWPAYMENTS_IPN_OPTS, postNowpaymentsWebhook);
  instance.post("/api/webhooks/nowpayments/", NOWPAYMENTS_IPN_OPTS, postNowpaymentsWebhook);
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

  fastify.get("/logsPage.js", async (request, reply) => {
    return sendCwdFile(reply, "logsPage.js", "application/javascript; charset=utf-8");
  });

  fastify.get("/billingPage.js", async (request, reply) => {
    return sendCwdFile(reply, "billingPage.js", "application/javascript; charset=utf-8");
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

  fastify.get("/dashboard/logs", async (request, reply) => {
    return sendCwdFile(reply, "dashboard-logs.html", "text/html; charset=utf-8");
  });

  fastify.get("/dashboard/billing", async (request, reply) => {
    return sendCwdFile(reply, "dashboard-billing.html", "text/html; charset=utf-8");
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

  fastify.get("/api/user/plan", async (request, reply) => {
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
    const payload = await getUserPlanPayloadByEmail(row.email, row.plan);
    return reply.send(payload);
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

  fastify.get("/api/dashboard/request-logs", async (request, reply) => {
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
    const logs = await listRequestLogsForLegacyUserId(uid, 20);
    return reply.send({ logs });
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
      const scrapeStarted = Date.now();
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

        const payload = { title, markdown, text_content, metadata };
        const durationMs = Date.now() - scrapeStarted;
        const responseSize = Buffer.byteLength(JSON.stringify(payload), "utf8");
        if (user?.id && getPool()) {
          await recordPrismaRequestLogForScrape(user, {
            url: sourceUrl,
            status: 200,
            durationMs,
            responseSize,
          });
        }

        return reply.send(payload);
      } catch (err) {
        const code = Number(err?.statusCode);
        const st = code >= 400 && code < 600 ? code : 500;
        const logUrl =
          sourceUrl ||
          (typeof request.body?.url === "string" ? String(request.body.url).slice(0, 2000) : "(invalid url)");
        const errBody = { error: err?.message || "Scrape failed" };
        const durationMs = Date.now() - scrapeStarted;
        const responseSize = Buffer.byteLength(JSON.stringify(errBody), "utf8");
        if (user?.id && getPool()) {
          try {
            await recordScrapeRequest(user.id, logUrl, st, null);
          } catch (logErr) {
            request.log.error(logErr, "[scrape] recordScrapeRequest");
          }
          await recordPrismaRequestLogForScrape(user, {
            url: logUrl,
            status: st,
            durationMs,
            responseSize,
          });
        }
        return reply.code(st).send(errBody);
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

  registerNowpaymentsWebhookRoutes(fastify);

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

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("dotenv").config();

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import session from "@fastify/session";
import Fastify from "fastify";
import { chromium } from "playwright";
import {
  findUserForApiKey,
  getPool,
  getRecentLogs,
  getUserDashboardRow,
  initDb,
  isOverQuota,
  recordApiUsage,
  rotateApiKeyForUserId,
} from "./db.js";
import { prisma } from "./prismaClient.js";
import { extractReadableMarkdown } from "./scrapeCore.js";
import { postSubscribeHandler } from "./subscribeInvoice.js";
import { postPaymentCreateInvoice } from "./paymentCreateInvoice.js";
import { postNowpaymentsWebhook } from "./nowpaymentsWebhook.js";
import { getUserIdFromRequest } from "./authContext.js";
import { getAuthVerify, postAuthPendingRedirect, postAuthSendMagicLink } from "./authMagicLinkApi.js";

const SESSION_SECRET_RAW = process.env.SESSION_SECRET || "snapapi-development-session-secret-min-32-chars-long!!";
const SESSION_SECRET =
  SESSION_SECRET_RAW.length >= 32
    ? SESSION_SECRET_RAW
    : SESSION_SECRET_RAW.padEnd(32, "0");
if (!process.env.SESSION_SECRET) {
  console.warn("[SnapAPI] SESSION_SECRET not set; using a development default. Set SESSION_SECRET in production.");
}

const fastify = Fastify({
  logger: true,
  trustProxy: true,
});

fastify.decorateRequest("snapUser", null);

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
  return reply.status(statusCode).send({ error: message });
});

const CHROMIUM_LAUNCH_OPTIONS = {
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
};

const PORT = Number(process.env.PORT) || 3000;
const LISTEN_HOST = "0.0.0.0";
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
  },
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

async function loadPageHtml(sourceUrl) {
  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  try {
    const page = await browser.newPage();
    await page.goto(sourceUrl, { waitUntil: "load", timeout: gotoTimeoutMs });
    return await page.content();
  } finally {
    await browser.close();
  }
}

/** Prefer `public/<filename>` when present, else project root (no @fastify/static). */
function sendCwdFile(reply, filename, contentType) {
  const publicPath = join(process.cwd(), "public", filename);
  const full = existsSync(publicPath) ? publicPath : join(process.cwd(), filename);
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

  fastify.get("/checkout", async (request, reply) => {
    return sendCwdFile(reply, "checkout.html", "text/html; charset=utf-8");
  });

  fastify.get("/checkout.html", async (request, reply) => {
    return sendCwdFile(reply, "checkout.html", "text/html; charset=utf-8");
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
            planType: { type: "string", enum: ["pro", "business", "agency"] },
            plan_type: { type: "string", enum: ["pro", "business", "agency"] },
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
            plan: { type: "string", enum: ["pro", "business", "agency"] },
            planType: { type: "string", enum: ["pro", "business", "agency"] },
          },
        },
      },
    },
    postPaymentCreateInvoice
  );

  // NOWPayments webhook (encapsulated raw-body JSON parser)
  fastify.register(async (instance) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => done(null, body)
    );

    instance.post("/webhooks/nowpayments", postNowpaymentsWebhook);
  });

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
            plan: { type: "string", enum: ["pro", "business", "agency"] },
          },
        },
      },
    },
    postAuthPendingRedirect
  );

  /** Current user: session cookie or Bearer JWT (same pg user as dashboard). */
  fastify.get("/api/user/me", async (request, reply) => {
    const pool = getPool();
    const uid = await getUserIdFromRequest(request);
    if (!uid || !pool) {
      return reply.send({ loggedIn: false });
    }
    const row = await getUserDashboardRow(uid);
    if (!row) {
      return reply.send({ loggedIn: false });
    }
    return reply.send({
      loggedIn: true,
      email: row.email,
      api_key: row.api_key,
      plan: row.plan,
      usage_count: row.usage_count,
      max_limit: row.max_limit,
    });
  });

  /** Session or Bearer JWT. Returns new api_key (old key invalidated). */
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
    const logs = await getRecentLogs(uid, 20);
    return reply.send({
      api_key: row.api_key,
      plan: row.plan,
      usage_count: row.usage_count,
      max_limit: row.max_limit,
      logs,
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
      const sourceUrl = normalizeSourceUrl(request.body.url);
      const html = await loadPageHtml(sourceUrl);
      const { title, markdown, text_content } = extractReadableMarkdown(html, sourceUrl);

      if (user?.id && getPool()) {
        await recordApiUsage(user.id, "scrape", sourceUrl, null);
      }

      return reply.send({ title, markdown, text_content });
    }
  );

  fastify.get("/health", async () => ({ ok: true }));
}

async function start() {
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
    if (!String(process.env.NOWPAYMENTS_IPN_SECRET || "").trim()) {
      console.warn(
        "[SnapAPI] Set NOWPAYMENTS_IPN_SECRET on Railway; without it POST /webhooks/nowpayments will reject signatures (403)."
      );
    }
    if (!String(process.env.NP_API_KEY || "").trim()) {
      console.warn("[SnapAPI] Set NP_API_KEY on Railway for POST /api/subscribe (NOWPayments invoice).");
    }
    if (!String(process.env.JWT_SECRET || "").trim() || String(process.env.JWT_SECRET).trim().length < 32) {
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

  await fastify.register(rateLimit, {
    global: true,
    max: 5,
    timeWindow: "1 minute",
    allowList: (request) => {
      const pathname = (request.url || "").split("?")[0];
      if (pathname === "/health") return true;
      if (pathname === "/api/auth/send-magic-link" && request.method === "POST") return true;
      if (pathname === "/api/auth/verify" && request.method === "GET") return true;
      if (pathname === "/api/auth/pending-redirect" && request.method === "POST") return true;
      if (pathname === "/api/user/rotate-key" && request.method === "POST") return true;
      if (pathname === "/webhooks/nowpayments" && request.method === "POST") return true;
      if (pathname === "/api/subscribe" && request.method === "POST") return true;
      if (pathname === "/api/payment/create-invoice" && request.method === "POST") return true;
      if (pathname === "/checkout") return true;
      if (pathname === "/api/scrape" && request.method === "POST") return true;
      return false;
    },
  });

  fastify.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET") {
      return;
    }

    const pathname = (request.url || "").split("?")[0];

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
    console.log("Files in cwd:", require("fs").readdirSync(process.cwd()));
    await fastify.listen({ port: PORT, host: LISTEN_HOST });
    fastify.log.info(`Server listening on http://0.0.0.0:${PORT} (public URL uses your Railway domain)`);
  } catch (err) {
    console.error("[SnapAPI listen failed]", err);
    if (err?.stack) console.error(err.stack);
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

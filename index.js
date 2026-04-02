import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("dotenv").config();

import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import session from "@fastify/session";
import Fastify from "fastify";
import { chromium } from "playwright";
import {
  consumeLoginCode,
  findUserByEmail,
  findUserForApiKey,
  getPool,
  getRecentLogs,
  getUserDashboardRow,
  initDb,
  isOverQuota,
  recordApiUsage,
  saveLoginCode,
  upsertPaidUserByEmail,
} from "./db.js";
import { createR2Client, loadR2Config, uploadLocalFileAndRemove } from "./r2.js";

const SESSION_SECRET_RAW = process.env.SESSION_SECRET || "snapapi-development-session-secret-min-32-chars-long!!";
const SESSION_SECRET =
  SESSION_SECRET_RAW.length >= 32
    ? SESSION_SECRET_RAW
    : SESSION_SECRET_RAW.padEnd(32, "0");
if (!process.env.SESSION_SECRET) {
  console.warn("[SnapAPI] SESSION_SECRET not set; using a development default. Set SESSION_SECRET in production.");
}

const fastify = Fastify({ logger: true });

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
const gotoTimeoutMs = Number(process.env.SCREENSHOT_GOTO_TIMEOUT_MS) || 60_000;
const DEMO_API_KEY = process.env.DEMO_API_KEY || "sk-test-666";
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || "";

let r2Config;
let s3Client;

try {
  r2Config = loadR2Config();
  s3Client = createR2Client(r2Config);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const successBodySchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    message: { type: "string" },
    path: { type: "string" },
  },
};

const requestBodySchema = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1 },
    fullPage: { type: "boolean" },
    width: { type: "integer", minimum: 320, maximum: 4096 },
    height: { type: "integer", minimum: 240, maximum: 4096 },
  },
};

function tempFilePath(ext) {
  return join(tmpdir(), `screenshot-api-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
}

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

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",")}}`;
}

function verifyNowPaymentsSignature(rawBody, signature) {
  if (!NOWPAYMENTS_IPN_SECRET) return false;
  if (!signature) return false;
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return false;
  }
  const sorted = stableStringify(payload);
  const expected = crypto.createHmac("sha512", NOWPAYMENTS_IPN_SECRET).update(sorted).digest("hex");
  return expected === String(signature).toLowerCase();
}

function extractEmailFromNowPayments(payload) {
  const direct =
    payload?.email ||
    payload?.customer_email ||
    payload?.payer_email ||
    payload?.buyer_email ||
    payload?.order_email;
  if (typeof direct === "string" && direct.includes("@")) return direct.trim();
  const hay = [payload?.order_description, payload?.order_id, payload?.payment_id]
    .filter((x) => typeof x === "string")
    .join(" ");
  const m = hay.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].trim() : "";
}

function planFromNowPayments(payload) {
  const amt = Number(payload?.price_amount ?? payload?.actually_paid ?? payload?.pay_amount);
  if (Number.isFinite(amt)) {
    if (Math.abs(amt - 99) < 0.01) return "business";
    if (Math.abs(amt - 29) < 0.01) return "pro";
  }
  return "pro";
}

function generateLiveApiKey() {
  return `sk-live-${crypto.randomBytes(18).toString("hex")}`;
}

/** @param {{ width: number; height: number } | null} viewport */
async function withPage(sourceUrl, viewport, fn) {
  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  try {
    const page = await browser.newPage();
    if (viewport && viewport.width != null && viewport.height != null) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    }
    await page.goto(sourceUrl, { waitUntil: "load", timeout: gotoTimeoutMs });
    await fn(page);
  } finally {
    await browser.close();
  }
}

function viewportFromBody(body) {
  const w = body.width;
  const h = body.height;
  if (w == null && h == null) return null;
  if (w == null || h == null) {
    return null;
  }
  return { width: w, height: h };
}

/** Read a file from process.cwd() and send, or 404 with plain text (no @fastify/static). */
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

  fastify.get("/login", async (request, reply) => {
    return sendCwdFile(reply, "login.html", "text/html; charset=utf-8");
  });

  fastify.get("/login.html", async (request, reply) => {
    return sendCwdFile(reply, "login.html", "text/html; charset=utf-8");
  });

  fastify.get("/dashboard", async (request, reply) => {
    if (!request.session?.userId) {
      return reply.redirect(302, "/login");
    }
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

  // NOWPayments webhook (encapsulated raw-body JSON parser)
  fastify.register(async (instance) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => done(null, body)
    );

    instance.post("/webhooks/nowpayments", async (request, reply) => {
      const rawBody = request.body;
      const sig = request.headers["x-nowpayments-sig"] || request.headers["X-NOWPAYMENTS-SIG"];
      if (!verifyNowPaymentsSignature(rawBody, sig)) {
        return reply.code(401).send({ error: "Invalid signature" });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }

      const status = String(payload?.payment_status || "").toLowerCase();
      if (status !== "finished") {
        return reply.send({ ok: true });
      }

      const pool = getPool();
      if (!pool) {
        return reply.code(503).send({ error: "Database not configured" });
      }

      const email = extractEmailFromNowPayments(payload);
      if (!email) {
        return reply.code(400).send({ error: "Missing email in order payload" });
      }

      const plan = planFromNowPayments(payload);
      // best-effort collision avoidance via retry
      let user;
      for (let i = 0; i < 5; i++) {
        const apiKey = generateLiveApiKey();
        try {
          user = await upsertPaidUserByEmail(email, plan, apiKey, "active");
          break;
        } catch (e) {
          if (String(e?.message || "").includes("duplicate") || e?.code === "23505") continue;
          throw e;
        }
      }
      if (!user) {
        return reply.code(500).send({ error: "Failed to provision user" });
      }

      return reply.send({ ok: true, email: user.email, plan: user.plan });
    });
  });

  fastify.post(
    "/auth/request-code",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", minLength: 3 } },
        },
      },
    },
    async (request, reply) => {
      const pool = getPool();
      if (!pool) {
        return reply.code(503).send({ error: "Database not configured (DATABASE_URL)" });
      }
      const { email } = request.body;
      const user = await findUserByEmail(email);
      if (!user) {
        return reply.code(404).send({ error: "Email not registered" });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await saveLoginCode(email, code, 10);
      console.log(`[SnapAPI login code] ${email.trim()} -> ${code} (expires in 10 min, MVP: check Railway logs)`);
      return reply.send({
        message: "Verification code issued. In MVP, check server logs for the code.",
      });
    }
  );

  fastify.post(
    "/auth/verify-code",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "code"],
          properties: {
            email: { type: "string" },
            code: { type: "string", minLength: 4, maxLength: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const pool = getPool();
      if (!pool) {
        return reply.code(503).send({ error: "Database not configured" });
      }
      const { email, code } = request.body;
      const ok = await consumeLoginCode(email, code);
      if (!ok) {
        return reply.code(401).send({ error: "Invalid or expired code" });
      }
      const user = await findUserByEmail(email);
      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }
      request.session.userId = user.id;
      return reply.send({ ok: true });
    }
  );

  fastify.post("/auth/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  fastify.get("/api/dashboard/summary", async (request, reply) => {
    const pool = getPool();
    if (!pool) {
      return reply.code(503).send({ error: "Database not configured" });
    }
    const uid = request.session?.userId;
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
    "/screenshot",
    {
      schema: {
        body: requestBodySchema,
        response: { 200: successBodySchema },
      },
    },
    async (request, reply) => {
      const user = request.snapUser;
      const { fullPage } = request.body;
      const sourceUrl = normalizeSourceUrl(request.body.url);
      const viewport = viewportFromBody(request.body);
      const useFullPage = fullPage !== false;
      const localPath = tempFilePath("png");
      const objectName = `screenshot-${Date.now()}.png`;

      await withPage(sourceUrl, viewport, async (page) => {
        await page.screenshot({ path: localPath, fullPage: useFullPage });
      });

      const url = await uploadLocalFileAndRemove(s3Client, r2Config, {
        localPath,
        objectName,
        contentType: "image/png",
      });

      if (user?.id && getPool()) {
        await recordApiUsage(user.id, "screenshot", sourceUrl, url);
      }

      return reply.send({
        status: "success",
        message: "Screenshot saved",
        path: url,
      });
    }
  );

  fastify.post(
    "/pdf",
    {
      schema: {
        body: requestBodySchema,
        response: { 200: successBodySchema },
      },
    },
    async (request, reply) => {
      const user = request.snapUser;
      const sourceUrl = normalizeSourceUrl(request.body.url);
      const viewport = viewportFromBody(request.body);
      const localPath = tempFilePath("pdf");
      const objectName = `export-${Date.now()}.pdf`;

      await withPage(sourceUrl, viewport, async (page) => {
        let pdfW;
        let pdfH;
        if (viewport) {
          pdfW = `${viewport.width}px`;
          pdfH = `${viewport.height}px`;
        } else {
          const width = await page.evaluate(() => document.documentElement.scrollWidth);
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          pdfW = `${width}px`;
          pdfH = `${height}px`;
        }
        await page.pdf({
          path: localPath,
          width: pdfW,
          height: pdfH,
          printBackground: true,
          margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
        });
      });

      const url = await uploadLocalFileAndRemove(s3Client, r2Config, {
        localPath,
        objectName,
        contentType: "application/pdf",
      });

      if (user?.id && getPool()) {
        await recordApiUsage(user.id, "pdf", sourceUrl, url);
      }

      return reply.send({
        status: "success",
        message: "PDF saved",
        path: url,
      });
    }
  );

  fastify.get("/health", async () => ({ ok: true }));
}

async function start() {
  await initDb();

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
      return pathname === "/health";
    },
  });

  fastify.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET") {
      return;
    }

    const pathname = (request.url || "").split("?")[0];

    const needsApiKey =
      request.method === "POST" && (pathname === "/screenshot" || pathname === "/pdf");

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
    console.log("当前目录下的文件清单:", require("fs").readdirSync(process.cwd()));
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

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
  consumeMagicLoginToken,
  createMagicLoginToken,
  ensureUserByEmail,
  finalizeSubscriptionFromIpn,
  findUserForApiKey,
  getPool,
  getRecentLogs,
  getUserDashboardRow,
  initDb,
  isOverQuota,
  recordApiUsage,
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
const gotoTimeoutMs = Number(process.env.SCREENSHOT_GOTO_TIMEOUT_MS) || 60_000;
const DEMO_API_KEY = process.env.DEMO_API_KEY || "sk-test-666";
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || "";
/** NOWPayments subscription / payment API (create checkout links) */
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY?.trim() || "";
const NOWPAYMENTS_PRO_PLAN_ID = process.env.NOWPAYMENTS_PRO_PLAN_ID || "1609279275";
const NOWPAYMENTS_BUSINESS_PLAN_ID = process.env.NOWPAYMENTS_BUSINESS_PLAN_ID || "404010249";
/** Resend: API key required to send; `from` overridable via env */
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim() || "";
const RESEND_FROM = process.env.RESEND_FROM?.trim() || "SnapAPI <support@getsnapapi.uk>";

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
  const directFields = [
    payload?.subscription_email,
    payload?.email,
    payload?.customer_email,
    payload?.payer_email,
    payload?.buyer_email,
    payload?.order_email,
  ];
  for (const v of directFields) {
    if (typeof v === "string" && v.includes("@")) return v.trim().toLowerCase();
  }
  const payAddr = payload?.pay_address;
  if (typeof payAddr === "string" && payAddr.includes("@")) {
    return payAddr.trim().toLowerCase();
  }
  const orderId = payload?.order_id;
  if (typeof orderId === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(orderId.trim())) {
    return orderId.trim().toLowerCase();
  }
  const hay = [
    payload?.order_description,
    payload?.order_id,
    payload?.payment_id,
    typeof payAddr === "string" ? payAddr : "",
  ]
    .filter((x) => typeof x === "string")
    .join(" ");
  const m = hay.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].trim().toLowerCase() : "";
}

function planFromNowPayments(payload) {
  const amt = Number(payload?.price_amount ?? payload?.actually_paid ?? payload?.pay_amount);
  if (Number.isFinite(amt)) {
    if (Math.abs(amt - 99) < 0.01) return "business";
    if (Math.abs(amt - 29) < 0.01) return "pro";
  }
  return "pro";
}

function planTierFromNowPaymentsPayload(payload) {
  const pid = String(payload?.subscription_plan_id ?? payload?.plan_id ?? "").trim();
  if (pid && pid === String(NOWPAYMENTS_BUSINESS_PLAN_ID)) return "business";
  if (pid && pid === String(NOWPAYMENTS_PRO_PLAN_ID)) return "pro";
  return planFromNowPayments(payload);
}

function extractNowPaymentsSubscriptionId(payload) {
  const v = payload?.subscription_id ?? payload?.subscriptionId ?? payload?.subscriber_id;
  if (v != null && String(v).trim() !== "") return String(v).trim();
  return null;
}

function pickNowPaymentsCheckoutUrl(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.payment_url,
    obj.pay_url,
    obj.invoice_url,
    obj.payment_link,
    obj.paymentUrl,
    obj.url,
    obj.result?.payment_url,
    obj.data?.payment_url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
  }
  return null;
}

async function createNowPaymentsSubscription({ email, planType }) {
  if (!NOWPAYMENTS_API_KEY) {
    const err = new Error("NOWPayments API is not configured");
    err.statusCode = 503;
    throw err;
  }
  const planId = planType === "business" ? NOWPAYMENTS_BUSINESS_PLAN_ID : NOWPAYMENTS_PRO_PLAN_ID;
  const subscriptionEmail = String(email || "").trim();
  const numPlanId = Number(planId);
  const body = {
    subscription_plan_id: Number.isFinite(numPlanId) ? numPlanId : planId,
    subscription_email: subscriptionEmail,
    email: subscriptionEmail,
  };
  const res = await fetch("https://api.nowpayments.io/v1/subscriptions", {
    method: "POST",
    headers: {
      "x-api-key": NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(`NOWPayments returned non-JSON: ${text.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok) {
    const msg = data.message || data.error || `NOWPayments HTTP ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.statusCode = 502;
    throw err;
  }
  const paymentUrl = pickNowPaymentsCheckoutUrl(data);
  if (!paymentUrl) {
    const err = new Error("NOWPayments response did not include a payment URL");
    err.statusCode = 502;
    throw err;
  }
  return { payment_url: paymentUrl, raw: data };
}

function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

async function sendSubscriptionWelcomeEmail(to, apiKey, plan) {
  if (!RESEND_API_KEY) {
    console.warn(`[SnapAPI] RESEND_API_KEY not set; skipping welcome email to ${to}`);
    return;
  }
  const safeKey = escapeHtmlText(apiKey);
  const safePlan = escapeHtmlText(plan);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to.trim()],
      subject: "Your SnapAPI subscription is active",
      html: `<p>Thanks for subscribing to SnapAPI.</p>
        <p>Plan: <strong>${safePlan}</strong></p>
        <p>Your API key (store it securely):</p>
        <pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;word-break:break-all;">${safeKey}</pre>
        <p><a href="${escapeHtmlText(
          (process.env.PUBLIC_APP_URL || "https://getsnapapi.uk").replace(/\/$/, "")
        )}/dashboard">Open your dashboard</a></p>`,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Resend welcome email failed: ${res.status} ${t}`);
  }
}

function publicAppBaseUrl(request) {
  const env = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (env) return env;
  const host = request.headers["x-forwarded-host"] || request.headers.host || `localhost:${PORT}`;
  const proto = (request.headers["x-forwarded-proto"] || request.protocol || "http").split(",")[0].trim();
  return `${proto}://${host}`;
}

async function sendMagicLinkEmail(to, magicLink) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to.trim()],
      subject: "Sign in to SnapAPI",
      html: `<p>Click the link below to sign in to SnapAPI (expires in 15 minutes):</p><p><a href="${magicLink}">Sign in</a></p><p>If you did not request this, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend failed: ${res.status} ${text}`);
  }
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

  fastify.post(
    "/api/subscribe",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "plan_type"],
          properties: {
            email: { type: "string", minLength: 3 },
            plan_type: { type: "string", enum: ["pro", "business"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!NOWPAYMENTS_API_KEY) {
        return reply.code(503).send({ error: "NOWPayments API is not configured (NOWPAYMENTS_API_KEY)" });
      }
      const email = String(request.body.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.code(400).send({ error: "Invalid email" });
      }
      const planType = String(request.body.plan_type || "").toLowerCase();
      try {
        const { payment_url: paymentUrl } = await createNowPaymentsSubscription({ email, planType });
        return reply.send({ payment_url: paymentUrl });
      } catch (e) {
        request.log.error(e, "[NOWPayments] POST /api/subscribe failed");
        const code = typeof e.statusCode === "number" ? e.statusCode : 502;
        return reply.code(code).send({ error: e.message || "NOWPayments request failed" });
      }
    }
  );

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
        request.log.warn(
          { keys: Object.keys(payload || {}) },
          "[NOWPayments] finished payment but could not resolve customer email (set order_description or standard email fields)"
        );
        return reply.code(400).send({ error: "Could not resolve user email from IPN payload" });
      }

      const plan = planTierFromNowPaymentsPayload(payload);
      const subId = extractNowPaymentsSubscriptionId(payload);
      let result;
      try {
        result = await finalizeSubscriptionFromIpn(email, plan, subId);
      } catch (e) {
        request.log.error(e, "[NOWPayments] finalizeSubscriptionFromIpn failed");
        return reply.code(500).send({ error: "Failed to update subscription" });
      }

      const { user, rotatedKey } = result;
      if (rotatedKey) {
        try {
          await sendSubscriptionWelcomeEmail(user.email, user.api_key, user.plan);
        } catch (e) {
          request.log.error(e, "[NOWPayments] welcome email failed (subscription still saved)");
        }
      }

      return reply.send({ ok: true, email: user.email, plan: user.plan });
    });
  });

  /** Magic link: email contains one-time token; callback sets session cookie */
  fastify.post(
    "/auth/login",
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
      const email = String(request.body.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.code(400).send({ error: "Invalid email" });
      }
      const token = await createMagicLoginToken(email);
      if (!token) {
        return reply.code(500).send({ error: "Could not create login token" });
      }
      const base = publicAppBaseUrl(request);
      const magicLink = `${base}/auth/callback?token=${encodeURIComponent(token)}`;

      if (!RESEND_API_KEY) {
        if (process.env.NODE_ENV === "production") {
          return reply.code(503).send({ error: "Email delivery not configured (RESEND_API_KEY)" });
        }
        request.log.warn({ magicLink }, "[SnapAPI] Magic link (dev, RESEND_API_KEY unset)");
        return reply.send({
          ok: true,
          message: "Development: open the magic link below or set RESEND_API_KEY.",
          dev: true,
          magicLink,
        });
      }

      try {
        await sendMagicLinkEmail(email, magicLink);
      } catch (err) {
        console.error("[SnapAPI] Resend failed:", err?.message || err);
        return reply.code(502).send({ error: "Failed to send login email. Try again later." });
      }
      return reply.send({ ok: true, message: "Check your email for the login link." });
    }
  );

  fastify.get("/auth/callback", async (request, reply) => {
    const pool = getPool();
    const raw = request.query?.token;
    const token = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
    if (!token) {
      return reply.redirect(302, "/login?error=missing_token");
    }
    if (!pool) {
      return reply.redirect(302, "/login?error=no_db");
    }
    const email = await consumeMagicLoginToken(token);
    if (!email) {
      return reply.redirect(302, "/login?error=invalid_or_expired");
    }
    const user = await ensureUserByEmail(email);
    if (!user) {
      return reply.redirect(302, "/login?error=user");
    }
    request.session.userId = user.id;
    return reply.redirect(302, "/dashboard");
  });

  /** Current user: API key + usage (session cookie from @fastify/session) */
  fastify.get("/api/user/me", async (request, reply) => {
    const pool = getPool();
    const uid = request.session?.userId;
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

  if (process.env.NODE_ENV === "production") {
    if (!String(process.env.NOWPAYMENTS_IPN_SECRET || "").trim()) {
      console.warn(
        "[SnapAPI] Set NOWPAYMENTS_IPN_SECRET on Railway (from NOWPayments dashboard); without it POST /webhooks/nowpayments returns 401."
      );
    }
    if (!String(process.env.NOWPAYMENTS_API_KEY || "").trim()) {
      console.warn("[SnapAPI] Set NOWPAYMENTS_API_KEY on Railway for POST /api/subscribe checkout links.");
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
      if (pathname === "/auth/login" && request.method === "POST") return true;
      if (pathname === "/webhooks/nowpayments" && request.method === "POST") return true;
      if (pathname === "/api/subscribe" && request.method === "POST") return true;
      return false;
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

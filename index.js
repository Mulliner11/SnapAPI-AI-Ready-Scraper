import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("dotenv").config();

import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import session from "@fastify/session";
import fastifyStatic from "@fastify/static";
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
} from "./db.js";
import { createR2Client, loadR2Config, uploadLocalFileAndRemove } from "./r2.js";

/** HTML/JS/CSS and sendFile root: project working directory (Railway cwd = repo root) */
const PUBLIC_DIR = process.cwd();

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

async function registerRoutes() {
  fastify.get("/", async (request, reply) => {
    return reply.sendFile("index.html");
  });

  fastify.get("/login", async (request, reply) => {
    return reply.sendFile("login.html");
  });

  fastify.get("/dashboard", async (request, reply) => {
    if (!request.session?.userId) {
      return reply.redirect(302, "/login");
    }
    return reply.sendFile("dashboard.html");
  });

  fastify.get("/docs", async (request, reply) => {
    return reply.sendFile("docs.html");
  });

  fastify.get("/privacy", async (request, reply) => {
    return reply.sendFile("privacy.html");
  });

  fastify.get("/terms", async (request, reply) => {
    return reply.sendFile("terms.html");
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
      const { url: sourceUrl, fullPage } = request.body;
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

      await recordApiUsage(user.id, "screenshot", sourceUrl, url);

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
      const { url: sourceUrl } = request.body;
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

      await recordApiUsage(user.id, "pdf", sourceUrl, url);

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
    const pathname = (request.url || "").split("?")[0];

    const isPublicPath =
      pathname === "/" ||
      pathname === "/index.html" ||
      pathname === "/health" ||
      pathname === "/docs" ||
      pathname === "/docs.html" ||
      pathname === "/privacy" ||
      pathname === "/privacy.html" ||
      pathname === "/terms" ||
      pathname === "/terms.html" ||
      pathname === "/login" ||
      pathname === "/login.html" ||
      pathname === "/dashboard" ||
      /\.(js|css|png|jpg|svg)$/i.test(pathname) ||
      pathname === "/auth/request-code" ||
      pathname === "/auth/verify-code" ||
      pathname === "/auth/logout";

    if (isPublicPath) {
      return;
    }

    const needsApiKey =
      request.method === "POST" && (pathname === "/screenshot" || pathname === "/pdf");

    if (needsApiKey) {
      const pool = getPool();
      if (!pool) {
        return reply.code(503).send({ error: "Database not configured (set DATABASE_URL)" });
      }
      const key = headerApiKey(request);
      if (!key) {
        return reply.code(401).send({ error: "Missing x-api-key header" });
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

  await fastify.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: "/",
    index: false,
    allowedPath: (pathname) => {
      const p = pathname.split("?")[0];
      if (
        /^\/(app\.js|index\.html|login\.html|dashboard\.html|docs\.html|privacy\.html|terms\.html)$/.test(p)
      ) {
        return true;
      }
      return /\.(css|png|jpg|jpeg|gif|svg|webp|ico)$/i.test(p);
    },
  });

  try {
    fastify.log.info({ PUBLIC_DIR }, "Static public directory resolved");
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

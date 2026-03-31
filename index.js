import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("dotenv").config();

import { timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { chromium } from "playwright";
import { createR2Client, loadR2Config, uploadLocalFileAndRemove } from "./r2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const MASTER_API_KEY = process.env.MASTER_API_KEY;
if (!MASTER_API_KEY || MASTER_API_KEY.length === 0) {
  console.error("MASTER_API_KEY environment variable is required");
  process.exit(1);
}

const MASTER_KEY_BUF = Buffer.from(MASTER_API_KEY, "utf8");

const fastify = Fastify({ logger: true });

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
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

function apiKeyAuthorized(provided) {
  if (typeof provided !== "string") return false;
  const buf = Buffer.from(provided, "utf8");
  if (buf.length !== MASTER_KEY_BUF.length) return false;
  return timingSafeEqual(buf, MASTER_KEY_BUF);
}

async function withPage(sourceUrl, fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(sourceUrl, { waitUntil: "load", timeout: gotoTimeoutMs });
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function registerRoutes() {
  fastify.post(
    "/screenshot",
    {
      schema: {
        body: requestBodySchema,
        response: { 200: successBodySchema },
      },
    },
    async (request, reply) => {
      const { url: sourceUrl } = request.body;
      const localPath = tempFilePath("png");
      const objectName = `screenshot-${Date.now()}.png`;

      await withPage(sourceUrl, async (page) => {
        await page.screenshot({ path: localPath, fullPage: true });
      });

      const url = await uploadLocalFileAndRemove(s3Client, r2Config, {
        localPath,
        objectName,
        contentType: "image/png",
      });

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
      const { url: sourceUrl } = request.body;
      const localPath = tempFilePath("pdf");
      const objectName = `export-${Date.now()}.pdf`;

      await withPage(sourceUrl, async (page) => {
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.pdf({
          path: localPath,
          width: `${width}px`,
          height: `${height}px`,
          printBackground: true,
          margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
        });
      });

      const url = await uploadLocalFileAndRemove(s3Client, r2Config, {
        localPath,
        objectName,
        contentType: "application/pdf",
      });

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
  await fastify.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: "/",
    index: ["index.html"],
  });

  await fastify.register(rateLimit, {
    global: true,
    max: 5,
    timeWindow: "1 minute",
    // Railway healthcheck can hit this route frequently; exclude it from rate limiting.
    allowList: (request) => {
      const pathname = (request.url || "").split("?")[0];
      return pathname === "/health";
    },
  });

  fastify.addHook("onRequest", async (request, reply) => {
    const pathname = (request.url || "").split("?")[0];

    // 第一优先级：放行首页、健康检查和静态资源
    const isPublicPath =
      pathname === "/" ||
      pathname === "/index.html" ||
      pathname === "/health" ||
      /\.(js|css|png|jpg|svg)$/i.test(pathname);

    if (isPublicPath) {
      return;
    }

    // 只有 /screenshot 与 /pdf 的 POST 请求才需要 API Key
    const needsApiKey =
      request.method === "POST" &&
      (pathname === "/screenshot" || pathname === "/pdf");

    if (needsApiKey && !apiKeyAuthorized(headerApiKey(request))) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await registerRoutes();

  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

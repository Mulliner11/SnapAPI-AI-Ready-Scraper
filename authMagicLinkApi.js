/**
 * Magic-link auth. Requires:
 * - DATABASE_URL (Prisma) — Railway: link Postgres and set variable.
 * - RESEND_API_KEY for production email (optional in dev). `from` is fixed to verified domain.
 * Prisma client is singleton in ./prismaClient.js; Resend uses fetch (no SDK instance).
 */
import crypto from "node:crypto";
import { prisma } from "./prismaClient.js";
import { ensureUserByEmail } from "./db.js";

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
/** Must match a sender verified in Resend (domain getsnapapi.uk). Do not use env override here — avoids 422 Invalid `from`. */
const RESEND_FROM = "SnapAPI <support@getsnapapi.uk>";
/**
 * Base URL for magic-link emails; final link is `${base}?token=...`.
 * Default hits GET /api/auth/verify (same as backend). Override with MAGIC_LINK_PUBLIC_VERIFY_URL if needed.
 */
function defaultMagicLinkBase() {
  const app = String(process.env.PUBLIC_APP_URL || "https://getsnapapi.uk").replace(/\/$/, "");
  return `${app}/api/auth/verify`;
}
const MAGIC_LINK_PUBLIC_VERIFY_URL =
  String(process.env.MAGIC_LINK_PUBLIC_VERIFY_URL || "").replace(/\/$/, "") || defaultMagicLinkBase();

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MIN_PLAIN_TOKEN_LEN = 32;

function normalizeEmail(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function hashToken(plain) {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

/** Cryptographically strong opaque token (never store plain text in DB). */
function generatePlainToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function parseQueryToken(raw) {
  const v = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  return String(v || "").trim();
}

async function sendMagicLinkEmail(to, linkUrl) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: "Sign in to SnapAPI",
      html: `<p>Click the link below to sign in (valid for 10 minutes, one-time use):</p><p><a href="${linkUrl}">Sign in to SnapAPI</a></p><p>If you did not request this, ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`Resend failed: ${res.status} ${t}`);
    console.error("[auth] Resend HTTP error", res.status, t);
    throw err;
  }
}

/**
 * POST /api/auth/send-magic-link — store hashed token, email via Resend (link → public /verify?token=…).
 */
export async function postAuthSendMagicLink(request, reply) {
  let tokenHashForCleanup = null;
  try {
    const email = normalizeEmail(request.body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: "Invalid email" });
    }

    // Upsert Prisma User (app_users); requires valid DATABASE_URL and migrated schema.
    await prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });

    const plain = generatePlainToken();
    const tokenHash = hashToken(plain);
    tokenHashForCleanup = tokenHash;
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await prisma.authToken.deleteMany({ where: { email } });
    await prisma.authToken.create({
      data: { email, tokenHash, expiresAt },
    });

    const linkUrl = `${MAGIC_LINK_PUBLIC_VERIFY_URL}?token=${encodeURIComponent(plain)}`;

    if (!RESEND_API_KEY) {
      if (process.env.NODE_ENV === "production") {
        await prisma.authToken.deleteMany({ where: { tokenHash } }).catch(() => {});
        return reply.code(503).send({ error: "Email is not configured" });
      }
      return reply.send({
        ok: true,
        message: "Development only: RESEND_API_KEY not set; use the link in this response.",
        dev: true,
        magicLink: linkUrl,
      });
    }

    await sendMagicLinkEmail(email, linkUrl);
    return reply.send({ ok: true, message: "If an account can use this email, a sign-in link has been sent." });
  } catch (err) {
    console.error("Login Error:", err);
    if (err?.stack) console.error(err.stack);
    request.log.error(err, "[auth] postAuthSendMagicLink");
    if (tokenHashForCleanup) {
      await prisma.authToken.deleteMany({ where: { tokenHash: tokenHashForCleanup } }).catch(() => {});
    }
    return reply.code(500).send({
      error: err?.message || String(err),
      stack: err?.stack,
    });
  }
}

/**
 * GET /api/auth/verify?token=… — one-time validate, destroy row, set HttpOnly session, redirect /dashboard.
 */
export async function getAuthVerify(request, reply) {
  const raw = parseQueryToken(request.query?.token);
  if (raw.length < MIN_PLAIN_TOKEN_LEN) {
    return reply.redirect("/login?error=invalid_token");
  }

  const tokenHash = hashToken(raw);

  let row;
  try {
    row = await prisma.authToken.findUnique({ where: { tokenHash } });
  } catch (e) {
    console.error("[auth] auth token lookup failed:", e);
    request.log.error(e, "[auth] auth token lookup failed");
    return reply.redirect("/login?error=server");
  }

  if (!row || row.expiresAt.getTime() < Date.now()) {
    return reply.redirect("/login?error=invalid_or_expired");
  }

  try {
    await prisma.authToken.delete({ where: { id: row.id } });
  } catch (e) {
    console.error("[auth] failed to delete auth token:", e);
    request.log.error(e, "[auth] failed to delete auth token");
    return reply.redirect("/login?error=server");
  }

  const user = await ensureUserByEmail(row.email);
  if (!user) {
    return reply.redirect("/login?error=user");
  }

  request.session.userId = user.id;

  const pendingPath = request.session.postLoginRedirect;
  const pendingPlan = request.session.postLoginPlan;
  delete request.session.postLoginRedirect;
  delete request.session.postLoginPlan;

  if (pendingPath === "/checkout" && (pendingPlan === "pro" || pendingPlan === "business")) {
    return reply.redirect(`/checkout?plan=${pendingPlan}`);
  }

  return reply.redirect("/dashboard");
}

const ALLOWED_POST_LOGIN_PATH = "/checkout";

/**
 * Store where to send the user after magic-link verify (same browser session).
 * Only `/checkout` is allowed to avoid open redirects.
 */
export async function postAuthPendingRedirect(request, reply) {
  const redirect = String(request.body?.redirect ?? "").trim();
  const planRaw = String(request.body?.plan ?? "").trim().toLowerCase();
  const plan = planRaw === "business" ? "business" : planRaw === "pro" ? "pro" : null;

  if (redirect !== ALLOWED_POST_LOGIN_PATH || !plan) {
    return reply.code(400).send({ error: "Invalid redirect or plan" });
  }

  request.session.postLoginRedirect = redirect;
  request.session.postLoginPlan = plan;
  return reply.send({ ok: true });
}

// Backwards-compat exports for older entrypoints (index.js) that still import
// `postAuthSendLink` / `postAuthVerify` from this module.
export { postAuthSendMagicLink as postAuthSendLink, getAuthVerify as postAuthVerify };

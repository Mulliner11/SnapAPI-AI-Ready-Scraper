import crypto from "node:crypto";
import { prisma } from "./prismaClient.js";
import { ensureUserByEmail } from "./db.js";

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = String(process.env.RESEND_FROM || "").trim() || "SnapAPI <support@getsnapapi.uk";
/** Browser URL for /verify page (email link); query `token` is appended server-side. */
const MAGIC_LINK_PUBLIC_VERIFY_URL =
  String(process.env.MAGIC_LINK_PUBLIC_VERIFY_URL || "").replace(/\/$/, "") || "https://getsnapapi.uk/verify";

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
  const email = normalizeEmail(request.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply.code(400).send({ error: "Invalid email" });
  }

  // Upsert Prisma User (app_users): first-time sign-in creates an account with default apiKey,
  // existing users are loaded as-is. This covers both new registration and returning login.
  try {
    await prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });
  } catch (e) {
    console.error("[auth] prisma.user.upsert failed:", e);
    request.log.error(e, "[auth] prisma.user.upsert failed");
    return reply.code(500).send({ error: "Could not create or load user" });
  }

  const plain = generatePlainToken();
  const tokenHash = hashToken(plain);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  // Only Prisma `AuthToken` → table `auth_tokens` (no Prisma User row here; pg `users` is created on verify).
  try {
    await prisma.authToken.deleteMany({ where: { email } });
    await prisma.authToken.create({
      data: { email, tokenHash, expiresAt },
    });
  } catch (e) {
    console.error("[auth] failed to store auth token:", e);
    request.log.error(e, "[auth] failed to store auth token");
    return reply.code(500).send({ error: "Could not create sign-in token" });
  }

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

  try {
    await sendMagicLinkEmail(email, linkUrl);
  } catch (e) {
    console.error("[auth] Resend send failed:", e);
    request.log.error(e, "[auth] Resend send failed");
    await prisma.authToken.deleteMany({ where: { tokenHash } }).catch(() => {});
    return reply.code(502).send({ error: "Failed to send email" });
  }

  return reply.send({ ok: true, message: "If an account can use this email, a sign-in link has been sent." });
}

/**
 * GET /api/auth/verify?token=… — one-time validate, destroy row, set HttpOnly session, redirect /dashboard.
 */
export async function getAuthVerify(request, reply) {
  const raw = parseQueryToken(request.query?.token);
  if (raw.length < MIN_PLAIN_TOKEN_LEN) {
    return reply.redirect(302, "/login?error=invalid_token");
  }

  const tokenHash = hashToken(raw);

  let row;
  try {
    row = await prisma.authToken.findUnique({ where: { tokenHash } });
  } catch (e) {
    console.error("[auth] auth token lookup failed:", e);
    request.log.error(e, "[auth] auth token lookup failed");
    return reply.redirect(302, "/login?error=server");
  }

  if (!row || row.expiresAt.getTime() < Date.now()) {
    return reply.redirect(302, "/login?error=invalid_or_expired");
  }

  try {
    await prisma.authToken.delete({ where: { id: row.id } });
  } catch (e) {
    console.error("[auth] failed to delete auth token:", e);
    request.log.error(e, "[auth] failed to delete auth token");
    return reply.redirect(302, "/login?error=server");
  }

  const user = await ensureUserByEmail(row.email);
  if (!user) {
    return reply.redirect(302, "/login?error=user");
  }

  request.session.userId = user.id;

  const pendingPath = request.session.postLoginRedirect;
  const pendingPlan = request.session.postLoginPlan;
  delete request.session.postLoginRedirect;
  delete request.session.postLoginPlan;

  if (pendingPath === "/checkout" && (pendingPlan === "pro" || pendingPlan === "business")) {
    return reply.redirect(302, `/checkout?plan=${pendingPlan}`);
  }

  return reply.redirect(302, "/dashboard");
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

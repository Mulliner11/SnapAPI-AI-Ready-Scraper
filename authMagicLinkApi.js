import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { signAccessToken } from "../lib/authContext.js";
import { ensureUserByEmail } from "../db.js";

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = String(process.env.RESEND_FROM || "").trim() || "SnapAPI <support@getsnapapi.uk";
const MAGIC_LINK_LOGIN_URL =
  String(process.env.MAGIC_LINK_LOGIN_URL || "").replace(/\/$/, "") || "https://getsnapapi.uk/login";

function normalizeEmail(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function hashToken(plain) {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
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
      html: `<p>Click the link below to sign in (valid for 15 minutes):</p><p><a href="${linkUrl}">Sign in to SnapAPI</a></p><p>If you did not request this, ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Resend failed: ${res.status} ${t}`);
  }
}

export async function postAuthSendLink(request, reply) {
  const email = normalizeEmail(request.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply.code(400).send({ error: "Invalid email" });
  }

  const plain = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(plain);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  try {
    await prisma.loginSession.deleteMany({ where: { email } });
    await prisma.loginSession.create({
      data: { email, tokenHash, expiresAt },
    });
  } catch (e) {
    request.log.error(e, "[auth] failed to store login session");
    return reply.code(500).send({ error: "Could not create login session" });
  }

  const linkUrl = `${MAGIC_LINK_LOGIN_URL}?token=${encodeURIComponent(plain)}`;

  if (!RESEND_API_KEY) {
    if (process.env.NODE_ENV === "production") {
      await prisma.loginSession.deleteMany({ where: { tokenHash } }).catch(() => {});
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
    request.log.error(e, "[auth] Resend send failed");
    await prisma.loginSession.deleteMany({ where: { tokenHash } }).catch(() => {});
    return reply.code(502).send({ error: "Failed to send email" });
  }

  return reply.send({ ok: true, message: "If an account can use this email, a sign-in link has been sent." });
}

export async function postAuthVerify(request, reply) {
  const raw = String(request.body?.token ?? "").trim();
  if (raw.length < 16) {
    return reply.code(400).send({ error: "Invalid token" });
  }

  const tokenHash = hashToken(raw);

  let row;
  try {
    row = await prisma.loginSession.findUnique({ where: { tokenHash } });
  } catch (e) {
    request.log.error(e, "[auth] login session lookup failed");
    return reply.code(500).send({ error: "Database error" });
  }

  if (!row || row.expiresAt.getTime() < Date.now()) {
    return reply.code(401).send({ error: "Invalid or expired link" });
  }

  try {
    await prisma.loginSession.delete({ where: { id: row.id } });
  } catch (e) {
    request.log.error(e, "[auth] failed to delete login session");
    return reply.code(500).send({ error: "Database error" });
  }

  const user = await ensureUserByEmail(row.email);
  if (!user) {
    return reply.code(500).send({ error: "Could not load user" });
  }

  let jwt;
  try {
    jwt = await signAccessToken(user.id, user.email);
  } catch (e) {
    const code = e.statusCode === 503 ? 503 : 500;
    request.log.error(e, "[auth] JWT sign failed");
    return reply.code(code).send({ error: e.message || "Token signing failed" });
  }

  return reply.send({ token: jwt });
}

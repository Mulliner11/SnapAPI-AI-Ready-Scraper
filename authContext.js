import * as jose from "jose";

const enc = new TextEncoder();

export function getJwtSecretBytes() {
  const s = process.env.JWT_SECRET?.trim();
  if (!s || s.length < 32) return null;
  return enc.encode(s);
}

export async function signAccessToken(userId, email) {
  const key = getJwtSecretBytes();
  if (!key) {
    const err = new Error("JWT_SECRET is not configured or shorter than 32 characters");
    err.statusCode = 503;
    throw err;
  }
  return new jose.SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

export async function verifyAccessToken(token) {
  const key = getJwtSecretBytes();
  if (!key) return null;
  try {
    const { payload } = await jose.jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload;
  } catch {
    return null;
  }
}

/** Cookie session (pg user id) or `Authorization: Bearer` JWT. */
export async function getUserIdFromRequest(request) {
  const sid = request.session?.userId;
  if (sid != null) return sid;

  const h = request.headers.authorization;
  if (!h || typeof h !== "string" || !h.startsWith("Bearer ")) return null;

  const raw = h.slice(7).trim();
  if (!raw) return null;

  const payload = await verifyAccessToken(raw);
  if (payload?.sub == null) return null;

  const n = Number(payload.sub);
  return Number.isFinite(n) ? n : null;
}

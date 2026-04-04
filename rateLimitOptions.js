/**
 * Global @fastify/rate-limit options. Client IP: X-Forwarded-For (first hop) / X-Real-IP, then Fastify request.ip
 * (requires Fastify `trustProxy: true` for correct behavior behind Railway, etc.).
 *
 * Env:
 *   RATE_LIMIT_MAX — max requests per window (default 100)
 *   RATE_LIMIT_ALLOW_IPS — comma-separated IPs bypassing the limit entirely
 *   RATE_LIMIT_BYPASS_SECRET — if set, header `x-snapapi-ratelimit-bypass` matching this value bypasses the limit
 */

const RATE_LIMIT_ALLOW_IPS = new Set(
  String(process.env.RATE_LIMIT_ALLOW_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const RATE_LIMIT_BYPASS_SECRET = String(process.env.RATE_LIMIT_BYPASS_SECRET ?? "").trim();

export function getRateLimitClientIp(request) {
  const xf = request.headers["x-forwarded-for"];
  if (xf) {
    const raw = Array.isArray(xf) ? xf.join(",") : xf;
    const first = raw.split(",")[0].trim();
    if (first) return first;
  }
  const xr = request.headers["x-real-ip"];
  if (xr) {
    const v = Array.isArray(xr) ? xr[0] : xr;
    const s = String(v).trim();
    if (s) return s;
  }
  return request.ip || request.socket?.remoteAddress || "unknown";
}

function allowList(request) {
  const ip = getRateLimitClientIp(request);
  if (RATE_LIMIT_ALLOW_IPS.has(ip)) return true;

  if (RATE_LIMIT_BYPASS_SECRET) {
    const h = request.headers["x-snapapi-ratelimit-bypass"];
    const v = Array.isArray(h) ? h[0] : h;
    if (v === RATE_LIMIT_BYPASS_SECRET) return true;
  }

  const rawUrl = String(request.url || "");
  const pathname = rawUrl.split("?")[0].split("#")[0];
  if (pathname === "/health") return true;
  if (pathname === "/api/auth/send-magic-link" && request.method === "POST") return true;
  if (pathname === "/api/auth/verify" && request.method === "GET") return true;
  if (pathname === "/api/auth/pending-redirect" && request.method === "POST") return true;
  if (pathname === "/api/user/rotate-key" && request.method === "POST") return true;
  if (request.method === "POST" && rawUrl.toLowerCase().includes("nowpayments")) {
    return true;
  }
  if (pathname === "/api/subscribe" && request.method === "POST") return true;
  if (pathname === "/api/payment/create-invoice" && request.method === "POST") return true;
  if (pathname === "/checkout") return true;
  if (pathname === "/api/scrape" && request.method === "POST") return true;
  return false;
}

const maxParsed = Number(String(process.env.RATE_LIMIT_MAX ?? "100").trim());
const max = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : 100;

/** Options object for `fastify.register(rateLimit, rateLimitRegisterOptions)`. */
export const rateLimitRegisterOptions = {
  global: true,
  max,
  timeWindow: "1 minute",
  keyGenerator: getRateLimitClientIp,
  allowList,
};

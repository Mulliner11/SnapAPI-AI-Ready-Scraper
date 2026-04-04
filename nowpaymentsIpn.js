import crypto from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",")}}`;
}

/** HMAC-SHA512 over exact request bytes (what you get from fastify-raw-body with encoding: false). */
export function computeRawIpnBodyHmacSha512Hex(buffer, secret) {
  if (!secret || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  return crypto.createHmac("sha512", secret).update(buffer).digest("hex");
}

export function verifyNowPaymentsIpnRawBody(buffer, signature, secret) {
  if (!secret || !signature) return false;
  const expectedHex = computeRawIpnBodyHmacSha512Hex(buffer, secret);
  if (!expectedHex) return false;
  return timingSafeEqualHex(expectedHex, signature);
}

function timingSafeEqualHex(expectedHex, receivedHex) {
  const a = String(expectedHex).trim().toLowerCase().replace(/^0x/u, "");
  const b = String(receivedHex).trim().toLowerCase().replace(/^0x/u, "");
  if (a.length !== b.length || a.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(a) || !/^[0-9a-f]+$/u.test(b)) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Same canonical string NOWPayments uses for IPN signing: JSON with all object keys sorted
 * recursively (lexicographic), then HMAC-SHA512. Using sorted canonical form avoids depending on
 * the wire key order of the original body.
 *
 * @param {Buffer | string | object} rawBody — raw UTF-8 JSON bytes/string from the request, or an already-parsed object (e.g. if a framework parsed the body).
 * @returns {{ sorted: string | null, expectedHex: string | null }}
 */
export function computeNpIpnSignatureHex(rawBody, secret) {
  if (!secret) return { sorted: null, expectedHex: null };
  let sorted;
  try {
    if (rawBody != null && typeof rawBody === "object" && !Buffer.isBuffer(rawBody)) {
      sorted = stableStringify(rawBody);
    } else {
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
      const payload = JSON.parse(text);
      sorted = stableStringify(payload);
    }
  } catch {
    return { sorted: null, expectedHex: null };
  }
  const expectedHex = crypto.createHmac("sha512", secret).update(sorted, "utf8").digest("hex");
  return { sorted, expectedHex };
}

/**
 * NOWPayments IPN: canonical JSON (sorted keys) → HMAC-SHA512 with IPN secret;
 * compare digest (hex) to `x-nowpayments-sig` using a timing-safe comparison.
 */
export function verifyNowPaymentsIpnSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const { expectedHex } = computeNpIpnSignatureHex(rawBody, secret);
  if (!expectedHex) return false;
  return timingSafeEqualHex(expectedHex, signature);
}

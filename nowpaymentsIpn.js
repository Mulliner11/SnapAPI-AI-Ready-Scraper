import crypto from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",")}}`;
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
 * NOWPayments IPN: parse JSON body → recursively sort keys → stringify → HMAC-SHA512 with IPN secret;
 * compare digest (hex) to `x-nowpayments-sig` using a timing-safe comparison.
 */
export function verifyNowPaymentsIpnSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
  } catch {
    return false;
  }
  const sorted = stableStringify(payload);
  const expectedHex = crypto.createHmac("sha512", secret).update(sorted, "utf8").digest("hex");
  return timingSafeEqualHex(expectedHex, signature);
}

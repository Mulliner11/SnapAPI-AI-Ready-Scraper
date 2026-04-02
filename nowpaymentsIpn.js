import crypto from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",")}}`;
}

/**
 * NOWPayments IPN: HMAC-SHA512 over sorted JSON of the parsed body, hex digest vs x-nowpayments-sig.
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
  const expected = crypto.createHmac("sha512", secret).update(sorted).digest("hex");
  return expected === String(signature).toLowerCase();
}

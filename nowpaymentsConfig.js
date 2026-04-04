/**
 * NOWPayments REST API base resolution (no secrets here).
 *
 * - `NP_API_BASE` — optional full override of API host (no trailing slash; `/v1` is appended by callers).
 * - `NP_ENV=sandbox` — use https://api-sandbox.nowpayments.io (same `/v1/...` paths as production).
 * - Otherwise — https://api.nowpayments.io
 *
 * All secrets (`NP_API_KEY`, `NP_IPN_SECRET`) are read only from `process.env` at call sites.
 */

/** @returns {string} Origin only, e.g. https://api.nowpayments.io (no /v1) */
export function getNowpaymentsApiRoot() {
  const custom = String(process.env.NP_API_BASE ?? "").trim().replace(/\/+$/u, "");
  if (custom) {
    return custom.replace(/\/v1$/iu, "");
  }
  if (String(process.env.NP_ENV ?? "").trim().toLowerCase() === "sandbox") {
    return "https://api-sandbox.nowpayments.io";
  }
  return "https://api.nowpayments.io";
}

/**
 * @param {string} path - e.g. "/invoice" or "invoice"
 * @returns {string} e.g. https://api.nowpayments.io/v1/invoice
 */
export function buildNowpaymentsV1Url(path) {
  const root = getNowpaymentsApiRoot();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${root}/v1${p}`;
}

import { chromium } from "playwright";

/**
 * @param {unknown} e
 * @returns {Error & { statusCode: number, code: string }}
 */
function classifyPlaywrightNavError(e) {
  if (e && typeof e === "object" && "name" in e && e.name === "TimeoutError") {
    const err = new Error("Navigation timeout");
    err.statusCode = 504;
    err.code = "ERR_TIMEOUT";
    return err;
  }
  const msg = String((e && typeof e === "object" && "message" in e && e.message) || e || "");

  if (/net::ERR_BLOCKED|ERR_BLOCKED_BY|blocked by client/i.test(msg)) {
    const err = new Error(msg || "Request blocked");
    err.statusCode = 403;
    err.code = "ERR_BLOCKED";
    return err;
  }
  if (/net::ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/i.test(msg)) {
    const err = new Error(msg || "Host unreachable");
    err.statusCode = 502;
    err.code = "ERR_SCRAPE_FAILED";
    return err;
  }
  if (/404|status\s*==\s*404|HTTP\s*404|response\s+404/i.test(msg)) {
    const err = new Error(msg || "Page not found");
    err.statusCode = 404;
    err.code = "ERR_NOT_FOUND";
    return err;
  }
  const err = new Error(msg || "Navigation failed");
  err.statusCode = 502;
  err.code = "ERR_SCRAPE_FAILED";
  return err;
}

/**
 * @param {string} sourceUrl
 * @param {{ launchOptions: object, gotoTimeoutMs: number }} opts
 * @returns {Promise<string>}
 */
export async function loadPageHtml(sourceUrl, { launchOptions, gotoTimeoutMs }) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage();
    let response;
    try {
      response = await page.goto(sourceUrl, {
        waitUntil: "load",
        timeout: gotoTimeoutMs,
      });
    } catch (navErr) {
      throw classifyPlaywrightNavError(navErr);
    }

    if (response) {
      const status = response.status();
      if (status === 404) {
        const e = new Error("Page not found");
        e.statusCode = 404;
        e.code = "ERR_NOT_FOUND";
        throw e;
      }
      if (status === 403 || status === 401) {
        const e = new Error(status === 403 ? "Access forbidden" : "Unauthorized");
        e.statusCode = status;
        e.code = "ERR_BLOCKED";
        throw e;
      }
      if (status === 429) {
        const e = new Error("Too many requests");
        e.statusCode = 429;
        e.code = "ERR_BLOCKED";
        throw e;
      }
      if (status >= 400 && status < 500) {
        const e = new Error(`Client error: HTTP ${status}`);
        e.statusCode = status;
        e.code = `ERR_HTTP_${status}`;
        throw e;
      }
      if (status >= 500) {
        const e = new Error(`Upstream server error: HTTP ${status}`);
        e.statusCode = 502;
        e.code = `ERR_HTTP_${status}`;
        throw e;
      }
    }

    return await page.content();
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

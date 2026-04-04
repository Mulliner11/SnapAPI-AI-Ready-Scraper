const urlInput = document.getElementById("urlInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const tryScrapeBtn = document.getElementById("tryScrapeBtn");
const tryScrapeBtnLabel = document.getElementById("tryScrapeBtnLabel");
const result = document.getElementById("result");
const statusText = document.getElementById("statusText");
const compareAfter = document.getElementById("compareAfter");
const compareAfterTitle = document.getElementById("compareAfterTitle");

const savedKey = localStorage.getItem("snapapi_demo_key");
if (apiKeyInput) {
  if (savedKey) {
    apiKeyInput.value = savedKey;
  } else {
    apiKeyInput.value = "sk-test-666";
  }
  apiKeyInput.addEventListener("change", persistApiKey);
  apiKeyInput.addEventListener("input", persistApiKey);
}

function persistApiKey() {
  if (apiKeyInput) localStorage.setItem("snapapi_demo_key", apiKeyInput.value.trim());
}

function normalizeInputUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  value = value.replace(/^hyttp:\/\//i, "http://");
  value = value.replace(/^hyttps:\/\//i, "https://");
  if (!/^https?:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      value = "https://" + value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    } else {
      value = "https://" + value;
    }
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function setAfterLoading() {
  if (compareAfterTitle) compareAfterTitle.textContent = "Live…";
  if (compareAfter) {
    compareAfter.textContent = "Extracting readable content…";
    compareAfter.classList.add("is-live-markdown", "doc-code", "animate-pulse", "text-slate-500");
    compareAfter.classList.remove("text-slate-200", "text-red-300");
  }
}

function setAfterError(msg) {
  if (compareAfterTitle) compareAfterTitle.textContent = "Error";
  if (compareAfter) {
    compareAfter.textContent = msg;
    compareAfter.classList.add("is-live-markdown", "doc-code");
    compareAfter.classList.remove("animate-pulse", "text-slate-500");
    compareAfter.classList.add("text-red-300");
  }
}

function setAfterSuccess(title, markdown) {
  if (compareAfterTitle) {
    const t = title || "(no title)";
    compareAfterTitle.textContent = t;
    compareAfterTitle.title = t;
  }
  if (compareAfter) {
    compareAfter.textContent = markdown || "";
    compareAfter.classList.add("is-live-markdown", "doc-code", "text-slate-200");
    compareAfter.classList.remove("animate-pulse", "text-slate-500", "text-red-300");
  }
}

async function runScrape() {
  const normalizedUrl = normalizeInputUrl(urlInput?.value);
  if (!normalizedUrl) {
    if (result) result.classList.remove("hidden");
    if (statusText) statusText.textContent = "Enter a valid URL";
    setAfterError("Invalid URL — add https:// or we will prepend it.");
    return;
  }
  if (urlInput) urlInput.value = normalizedUrl;

  if (tryScrapeBtn) {
    tryScrapeBtn.disabled = true;
    if (tryScrapeBtnLabel) tryScrapeBtnLabel.textContent = "Scraping…";
  }
  if (result) result.classList.remove("hidden");
  if (statusText) statusText.textContent = "Calling POST /api/scrape…";
  setAfterLoading();

  try {
    const headers = { "Content-Type": "application/json" };
    const apiKey = apiKeyInput?.value?.trim() || "";
    if (apiKey) headers["x-api-key"] = apiKey;

    const res = await fetch("/api/scrape", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: normalizedUrl }),
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(text || `HTTP ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }

    if (statusText) {
      statusText.textContent = "Got clean Markdown + text — ready for LLMs & RAG.";
    }
    setAfterSuccess(data.title, data.markdown || data.text_content || "");
  } catch (err) {
    if (statusText) statusText.textContent = `Failed: ${err.message}`;
    setAfterError(err.message || "Request failed");
  } finally {
    if (tryScrapeBtn) {
      tryScrapeBtn.disabled = false;
      if (tryScrapeBtnLabel) tryScrapeBtnLabel.textContent = "Run scrape";
    }
  }
}

if (tryScrapeBtn) tryScrapeBtn.addEventListener("click", runScrape);
if (urlInput) {
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runScrape();
  });
}

(function initSubscribePricing() {
  const JWT_KEY = "snapapi_jwt";

  function authHeaders() {
    const h = {};
    const t = localStorage.getItem(JWT_KEY);
    if (t) h.Authorization = "Bearer " + t;
    return h;
  }

  async function isLoggedIn() {
    const r = await fetch("/api/user/me", {
      credentials: "include",
      headers: authHeaders(),
    });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return !!(d.apiKey || d.api_key);
  }

  async function onSubscribeClick(plan) {
    const p = plan === "business" ? "business" : "pro";
    async function navigate() {
      if (await isLoggedIn()) {
        window.location.href = "/checkout?plan=" + encodeURIComponent(p);
        return;
      }
      window.location.href =
        "/login?redirect=" + encodeURIComponent("/checkout") + "&plan=" + encodeURIComponent(p);
    }
    if (typeof window.snapapiOpenPaymentConfirmation === "function") {
      window.snapapiOpenPaymentConfirmation(navigate);
    } else {
      await navigate();
    }
  }

  document.querySelectorAll("button.subscribe-open[data-subscribe-plan]").forEach((btn) => {
    btn.addEventListener("click", () => onSubscribeClick(btn.getAttribute("data-subscribe-plan") || "pro"));
  });
})();

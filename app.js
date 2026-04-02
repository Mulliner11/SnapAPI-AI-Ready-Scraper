const urlInput = document.getElementById("urlInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const generateBtn = document.getElementById("generateBtn");
const result = document.getElementById("result");
const statusText = document.getElementById("statusText");
const resultLink = document.getElementById("resultLink");
const previewPanel = document.getElementById("previewPanel");
const previewState = document.getElementById("previewState");
const screenshotPreview = document.getElementById("screenshot-preview");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const modeScreenshotBtn = document.getElementById("modeScreenshot");
const modePdfBtn = document.getElementById("modePdf");

const MODE_SCREENSHOT = "screenshot";
const MODE_PDF = "pdf";

let outputMode = MODE_SCREENSHOT;

const savedKey = localStorage.getItem("snapapi_demo_key");
if (savedKey) {
  apiKeyInput.value = savedKey;
} else {
  apiKeyInput.value = "sk-test-666";
}

function persistApiKey() {
  localStorage.setItem("snapapi_demo_key", apiKeyInput.value.trim());
}

apiKeyInput.addEventListener("change", persistApiKey);
apiKeyInput.addEventListener("input", persistApiKey);

function setOutputMode(mode) {
  outputMode = mode;
  const active = "rounded-full border border-indigo-400/60 bg-indigo-500/30 px-4 py-1.5 text-xs font-medium text-white transition";
  const inactive =
    "rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10";
  if (mode === MODE_SCREENSHOT) {
    modeScreenshotBtn.className = active;
    modePdfBtn.className = inactive;
  } else {
    modeScreenshotBtn.className = inactive;
    modePdfBtn.className = active;
  }
  showPreviewPlaceholder();
}

modeScreenshotBtn.addEventListener("click", () => setOutputMode(MODE_SCREENSHOT));
modePdfBtn.addEventListener("click", () => setOutputMode(MODE_PDF));

/** Ensure preview / download use absolute URLs (API may return path-relative strings). */
function toAbsoluteAssetUrl(path) {
  if (typeof path !== "string" || !path) return "";
  const t = path.trim();
  if (/^https?:\/\//i.test(t)) return t;
  try {
    return new URL(t, window.location.origin).href;
  } catch {
    return t;
  }
}

function suggestedDownloadName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    if (seg && /\.pdf$/i.test(seg)) return seg;
    return "snapapi-export.pdf";
  } catch {
    return "snapapi-export.pdf";
  }
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

function showPreviewPlaceholder() {
  hidePreviewOutputs();
  previewState.classList.remove("hidden", "text-red-400", "animate-pulse");
  previewState.classList.add("text-slate-400", "animate-none");
  previewState.textContent = "Screenshot preview will appear here";
}

function hidePreviewOutputs() {
  if (screenshotPreview) {
    screenshotPreview.classList.add("hidden");
    screenshotPreview.removeAttribute("src");
  }
  downloadPdfBtn.classList.add("hidden");
  downloadPdfBtn.removeAttribute("href");
  downloadPdfBtn.removeAttribute("download");
}

function showPreviewLoading() {
  previewState.classList.remove("hidden", "text-red-400", "animate-none");
  previewState.classList.add("text-slate-400", "animate-pulse");
  previewState.textContent = "Processing...";
  hidePreviewOutputs();
}

function showPreviewError(message) {
  previewState.classList.remove("hidden", "text-slate-400", "animate-pulse");
  previewState.classList.add("text-red-400", "animate-none");
  previewState.textContent = message;
  hidePreviewOutputs();
}

function showPreviewFromPath(path) {
  if (typeof path !== "string" || !path) {
    showPreviewError("Invalid path in response");
    return;
  }

  const abs = toAbsoluteAssetUrl(path);

  if (outputMode === MODE_PDF) {
    previewState.classList.add("hidden");
    if (screenshotPreview) {
      screenshotPreview.classList.add("hidden");
      screenshotPreview.removeAttribute("src");
    }
    downloadPdfBtn.href = abs;
    downloadPdfBtn.setAttribute("download", suggestedDownloadName(abs));
    downloadPdfBtn.classList.remove("hidden");
    return;
  }

  downloadPdfBtn.classList.add("hidden");
  downloadPdfBtn.removeAttribute("href");
  downloadPdfBtn.removeAttribute("download");
  previewState.classList.remove("hidden", "text-red-400", "animate-none");
  previewState.classList.add("text-slate-400", "animate-pulse");
  previewState.textContent = "Loading image…";
  const bust = abs.includes("?") ? "&" : "?";
  if (screenshotPreview) {
    screenshotPreview.src = `${abs}${bust}t=${Date.now()}`;
    screenshotPreview.classList.remove("hidden");
  }
}

async function generate() {
  const normalizedUrl = normalizeInputUrl(urlInput.value);
  if (!normalizedUrl) {
    result.classList.remove("hidden");
    statusText.textContent = "Enter a valid URL";
    resultLink.classList.add("hidden");
    showPreviewError("Invalid URL — https:// is added automatically when omitted.");
    return;
  }
  urlInput.value = normalizedUrl;

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating...";
  generateBtn.classList.add("opacity-80", "scale-[0.99]");
  result.classList.remove("hidden");
  statusText.textContent = "Working…";
  resultLink.classList.add("hidden");
  showPreviewLoading();

  const endpoint = outputMode === MODE_PDF ? "/pdf" : "/screenshot";

  try {
    const headers = { "Content-Type": "application/json" };
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: normalizedUrl }),
    });

    let data;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(text || `HTTP ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }

    const path = data.path;
    if (!path) {
      throw new Error("Response is missing path");
    }

    const abs = toAbsoluteAssetUrl(path);

    statusText.textContent = outputMode === MODE_PDF ? "PDF ready" : "Screenshot ready";
    resultLink.textContent = abs;
    resultLink.href = abs;
    resultLink.classList.remove("hidden");

    showPreviewFromPath(abs);
  } catch (err) {
    statusText.textContent = `Failed: ${err.message}`;
    showPreviewError(err.message || "Request failed");
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate";
    generateBtn.classList.remove("opacity-80", "scale-[0.99]");
  }
}

if (screenshotPreview) {
  screenshotPreview.addEventListener("load", () => {
    previewState.classList.add("hidden");
  });

  screenshotPreview.addEventListener("error", () => {
    screenshotPreview.classList.add("hidden");
    showPreviewError("Image failed to load (check R2 public access or CORS). You can still open the link above.");
  });
}

generateBtn.addEventListener("click", generate);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") generate();
});

(function initSubscribeModal() {
  const modal = document.getElementById("subscribeModal");
  const emailInput = document.getElementById("subscribeEmail");
  const errEl = document.getElementById("subscribeError");
  const submitBtn = document.getElementById("subscribeSubmit");
  const closeBtn = document.getElementById("subscribeModalClose");
  const titleEl = document.getElementById("subscribeModalTitle");
  if (!modal || !emailInput || !submitBtn) return;

  let pendingPlan = "pro";

  function open(plan) {
    pendingPlan = plan === "business" ? "business" : "pro";
    if (titleEl) {
      titleEl.textContent = pendingPlan === "business" ? "Subscribe to Business" : "Subscribe to Pro";
    }
    errEl.classList.add("hidden");
    errEl.textContent = "";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    modal.setAttribute("aria-hidden", "false");
    emailInput.focus();
  }

  function close() {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    modal.setAttribute("aria-hidden", "true");
  }

  document.querySelectorAll("button.subscribe-open[data-subscribe-plan]").forEach((btn) => {
    btn.addEventListener("click", () => open(btn.getAttribute("data-subscribe-plan") || "pro"));
  });

  if (closeBtn) closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  submitBtn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    const email = emailInput.value.trim();
    if (!email) {
      errEl.textContent = "Please enter your email";
      errEl.classList.remove("hidden");
      return;
    }
    submitBtn.disabled = true;
    try {
      const r = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, plan_type: pendingPlan }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        errEl.textContent = data.error || "Could not start checkout";
        errEl.classList.remove("hidden");
        return;
      }
      if (data.payment_url) {
        window.location.href = data.payment_url;
        return;
      }
      errEl.textContent = "No payment URL returned";
      errEl.classList.remove("hidden");
    } catch {
      errEl.textContent = "Network error";
      errEl.classList.remove("hidden");
    } finally {
      submitBtn.disabled = false;
    }
  });

  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitBtn.click();
  });
})();

showPreviewPlaceholder();

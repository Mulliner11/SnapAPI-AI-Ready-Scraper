const urlInput = document.getElementById("urlInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const generateBtn = document.getElementById("generateBtn");
const result = document.getElementById("result");
const statusText = document.getElementById("statusText");
const resultLink = document.getElementById("resultLink");
const previewPanel = document.getElementById("previewPanel");
const previewState = document.getElementById("previewState");
const previewImage = document.getElementById("previewImage");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const modeScreenshotBtn = document.getElementById("modeScreenshot");
const modePdfBtn = document.getElementById("modePdf");

const MODE_SCREENSHOT = "screenshot";
const MODE_PDF = "pdf";

let outputMode = MODE_SCREENSHOT;

const savedKey = localStorage.getItem("snapapi_demo_key");
if (savedKey) apiKeyInput.value = savedKey;

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
}

modeScreenshotBtn.addEventListener("click", () => setOutputMode(MODE_SCREENSHOT));
modePdfBtn.addEventListener("click", () => setOutputMode(MODE_PDF));

function hidePreviewOutputs() {
  previewImage.classList.add("hidden");
  previewImage.removeAttribute("src");
  downloadPdfBtn.classList.add("hidden");
  downloadPdfBtn.removeAttribute("href");
}

function showPreviewLoading() {
  previewState.classList.remove("hidden", "text-red-400", "animate-none");
  previewState.classList.add("text-slate-400", "animate-pulse");
  previewState.textContent = "生成中...";
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
    showPreviewError("返回的 path 无效");
    return;
  }

  if (outputMode === MODE_PDF) {
    previewState.classList.add("hidden");
    previewImage.classList.add("hidden");
    previewImage.removeAttribute("src");
    downloadPdfBtn.href = path;
    downloadPdfBtn.classList.remove("hidden");
    return;
  }

  previewState.classList.add("hidden");
  downloadPdfBtn.classList.add("hidden");
  downloadPdfBtn.removeAttribute("href");
  const bust = path.includes("?") ? "&" : "?";
  previewImage.src = `${path}${bust}t=${Date.now()}`;
  previewImage.classList.remove("hidden");
}

async function generate() {
  const url = urlInput.value.trim();
  if (!url) {
    result.classList.remove("hidden");
    statusText.textContent = "请输入 URL";
    resultLink.classList.add("hidden");
    showPreviewError("请输入有效的 URL");
    return;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating...";
  generateBtn.classList.add("opacity-80", "scale-[0.99]");
  result.classList.remove("hidden");
  statusText.textContent = "处理中...";
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
      body: JSON.stringify({ url }),
    });

    let data;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(text || `HTTP ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(data.error || data.message || `请求失败 (${res.status})`);
    }

    const path = data.path;
    if (!path) {
      throw new Error("响应中缺少 path 字段");
    }

    statusText.textContent = outputMode === MODE_PDF ? "PDF 已生成" : "截图已生成";
    resultLink.textContent = path;
    resultLink.href = path;
    resultLink.classList.remove("hidden");

    showPreviewFromPath(path);
  } catch (err) {
    statusText.textContent = `失败：${err.message}`;
    showPreviewError(err.message || "请求失败");
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate";
    generateBtn.classList.remove("opacity-80", "scale-[0.99]");
  }
}

previewImage.addEventListener("error", () => {
  previewImage.classList.add("hidden");
  showPreviewError("图片无法加载（可检查 R2 公网访问或 CORS）。链接仍可在上方打开。");
});

generateBtn.addEventListener("click", generate);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") generate();
});

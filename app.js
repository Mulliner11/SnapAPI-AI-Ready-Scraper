const urlInput = document.getElementById("urlInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const generateBtn = document.getElementById("generateBtn");
const result = document.getElementById("result");
const statusText = document.getElementById("statusText");
const resultLink = document.getElementById("resultLink");
const previewImage = document.getElementById("previewImage");

const savedKey = localStorage.getItem("snapapi_demo_key");
if (savedKey) apiKeyInput.value = savedKey;

apiKeyInput.addEventListener("change", () => {
  localStorage.setItem("snapapi_demo_key", apiKeyInput.value.trim());
});

async function generateScreenshot() {
  const url = urlInput.value.trim();
  if (!url) {
    result.classList.remove("hidden");
    statusText.textContent = "请输入 URL";
    resultLink.classList.add("hidden");
    previewImage.classList.add("hidden");
    return;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating...";
  generateBtn.classList.add("opacity-80", "scale-[0.99]");
  result.classList.remove("hidden");
  statusText.textContent = "正在生成截图，请稍候...";
  resultLink.classList.add("hidden");
  previewImage.classList.add("hidden");

  try {
    const headers = { "Content-Type": "application/json" };
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) headers["x-api-key"] = apiKey;

    const res = await fetch("/screenshot", {
      method: "POST",
      headers,
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || data.message || "请求失败");
    }

    statusText.textContent = "生成成功";
    resultLink.textContent = data.path;
    resultLink.href = data.path;
    resultLink.classList.remove("hidden");

    if (typeof data.path === "string" && data.path.toLowerCase().endsWith(".png")) {
      previewImage.src = data.path;
      previewImage.classList.remove("hidden");
    }
  } catch (err) {
    statusText.textContent = `生成失败：${err.message}`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate";
    generateBtn.classList.remove("opacity-80", "scale-[0.99]");
  }
}

generateBtn.addEventListener("click", generateScreenshot);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") generateScreenshot();
});

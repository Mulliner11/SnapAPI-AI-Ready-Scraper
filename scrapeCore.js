import { load } from "cheerio";
import TurndownService from "turndown";
import { franc } from "franc-min";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  linkStyle: "inlined",
});

const MAX_MARKDOWN_CHARS = 500_000;
const MAX_TEXT_CHARS = 500_000;

/** Prefer semantic/main content regions before falling back to body. */
const CONTENT_SELECTORS = [
  "article",
  "main",
  "[role='main']",
  ".post-content",
  ".article-body",
  ".entry-content",
  "#content",
  ".content",
  "#main",
];

/** Banner / consent nodes often outside semantic tags; match common class/id patterns. */
const NOISE_BANNER_SELECTORS = [
  ".cookie-banner",
  ".cookie_banner",
  '[class*="cookie-banner"]',
  '[class*="cookie_banner"]',
  '[id="cookie-banner"]',
  '[id*="cookie-banner"]',
  '[class*="cookie-consent"]',
  '[id*="cookieConsent"]',
  '[class*="consent-banner"]',
  '[class*="cc-banner"]',
  '[class*="gdpr-banner"]',
  '[id*="gdpr"]',
  '[class*="privacy-banner"]',
  '[class*="announcement-bar"]',
];

function pickContentRoot($) {
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length) return el;
  }
  return $("body").first();
}

function stripNoise(ctx) {
  ctx
    .find(
      "script, style, noscript, template, iframe, svg, canvas, picture, video, audio, " +
        "nav, footer, header, aside, [role='navigation'], [role='banner'], [role='contentinfo']"
    )
    .remove();
  for (const sel of NOISE_BANNER_SELECTORS) {
    ctx.find(sel).remove();
  }
}

/** Collapse h4–h6 to h3 so the outline stays within H1–H3 for downstream models. */
function normalizeHeadingDepth($, root) {
  root.find("h4, h5, h6").each((_, el) => {
    const $el = $(el);
    const h3 = $("<h3></h3>");
    h3.append($el.contents());
    $el.replaceWith(h3);
  });
}

function countWords(text) {
  const t = text.trim();
  if (!t) return 0;
  const latin = t.match(/[a-zA-Z0-9']+/g) || [];
  const cjk =
    t.match(/[\u4e00-\u9fff\u3040-\u30ff\u3131-\u318e\uac00-\ud7af]/g) || [];
  return latin.length + cjk.length;
}

function detectLanguage(text) {
  const sample = text.trim().slice(0, 8000);
  if (!sample) return "und";
  return franc(sample, { minLength: 1 });
}

function buildMetadata(text_content) {
  const word_count = countWords(text_content);
  const language = detectLanguage(text_content);
  const estimated_reading_time =
    word_count === 0 ? 0 : Math.max(1, Math.ceil(word_count / 200));
  return { word_count, estimated_reading_time, language };
}

function normalizeMarkdown(md) {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * HTML → Markdown + plain text using Cheerio (ESM-native) + Turndown.
 *
 * @param {string} html
 * @param {string} pageUrl  Optional base URI for the document
 * @returns {{ title: string, markdown: string, text_content: string, metadata: object }}
 */
export function extractReadableMarkdown(html, pageUrl) {
  const $ = load(html, {
    baseURI: pageUrl || undefined,
  });

  const title =
    $("title").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    "";

  const root = pickContentRoot($);
  stripNoise(root);
  normalizeHeadingDepth($, root);

  const innerHtml = root.html()?.trim() || "";
  const text_content = root
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  const metadata = buildMetadata(text_content);

  let markdown = "";
  if (innerHtml) {
    markdown = normalizeMarkdown(turndown.turndown(innerHtml)).slice(0, MAX_MARKDOWN_CHARS);
  }
  if (!markdown && text_content) {
    markdown = normalizeMarkdown(
      `# ${title || "Untitled"}\n\n${text_content}`
    ).slice(0, MAX_MARKDOWN_CHARS);
  }

  return {
    title,
    markdown,
    text_content,
    metadata,
  };
}

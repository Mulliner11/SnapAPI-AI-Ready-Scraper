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

/**
 * User-mandated removal: nav, footer, header, aside, script, style — plus common chrome/embeds.
 */
const GLOBAL_REMOVE_SELECTOR =
  "nav, footer, header, aside, script, style, noscript, template, " +
  "iframe, svg, canvas, picture, video, audio, object, embed, " +
  "[role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']";

/**
 * Tags we keep (structure + table subtree + lists + minimal inline for readable Markdown).
 * Everything else is unwrapped (promote children) or stripped entirely.
 */
const KEEP_TAGS = new Set([
  "main",
  "article",
  "section",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "hr",
  "figure",
  "figcaption",
  "img",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "code",
  "br",
  "span",
  "sub",
  "sup",
  "mark",
  "abbr",
  "cite",
  "kbd",
  "samp",
  "var",
  "dfn",
  "del",
  "ins",
  "small",
  "wbr",
  "q",
  "u",
  "s",
]);

/** Remove node and subtree (forms, media controls, etc.). */
const STRIP_SUBTREE_TAGS = new Set([
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "optgroup",
  "fieldset",
  "legend",
  "label",
  "datalist",
  "output",
  "progress",
  "meter",
  "map",
  "dialog",
  "menu",
  "slot",
]);

function pickContentRoot($) {
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length) return el;
  }
  return $("body").first();
}

function stripNoise(ctx) {
  ctx.find(GLOBAL_REMOVE_SELECTOR).remove();
  for (const sel of NOISE_BANNER_SELECTORS) {
    ctx.find(sel).remove();
  }
}

/**
 * Drop large lists where most items are short link-only rows (ads / related / tag clouds).
 */
function removeRepetitiveLinkLists($, root) {
  root.find("ul, ol").each((_, listEl) => {
    const $list = $(listEl);
    const items = $list.children("li");
    const n = items.length;
    if (n < 8) return;

    let linkHeavy = 0;
    items.each((__, li) => {
      const $li = $(li);
      const text = $li.text().trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const links = $li.find("a");
      const childCount = $li.children().length;
      const singleLink = links.length === 1 && childCount <= 5;
      const shortItem = wordCount <= 20 && text.length <= 160;
      if (singleLink && shortItem) {
        linkHeavy++;
        return;
      }
      if (links.length >= 2 && wordCount <= 14 + links.length * 6) linkHeavy++;
    });

    if (linkHeavy / n >= 0.72) $list.remove();
  });
}

/**
 * Unwrap unknown elements; strip interactive / form subtrees entirely.
 */
function pruneDisallowedElements($, root) {
  const maxPasses = 36;
  for (let pass = 0; pass < maxPasses; pass++) {
    const candidates = root
      .find("*")
      .toArray()
      .filter((el) => el && typeof el.tagName === "string" && el.tagName);

    let changed = false;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      const tag = el.tagName.toLowerCase();
      if (KEEP_TAGS.has(tag)) continue;
      if (STRIP_SUBTREE_TAGS.has(tag)) {
        $(el).remove();
        changed = true;
        continue;
      }
      const $el = $(el);
      $el.replaceWith($el.contents());
      changed = true;
    }
    if (!changed) break;
  }
}

function extractTitle($) {
  return (
    $("title").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    ""
  );
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

function buildStats(htmlLength, markdownStr) {
  const rawSize = htmlLength;
  const cleanSize = markdownStr.length;
  const tokenSaved = Math.max(
    0,
    Math.ceil(rawSize / 4) - Math.ceil(cleanSize / 4)
  );
  return { rawSize, cleanSize, tokenSaved };
}

/**
 * HTML → Markdown + plain text using Cheerio + Turndown, with aggressive denoising.
 *
 * @param {string} html
 * @param {string} pageUrl  Optional base URI for the document
 * @returns {{ title: string, markdown: string, text_content: string, metadata: object, stats: { rawSize: number, cleanSize: number, tokenSaved: number } }}
 */
export function extractReadableMarkdown(html, pageUrl) {
  const $ = load(html, {
    baseURI: pageUrl || undefined,
  });

  const title = extractTitle($);

  $(GLOBAL_REMOVE_SELECTOR).remove();

  const root = pickContentRoot($);
  stripNoise(root);
  removeRepetitiveLinkLists($, root);
  pruneDisallowedElements($, root);
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

  const stats = buildStats(html.length, markdown);

  return {
    title,
    markdown,
    text_content,
    metadata,
    stats,
  };
}

import { load } from "cheerio";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
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
}

/**
 * HTML → Markdown + plain text using Cheerio (ESM-native) + Turndown.
 *
 * @param {string} html
 * @param {string} pageUrl  Optional base URI for the document
 * @returns {{ title: string, markdown: string, text_content: string }}
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

  const innerHtml = root.html()?.trim() || "";
  const text_content = root
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  let markdown = "";
  if (innerHtml) {
    markdown = turndown.turndown(innerHtml).slice(0, MAX_MARKDOWN_CHARS);
  }
  if (!markdown && text_content) {
    markdown = `# ${title || "Untitled"}\n\n${text_content}`.slice(0, MAX_MARKDOWN_CHARS);
  }

  return {
    title,
    markdown,
    text_content,
  };
}

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

const MAX_MARKDOWN_CHARS = 500_000;
const MAX_TEXT_CHARS = 500_000;

/**
 * @param {string} html
 * @param {string} pageUrl  Canonical URL for relative links in Readability
 * @returns {{ title: string, markdown: string, text_content: string }}
 */
export function extractReadableMarkdown(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const reader = new Readability(doc);
  const article = reader.parse();

  if (!article) {
    const title = (doc.querySelector("title")?.textContent || "").trim();
    const textContent = (doc.body?.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT_CHARS);
    const markdown =
      textContent.length > 0
        ? `# ${title || "Untitled"}\n\n${textContent}`.slice(0, MAX_MARKDOWN_CHARS)
        : "";
    return {
      title: title || "",
      markdown,
      text_content: textContent,
    };
  }

  const markdown = turndown
    .turndown(article.content || "")
    .slice(0, MAX_MARKDOWN_CHARS);
  const text_content = (article.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  return {
    title: (article.title || "").trim(),
    markdown,
    text_content,
  };
}

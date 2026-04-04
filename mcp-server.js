#!/usr/bin/env node
/**
 * SnapAPI MCP server (stdio): exposes POST /api/scrape as tool `snapapi_scrape`
 * for Claude Desktop, Cursor, and other MCP clients.
 *
 * Configure (example Cursor ~/.cursor/mcp.json):
 *   "snapapi": {
 *     "command": "node",
 *     "args": ["/absolute/path/to/screenshot-api/mcp-server.js"],
 *     "env": {
 *       "SNAPAPI_BASE_URL": "https://getsnapapi.uk",
 *       "SNAPAPI_API_KEY": "sk-your-key"
 *     }
 *   }
 *
 * Env:
 *   SNAPAPI_BASE_URL — API origin (no trailing slash). Default: https://getsnapapi.uk
 *   SNAPAPI_API_KEY  — default x-api-key (optional if you pass api_key on each call)
 */
import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = String(process.env.SNAPAPI_BASE_URL || "https://getsnapapi.uk").replace(
  /\/+$/,
  ""
);
const defaultApiKey = String(
  process.env.SNAPAPI_API_KEY || process.env.SNAP_API_KEY || ""
).trim();

const scrapeOutputSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  text_content: z.string(),
  metadata: z.object({
    word_count: z.coerce.number(),
    estimated_reading_time: z.coerce.number(),
    language: z.string(),
  }),
});

const mcp = new McpServer(
  { name: "snapapi-scrape", version: "1.0.0" },
  {
    instructions:
      "Use snapapi_scrape to turn a public URL into clean Markdown and metadata via SnapAPI. " +
      "Provide SNAPAPI_API_KEY in the environment or pass api_key on the tool call. " +
      "Prefer structuredContent for the full markdown body.",
  }
);

mcp.registerTool(
  "snapapi_scrape",
  {
    title: "SnapAPI — URL to Markdown",
    description:
      "Calls SnapAPI to fetch a web page and return AI-ready output: title, Markdown (noise stripped, " +
      "H1–H3 outline, links preserved), plain text, and metadata (word_count, estimated_reading_time in minutes, " +
      "language as ISO 639-3). Requires API key via env SNAPAPI_API_KEY or argument api_key.",
    inputSchema: z.object({
      url: z.string().min(1).describe("Page URL to scrape (http or https)."),
      api_key: z
        .string()
        .optional()
        .describe("Optional SnapAPI key; overrides SNAPAPI_API_KEY when set."),
    }),
    outputSchema: scrapeOutputSchema,
  },
  async (args) => {
    const apiKey = String(args.api_key || "").trim() || defaultApiKey;
    if (!apiKey) {
      return mcp.createToolError(
        "Missing API key. Set SNAPAPI_API_KEY in the MCP server environment, or pass api_key on this tool call."
      );
    }

    const endpoint = `${baseUrl}/api/scrape`;
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ url: args.url }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return mcp.createToolError(`Network error calling ${endpoint}: ${msg}`);
    }

    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      return mcp.createToolError(
        `SnapAPI returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 800)}`
      );
    }

    if (!res.ok) {
      const code = typeof data.code === "string" ? data.code : "";
      const errText = typeof data.error === "string" ? data.error : res.statusText;
      const suffix = code ? ` (${code})` : "";
      return mcp.createToolError(`SnapAPI error HTTP ${res.status}: ${errText}${suffix}`);
    }

    const structuredContent = {
      title: typeof data.title === "string" ? data.title : "",
      markdown: typeof data.markdown === "string" ? data.markdown : "",
      text_content: typeof data.text_content === "string" ? data.text_content : "",
      metadata:
        data.metadata && typeof data.metadata === "object"
          ? {
              word_count: data.metadata.word_count ?? 0,
              estimated_reading_time: data.metadata.estimated_reading_time ?? 0,
              language:
                typeof data.metadata.language === "string"
                  ? data.metadata.language
                  : "und",
            }
          : { word_count: 0, estimated_reading_time: 0, language: "und" },
    };

    const { title, metadata } = structuredContent;
    const previewNote =
      structuredContent.markdown.length > 12_000
        ? "\n\n(Full markdown is in structuredContent; preview truncated.)"
        : "";
    const preview = structuredContent.markdown.slice(0, 12_000) + previewNote;

    return {
      content: [
        {
          type: "text",
          text:
            `Title: ${title || "(untitled)"}\n` +
            `Words: ${metadata.word_count} · ~${metadata.estimated_reading_time} min read · lang: ${metadata.language}\n\n` +
            preview,
        },
      ],
      structuredContent,
    };
  }
);

const transport = new StdioServerTransport();
await mcp.connect(transport);

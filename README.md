# 🚀 SnapAPI: AI-Ready Web Scraper & Data Pipeline

**SnapAPI** is a high-performance web scraping engine designed specifically for the AI era. It transforms any messy URL into clean, denoised Markdown or structured JSON, ready to be fed into LLMs (GPT-4, Claude, Gemini) or RAG pipelines.

[🌐 Live Demo](https://getsnapapi.uk) | [📖 Documentation](https://getsnapapi.uk/docs) | [📦 MCP Server Included](#-mcp-integration)

---

## ✨ Key Features

- **🎯 Extreme Denoising:** Automatically removes headers, footers, navbars, and ads. Focus only on the content that matters.
- **💰 Token Efficiency:** Reduces token usage by up to 90% compared to raw HTML.
- **🔌 MCP Ready:** Built-in Model Context Protocol (MCP) server for native integration with Claude Desktop and Cursor.
- **⚡ Production-Grade:** Built with Node.js (Fastify) and Playwright (Chromium) for speed and reliability.
- **🛠 Developer First:** Clean API, one-click downloads (MD/JSON/CSV), and easy self-hosting.

---

## 🚀 Quick Start (API)

```bash
curl -X POST https://getsnapapi.uk/api/scrape \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"url": "https://example.com"}'
  🔌 MCP Integration
SnapAPI supports the Model Context Protocol. To use it in Claude Desktop, add this to your claude_desktop_config.json:
{
  "mcpServers": {
    "snapapi": {
      "command": "npx",
      "args": ["-y", "@mulliner/snapapi-mcp"]
    }
  }
}
🛠 Tech Stack
Backend: Node.js (ESM), Fastify

Scraping: Playwright (Chromium)

Database: PostgreSQL + Prisma

Infrastructure: Docker, Railway

📄 License
Distributed under the MIT License. See LICENSE for more information.

🤝 Contributing
This is an open-source project. Feel free to fork, submit PRs, or open issues!

Built with ❤️ by a Solo Dev.
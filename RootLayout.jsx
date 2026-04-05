/**
 * SnapAPI is served as static HTML (Fastify), not React. There is no runtime RootLayout.
 * This file re-exports the layout contract so tooling / search finds a single entry point.
 *
 * @see htmlLayout.js — paths for globals.css, Tailwind preset, marketing header, logo.
 */
export { SNAPAPI_LAYOUT } from "./htmlLayout.js";

/**
 * Layout contract for SnapAPI (static HTML + Fastify — no React RootLayout).
 * Shared Tailwind preset: `/ds-tailwind-config.js` before the Tailwind CDN.
 * Global base styles: `/globals.css`.
 *
 * Marketing chrome: `<div id="ds-marketing-header-root"></div>` + `/ds-marketing-header-boot.js` defer.
 * Brand mark: inline SVG (2×2 rounded squares, `fill="currentColor"`, `h-6`) + wordmark “SnapAPI” in the header partial and dashboard shells.
 */

export const SNAPAPI_LAYOUT = {
  globalsCss: "/globals.css",
  tailwindPresetJs: "/ds-tailwind-config.js",
  landingThemeJs: "/landing-theme.js",
  marketingHeaderBootJs: "/ds-marketing-header-boot.js",
  marketingHeaderPartial: "/partials/marketing-header.html",
  /** Legacy PNG route still served; UI uses inline SVG + text. */
  logoPng: "/logo.png",
};

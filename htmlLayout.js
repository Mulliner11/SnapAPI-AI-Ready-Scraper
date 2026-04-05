/**
 * Layout contract for SnapAPI (static HTML + Fastify — no React RootLayout).
 * Shared Tailwind preset: `/ds-tailwind-config.js` before the Tailwind CDN.
 * Global base styles: `/globals.css`.
 *
 * Marketing chrome: `<div id="ds-marketing-header-root"></div>` + `/ds-marketing-header-boot.js` defer.
 * Logo: `/logo.png` as CSS background, `background-size: 100% 200%`, `background-position: top`, 140×32 — shows light (top) half only.
 */

export const SNAPAPI_LAYOUT = {
  globalsCss: "/globals.css",
  tailwindPresetJs: "/ds-tailwind-config.js",
  landingThemeJs: "/landing-theme.js",
  marketingHeaderBootJs: "/ds-marketing-header-boot.js",
  marketingHeaderPartial: "/partials/marketing-header.html",
  logoPng: "/logo.png",
};

/**
 * Layout contract for SnapAPI (static HTML + Fastify — no React RootLayout).
 * Shared Tailwind preset: `/ds-tailwind-config.js` before the Tailwind CDN.
 * Global reset + tokens: `/globals.css` (also re-exported as `/design-system.css`).
 *
 * Marketing chrome: `<div id="ds-marketing-header-root"></div>` + `/ds-marketing-header-boot.js` defer.
 * Logo: `<img src="/logo.png" alt="Logo" />` (served from `public/logo.png`).
 */

export const SNAPAPI_LAYOUT = {
  globalsCss: "/globals.css",
  designSystemCss: "/design-system.css",
  tailwindPresetJs: "/ds-tailwind-config.js",
  landingThemeJs: "/landing-theme.js",
  marketingHeaderBootJs: "/ds-marketing-header-boot.js",
  marketingHeaderPartial: "/partials/marketing-header.html",
  logoPng: "/logo.png",
};

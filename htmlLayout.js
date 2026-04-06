/**
 * Layout contract for SnapAPI (static HTML + Fastify — no React RootLayout).
 * Shared Tailwind preset: `/ds-tailwind-config.js` before the Tailwind CDN.
 * Global base styles: `/globals.css`.
 *
 * Marketing chrome: `<div id="ds-marketing-header-root"></div>` + `/ds-marketing-header-boot.js` defer.
 * Brand: `<img src="/logo.svg" alt="SnapAPI" class="h-7 w-auto block" />` in marketing header partial and dashboard shells (logo link contains only this img).
 */

export const SNAPAPI_LAYOUT = {
  globalsCss: "/globals.css",
  tailwindPresetJs: "/ds-tailwind-config.js",
  landingThemeJs: "/landing-theme.js",
  marketingHeaderBootJs: "/ds-marketing-header-boot.js",
  marketingHeaderPartial: "/partials/marketing-header.html",
  logoSvg: "/logo.svg",
  /** Legacy asset; UI prefers `logoSvg`. */
  logoPng: "/logo.png",
};

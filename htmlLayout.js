/**
 * Layout contract for SnapAPI (static HTML + Fastify — there is no React RootLayout).
 *
 * Use these paths on every page that should match the Vercel/Linear-style system:
 *
 * 1. `<html class="ds-root">` + optional `dark` from theme script
 * 2. `<link rel="stylesheet" href="/design-system.css" />` (after fonts)
 * 3. Load `/ds-tailwind-config.js` before the Tailwind CDN, then:
 *    `tailwind.config = { darkMode: "class", theme: { extend: window.snapapiDsTailwindExtend } };`
 * 4. FOUC theme snippet (see index.html) + `<script src="/landing-theme.js" defer></script>` for marketing theme toggle
 * 5. Marketing chrome: first child of `<body>` → `<div id="ds-marketing-header-root"></div>` then
 *    `<script src="/ds-marketing-header-boot.js" defer></script>`
 * 6. Body: `ds-body-marketing` (or `ds-body-app` for console) + `font-sans text-neutral-900 antialiased`
 * 7. Main content width/gutters: `mx-auto max-w-7xl px-6 sm:px-8` and section vertical rhythm `py-16 sm:py-20` like the hero
 */

export const SNAPAPI_LAYOUT = {
  designSystemCss: "/design-system.css",
  tailwindPresetJs: "/ds-tailwind-config.js",
  landingThemeJs: "/landing-theme.js",
  marketingHeaderBootJs: "/ds-marketing-header-boot.js",
  marketingHeaderPartial: "/partials/marketing-header.html",
};

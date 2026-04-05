/**
 * Shared Tailwind CDN `theme.extend` for SnapAPI pages.
 * Load BEFORE `https://cdn.tailwindcss.com`, then assign:
 *   tailwind.config = { darkMode: "class", theme: { extend: window.snapapiDsTailwindExtend } };
 */
window.snapapiDsTailwindExtend = {
  fontFamily: {
    sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
  },
  fontSize: {
    base: ["1.0625rem", { lineHeight: "1.65" }],
  },
  colors: {
    panel: "#0b1020",
    panelSoft: "#111a31",
    accent: "#7c3aed",
  },
  boxShadow: {
    glow: "0 0 80px rgba(124, 58, 237, 0.28)",
    landing: "0 24px 48px -12px rgba(15, 23, 42, 0.12)",
    dsSoft: "0 1px 2px rgba(15, 23, 42, 0.04)",
  },
};

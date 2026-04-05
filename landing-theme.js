/**
 * SnapAPI landing: theme only — Light / Dark / System (class on <html>).
 */
(function () {
  var THEME_KEY = "snapapi-theme";

  function getTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark" || t === "system") return t;
    } catch (e) {}
    return "system";
  }

  function setTheme(mode) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch (e) {}
    applyTheme(mode);
  }

  function applyTheme(mode) {
    var root = document.documentElement;
    var dark = false;
    if (mode === "dark") dark = true;
    else if (mode === "light") dark = false;
    else {
      dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    root.classList.toggle("dark", dark);
  }

  function closeMenus() {
    document.querySelectorAll("[data-dropdown]").forEach(function (panel) {
      panel.classList.add("hidden");
      panel.setAttribute("aria-hidden", "true");
      var btn = document.querySelector('[aria-controls="' + panel.id + '"]');
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
  }

  function wireDropdown(btnId, panelId) {
    var btn = document.getElementById(btnId);
    var panel = document.getElementById(panelId);
    if (!btn || !panel) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = panel.classList.contains("hidden");
      closeMenus();
      if (open) {
        panel.classList.remove("hidden");
        panel.setAttribute("aria-hidden", "false");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  }

  function init() {
    applyTheme(getTheme());

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        if (getTheme() === "system") applyTheme("system");
      });
    }

    wireDropdown("theme-trigger", "theme-panel");

    document.addEventListener("click", closeMenus);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenus();
    });

    document.querySelectorAll("[data-theme-pick]").forEach(function (el) {
      el.addEventListener("click", function () {
        var m = el.getAttribute("data-theme-pick");
        if (m) setTheme(m);
        closeMenus();
      });
    });

    document.querySelectorAll("[data-dropdown]").forEach(function (panel) {
      panel.addEventListener("click", function (e) {
        e.stopPropagation();
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.snapapiLanding = { setTheme: setTheme, applyTheme: applyTheme, getTheme: getTheme };
})();

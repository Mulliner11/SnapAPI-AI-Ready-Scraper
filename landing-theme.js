/**
 * SnapAPI landing: theme only — Light / Dark / System (class on <html>).
 * Theme controls use document-level delegation so markup can be injected after load.
 */
(function () {
  var THEME_KEY = "snapapi-theme";
  var themeUiBound = false;

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

  function bindThemeUi() {
    if (themeUiBound) return;
    themeUiBound = true;

    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var pick = t.closest("[data-theme-pick]");
      if (pick) {
        var m = pick.getAttribute("data-theme-pick");
        if (m) setTheme(m);
        closeMenus();
        return;
      }

      if (t.closest("[data-dropdown]")) return;

      var trigger = t.closest("#theme-trigger");
      if (trigger) {
        e.stopPropagation();
        var panel = document.getElementById("theme-panel");
        if (!panel) return;
        var wasHidden = panel.classList.contains("hidden");
        closeMenus();
        if (wasHidden) {
          panel.classList.remove("hidden");
          panel.setAttribute("aria-hidden", "false");
          trigger.setAttribute("aria-expanded", "true");
        }
        return;
      }

      closeMenus();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenus();
    });
  }

  function init() {
    applyTheme(getTheme());

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        if (getTheme() === "system") applyTheme("system");
      });
    }

    bindThemeUi();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.snapapiLanding = { setTheme: setTheme, applyTheme: applyTheme, getTheme: getTheme };
})();

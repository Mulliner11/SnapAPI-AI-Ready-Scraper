/**
 * Injects shared marketing header from /partials/marketing-header.html.
 * Requires a placeholder: <div id="ds-marketing-header-root"></div> as first body child.
 * Load after /landing-theme.js (defer). Theme UI uses document-level delegation.
 */
(function () {
  function swapNavAuth() {
    try {
      var jwt = localStorage.getItem("snapapi_jwt");
      var headers = {};
      if (jwt) headers.Authorization = "Bearer " + jwt;
      fetch("/api/user/me", { credentials: "include", headers: headers })
        .then(function (r) {
          return r.json().then(function (d) {
            return { r: r, d: d };
          });
        })
        .then(function (_ref) {
          var r = _ref.r;
          var d = _ref.d;
          var okUser = r.ok && (d.apiKey || d.api_key) && d.loggedIn !== false;
          var login = document.getElementById("navLogin");
          var dash = document.getElementById("navDashboard");
          if (okUser && login && dash) {
            login.classList.add("hidden");
            dash.classList.remove("hidden");
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  async function inject() {
    var root = document.getElementById("ds-marketing-header-root");
    if (!root) return;
    try {
      var res = await fetch("/partials/marketing-header.html", { credentials: "same-origin" });
      if (!res.ok) return;
      var html = await res.text();
      root.outerHTML = html;
      swapNavAuth();
    } catch (e) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else inject();
})();

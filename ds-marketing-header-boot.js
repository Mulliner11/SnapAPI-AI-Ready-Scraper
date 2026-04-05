(function () {
  var root = document.getElementById("ds-marketing-header-root");
  if (!root) return;
  fetch("/partials/marketing-header.html", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then(function (html) {
      root.innerHTML = html;
    })
    .catch(function () {});
})();

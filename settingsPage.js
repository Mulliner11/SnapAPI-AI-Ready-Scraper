/**
 * SettingsPage — account email, API key, rotate key, sign out.
 * Uses GET /api/user/me, POST /api/user/rotate-key, POST /auth/logout.
 * Usage: SnapapiSettingsPage.mount(root, { getAuthHeaders, jwtStorageKey? });
 */
(function (global) {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  async function fetchMe(getAuthHeaders) {
    const r = await fetch("/api/user/me", {
      headers: typeof getAuthHeaders === "function" ? getAuthHeaders() : {},
      credentials: "include",
      cache: "no-store",
    });
    if (r.status === 401) {
      window.location.href = "/login";
      return null;
    }
    if (r.status === 503) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || "Database not configured");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(d.error || "Could not load settings");
    }
    if (d.loggedIn === false || (!d.email && !d.api_key && !d.apiKey)) {
      window.location.href = "/login";
      return null;
    }
    return d;
  }

  global.SnapapiSettingsPage = {
    /**
     * @param {HTMLElement} root
     * @param {{ getAuthHeaders?: () => Record<string, string>, jwtStorageKey?: string }} [options]
     */
    async mount(root, options) {
      if (!root) return;
      options = options || {};
      const getAuthHeaders = options.getAuthHeaders;
      const jwtKey = options.jwtStorageKey || "snapapi_jwt";

      root.textContent = "";
      const loading = el(
        "p",
        "rounded-xl border border-gray-200 bg-white px-6 py-8 text-center text-gray-600 shadow-sm",
        "Loading settings…"
      );
      root.appendChild(loading);

      let errBox = null;
      function showErr(msg) {
        if (errBox && errBox.parentNode) errBox.remove();
        errBox = null;
        if (!msg) return;
        errBox = el(
          "p",
          "mb-6 rounded-xl border border-red-200 bg-red-50 px-6 py-4 text-base text-red-800",
          msg
        );
        root.insertBefore(errBox, root.firstChild);
      }

      let userData;
      try {
        userData = await fetchMe(getAuthHeaders);
        if (!userData) return;
      } catch (e) {
        root.textContent = "";
        root.appendChild(
          el(
            "p",
            "rounded-xl border border-red-200 bg-red-50 px-6 py-4 text-base text-red-800",
            e && e.message ? e.message : "Something went wrong."
          )
        );
        return;
      }

      root.textContent = "";
      const wrap = el("div", "space-y-8");

      // Account
      const secAccount = el(
        "section",
        "rounded-2xl border border-gray-200 bg-white p-8 shadow-sm lg:p-10"
      );
      secAccount.setAttribute("aria-labelledby", "settings-account-heading");
      secAccount.appendChild(el("h2", "text-lg font-bold text-gray-900", "Account"));
      secAccount.appendChild(
        el("p", "mt-2 text-base text-gray-600", "Email address for this console session.")
      );
      const emailRow = el("div", "mt-6 rounded-xl border border-gray-200 bg-gray-50 px-5 py-4");
      emailRow.appendChild(el("p", "text-xs font-semibold uppercase tracking-wider text-gray-600", "Email"));
      emailRow.appendChild(el("p", "mt-1 break-all text-base font-medium text-gray-900", userData.email || "—"));
      secAccount.appendChild(emailRow);
      wrap.appendChild(secAccount);

      // API key
      const secKey = el(
        "section",
        "rounded-2xl border border-gray-200 bg-white p-8 shadow-sm lg:p-10"
      );
      secKey.setAttribute("aria-labelledby", "settings-apikey-heading");
      const keyHead = el("div", "flex flex-wrap items-start justify-between gap-4");
      const keyTitles = el("div", "");
      keyTitles.appendChild(el("h2", "text-lg font-bold text-gray-900", "API key"));
      keyTitles.appendChild(
        el(
          "p",
          "mt-2 max-w-xl text-base leading-relaxed text-gray-600",
          "Send as x-api-key on POST /api/scrape. Rotating invalidates the previous key immediately."
        )
      );
      keyHead.appendChild(keyTitles);

      const btnRow = el("div", "flex flex-wrap gap-2");
      const codeEl = el(
        "code",
        "block break-all font-mono text-base text-gray-900",
        userData.api_key || userData.apiKey || "—"
      );
      const copyBtn = el("button", "btn-primary px-6 py-3 text-base font-semibold", "Copy");
      copyBtn.type = "button";

      const rotateBtn = el(
        "button",
        "rounded-lg border border-amber-200 bg-amber-50 px-6 py-3 text-base font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-40",
        "Rotate API Key"
      );
      rotateBtn.type = "button";

      btnRow.appendChild(copyBtn);
      btnRow.appendChild(rotateBtn);
      keyHead.appendChild(btnRow);
      secKey.appendChild(keyHead);

      const keyBox = el("div", "mt-6 rounded-xl border border-gray-200 bg-gray-50 p-5");
      keyBox.appendChild(codeEl);
      secKey.appendChild(keyBox);

      const rotateToast = el("p", "mt-3 hidden text-base font-medium text-amber-800", "New key is active.");
      secKey.appendChild(rotateToast);

      copyBtn.onclick = async () => {
        const t = codeEl.textContent || "";
        try {
          await navigator.clipboard.writeText(t);
          copyBtn.textContent = "Copied";
          setTimeout(() => {
            copyBtn.textContent = "Copy";
          }, 2000);
        } catch {
          prompt("Copy:", t);
        }
      };

      rotateBtn.onclick = async () => {
        if (rotateBtn.disabled) return;
        showErr("");
        rotateBtn.disabled = true;
        rotateToast.classList.add("hidden");
        try {
          const r = await fetch("/api/user/rotate-key", {
            method: "POST",
            credentials: "include",
            headers: {
              ...(typeof getAuthHeaders === "function" ? getAuthHeaders() : {}),
              "Content-Type": "application/json",
            },
            body: "{}",
          });
          const data = await r.json().catch(() => ({}));
          if (r.status === 401) {
            window.location.href = "/login";
            return;
          }
          if (!r.ok) {
            showErr(data.error || "Could not rotate key.");
            return;
          }
          const k = data.api_key || data.apiKey;
          if (k) codeEl.textContent = k;
          rotateToast.classList.remove("hidden");
          setTimeout(() => rotateToast.classList.add("hidden"), 4000);
        } catch (e) {
          showErr(e && e.message ? e.message : "Could not rotate key.");
        } finally {
          rotateBtn.disabled = false;
        }
      };

      wrap.appendChild(secKey);

      // Sign out
      const secOut = el(
        "section",
        "rounded-2xl border border-gray-200 bg-white p-8 shadow-sm lg:p-10"
      );
      secOut.appendChild(el("h2", "text-lg font-bold text-gray-900", "Session"));
      secOut.appendChild(
        el("p", "mt-2 text-base text-gray-600", "Sign out of the dashboard on this browser.")
      );
      const signOutBtn = el(
        "button",
        "mt-6 w-full rounded-lg border border-gray-200 bg-white px-8 py-4 text-base font-semibold text-gray-900 shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-800 sm:w-auto sm:px-10",
        "Sign Out"
      );
      signOutBtn.type = "button";
      signOutBtn.onclick = async () => {
        try {
          localStorage.removeItem(jwtKey);
          await fetch("/auth/logout", { method: "POST", credentials: "include" });
        } catch (_) {}
        window.location.href = "/login";
      };
      secOut.appendChild(signOutBtn);
      wrap.appendChild(secOut);

      root.appendChild(wrap);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

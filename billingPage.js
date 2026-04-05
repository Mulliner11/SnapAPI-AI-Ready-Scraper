/**
 * BillingPage — loads `/api/user/plan` and renders current plan + CTA.
 * Usage: SnapapiBillingPage.mount(root, { getAuthHeaders, manageSubscriptionUrl? });
 */
(function (global) {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Full static Tailwind strings (CDN-safe) — light console cards. */
  function planTheme() {
    return {
      card: "rounded-2xl border border-gray-200 bg-white px-8 py-10 shadow-sm lg:px-12 lg:py-12",
      badge:
        "inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] text-gray-700",
      title: "mt-6 text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl",
    };
  }

  function formatExpires(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  async function fetchPlan(getAuthHeaders) {
    const r = await fetch("/api/user/plan", {
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
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || "Could not load billing");
    }
    return r.json();
  }

  function resolveManageUrl(options) {
    const fromOpt = options && options.manageSubscriptionUrl;
    if (fromOpt != null && String(fromOpt).trim() !== "") return String(fromOpt).trim();
    const g = global.SNAPAPI_BILLING_MANAGE_URL;
    if (g != null && String(g).trim() !== "") return String(g).trim();
    return "/checkout";
  }

  global.SnapapiBillingPage = {
    /**
     * @param {HTMLElement} root
     * @param {{ getAuthHeaders?: () => Record<string, string>, manageSubscriptionUrl?: string }} [options]
     */
    async mount(root, options) {
      if (!root) return;
      options = options || {};

      root.textContent = "";
      const loading = el(
        "p",
        "rounded-xl border border-gray-200 bg-white px-6 py-8 text-center text-gray-600 shadow-sm",
        "Loading billing…"
      );
      root.appendChild(loading);

      try {
        const data = await fetchPlan(options.getAuthHeaders);
        if (!data) return;

        root.textContent = "";
        const displayPlan = data.plan || "Free";
        const theme = planTheme();
        const expiresLine = formatExpires(data.expiresAt);
        const manageUrl = resolveManageUrl(options);

        const card = el("section", theme.card);
        card.setAttribute("aria-labelledby", "billing-plan-heading");

        const statusRow = el("div", "flex flex-wrap items-center gap-3");
        statusRow.appendChild(el("span", theme.badge, "Current plan"));
        card.appendChild(statusRow);

        const h2 = el("h2", theme.title, displayPlan + " Plan");
        h2.id = "billing-plan-heading";
        card.appendChild(h2);

        card.appendChild(
          el(
            "p",
            "mt-3 max-w-xl text-base leading-relaxed text-gray-600",
            "This is the subscription tier applied to your API key and console usage."
          )
        );

        const expiresWrap = el(
          "div",
          "mt-8 flex flex-col gap-1 rounded-xl border border-gray-200 bg-gray-50 px-5 py-4"
        );
        expiresWrap.appendChild(
          el("p", "text-xs font-semibold uppercase tracking-wider text-gray-600", "Renewal")
        );
        if (expiresLine) {
          expiresWrap.appendChild(
            el("p", "text-lg font-medium text-gray-900", "Expires on: " + expiresLine)
          );
        } else {
          expiresWrap.appendChild(
            el(
              "p",
              "text-base text-gray-600",
              displayPlan === "Free"
                ? "No paid period — upgrade anytime to unlock higher quotas."
                : "No expiry date on file. If you subscribed recently, it may take a few minutes to appear."
            )
          );
        }
        card.appendChild(expiresWrap);

        const ctaWrap = el("div", "mt-10");
        const a = el(
          "a",
          "btn-primary flex w-full items-center justify-center px-8 py-5 text-center text-lg font-bold sm:py-6 sm:text-xl",
          "Upgrade / Manage Subscription"
        );
        a.href = manageUrl;
        a.rel = "noopener noreferrer";
        if (/^https?:\/\//i.test(manageUrl)) a.target = "_blank";
        ctaWrap.appendChild(a);

        ctaWrap.appendChild(
          el(
            "p",
            "mt-4 text-center text-sm text-gray-600",
            /^https?:\/\//i.test(manageUrl)
              ? "Opens your NOWPayments page in a new tab."
              : "Continue to in-app checkout to pay with crypto via NOWPayments."
          )
        );
        card.appendChild(ctaWrap);

        root.appendChild(card);
      } catch (e) {
        root.textContent = "";
        root.appendChild(
          el(
            "p",
            "rounded-xl border border-red-200 bg-red-50 px-6 py-4 text-base text-red-800",
            e && e.message ? e.message : "Something went wrong."
          )
        );
      }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

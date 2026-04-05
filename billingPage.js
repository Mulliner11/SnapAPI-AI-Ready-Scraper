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

  /** Full static Tailwind strings (CDN-safe). */
  function planTheme(displayPlan) {
    const p = String(displayPlan || "Free");
    if (p === "Agency") {
      return {
        wrap:
          "rounded-2xl p-px bg-gradient-to-br from-fuchsia-500/25 via-violet-500/15 to-indigo-500/20 shadow-[0_0_64px_-12px_rgba(217,70,239,0.28)] ring-1 ring-inset ring-fuchsia-500/30",
        badge:
          "inline-flex items-center rounded-full border border-fuchsia-400/40 bg-fuchsia-500/15 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] text-fuchsia-100",
        title:
          "mt-6 bg-gradient-to-r from-fuchsia-200 via-white to-indigo-200 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl",
      };
    }
    if (p === "Pro") {
      return {
        wrap:
          "rounded-2xl p-px bg-gradient-to-br from-indigo-500/30 via-violet-500/18 to-cyan-500/15 shadow-[0_0_64px_-12px_rgba(99,102,241,0.35)] ring-1 ring-inset ring-indigo-500/35",
        badge:
          "inline-flex items-center rounded-full border border-indigo-400/45 bg-indigo-500/18 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] text-indigo-100",
        title:
          "mt-6 bg-gradient-to-r from-indigo-200 via-white to-violet-200 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl",
      };
    }
    return {
      wrap:
        "rounded-2xl p-px bg-gradient-to-br from-zinc-500/20 via-zinc-600/12 to-zinc-500/18 shadow-console ring-1 ring-inset ring-zinc-500/25",
      badge:
        "inline-flex items-center rounded-full border border-zinc-500/40 bg-zinc-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] text-zinc-300",
      title:
        "mt-6 bg-gradient-to-r from-zinc-50 via-zinc-200 to-zinc-400 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl",
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
        "rounded-xl border border-white/10 bg-zinc-950/50 px-6 py-8 text-center text-zinc-500",
        "Loading billing…"
      );
      root.appendChild(loading);

      try {
        const data = await fetchPlan(options.getAuthHeaders);
        if (!data) return;

        root.textContent = "";
        const displayPlan = data.plan || "Free";
        const theme = planTheme(displayPlan);
        const expiresLine = formatExpires(data.expiresAt);
        const manageUrl = resolveManageUrl(options);

        const wrap = el("div", theme.wrap);
        const card = el(
          "section",
          "relative overflow-hidden rounded-[0.9rem] border border-white/10 bg-zinc-950/95 px-8 py-10 backdrop-blur-sm lg:px-12 lg:py-12"
        );
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
            "mt-3 max-w-xl text-base leading-relaxed text-zinc-500",
            "This is the subscription tier applied to your API key and console usage."
          )
        );

        const expiresWrap = el(
          "div",
          "mt-8 flex flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
        );
        expiresWrap.appendChild(
          el("p", "text-xs font-semibold uppercase tracking-wider text-zinc-500", "Renewal")
        );
        if (expiresLine) {
          expiresWrap.appendChild(
            el("p", "text-lg font-medium text-zinc-100", "Expires on: " + expiresLine)
          );
        } else {
          expiresWrap.appendChild(
            el(
              "p",
              "text-base text-zinc-500",
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
          "flex w-full items-center justify-center rounded-2xl border border-white/15 bg-gradient-to-r from-indigo-600/90 via-violet-600/85 to-fuchsia-600/90 px-8 py-5 text-center text-lg font-bold text-white shadow-lg shadow-indigo-950/40 transition hover:border-white/25 hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 sm:py-6 sm:text-xl",
          "Upgrade / Manage Subscription"
        );
        a.href = manageUrl;
        a.rel = "noopener noreferrer";
        if (/^https?:\/\//i.test(manageUrl)) a.target = "_blank";
        ctaWrap.appendChild(a);

        ctaWrap.appendChild(
          el(
            "p",
            "mt-4 text-center text-sm text-zinc-500",
            /^https?:\/\//i.test(manageUrl)
              ? "Opens your NOWPayments page in a new tab."
              : "Continue to in-app checkout to pay with crypto via NOWPayments."
          )
        );
        card.appendChild(ctaWrap);

        wrap.appendChild(card);
        root.appendChild(wrap);
      } catch (e) {
        root.textContent = "";
        root.appendChild(
          el(
            "p",
            "rounded-xl border border-red-500/35 bg-red-500/10 px-6 py-4 text-base text-red-200",
            e && e.message ? e.message : "Something went wrong."
          )
        );
      }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

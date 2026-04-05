/**
 * LogsPage — fetches `/api/dashboard/request-logs` and renders a Tailwind-styled table.
 * Usage: SnapapiLogsPage.mount(document.getElementById("root"), { getAuthHeaders: () => ({}) });
 */
(function (global) {
  const EMPTY_MESSAGE = "No API calls yet. Start scraping to see your history!";

  function statusBadgeClass(code) {
    const c = Number(code);
    if (c >= 200 && c < 300) return "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25";
    if (c === 404) return "bg-amber-500/15 text-amber-200 ring-amber-500/25";
    if (c >= 400 && c < 500) return "bg-orange-500/15 text-orange-200 ring-orange-500/20";
    if (c >= 500) return "bg-red-500/15 text-red-300 ring-red-500/25";
    return "bg-zinc-500/15 text-zinc-300 ring-zinc-500/20";
  }

  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return "—";
    const n = Math.trunc(Number(ms));
    if (n < 1000) return n + " ms";
    return (n / 1000).toFixed(n >= 10000 ? 0 : 2) + " s";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  async function fetchLogs(getAuthHeaders) {
    const r = await fetch("/api/dashboard/request-logs", {
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
      throw new Error(d.error || "Could not load request logs");
    }
    return r.json();
  }

  function renderEmpty() {
    const wrap = el("div", "rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-8 py-16 text-center");
    wrap.appendChild(el("p", "text-base text-zinc-400", EMPTY_MESSAGE));
    return wrap;
  }

  function renderTable(logs) {
    const wrap = el("div", "overflow-x-auto rounded-xl border border-white/10");
    const table = el("table", "w-full min-w-[640px] border-collapse text-left text-base");
    const thead = el("thead", "");
    const hr = el("tr", "border-b border-white/10 bg-zinc-950/80");
    for (const label of ["Time", "URL", "Status", "Duration"]) {
      const th = el("th", "px-5 py-4 text-sm font-bold uppercase tracking-wider text-zinc-500", label);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody", "divide-y divide-white/10 text-zinc-300");
    for (const row of logs) {
      const tr = el("tr", "bg-zinc-950/40");
      const tdTime = el("td", "whitespace-nowrap px-5 py-4 text-sm text-zinc-500");
      const created = row.createdAt ? new Date(row.createdAt) : null;
      tdTime.textContent = created && !isNaN(created.getTime()) ? created.toLocaleString() : "—";

      const tdUrl = el("td", "max-w-0 px-5 py-4");
      const urlSpan = el("span", "block truncate font-mono text-sm text-zinc-400", row.url || "—");
      urlSpan.title = row.url || "";
      tdUrl.appendChild(urlSpan);

      const tdStatus = el("td", "whitespace-nowrap px-5 py-4");
      const badge = el(
        "span",
        "inline-flex min-w-[2.75rem] items-center justify-center rounded-lg px-2.5 py-1 font-mono text-sm font-semibold ring-1 " +
          statusBadgeClass(row.status)
      );
      badge.textContent = row.status != null ? String(row.status) : "—";
      tdStatus.appendChild(badge);

      const tdDur = el(
        "td",
        "whitespace-nowrap px-5 py-4 font-mono text-sm tabular-nums text-zinc-400",
        formatDuration(row.duration)
      );

      tr.appendChild(tdTime);
      tr.appendChild(tdUrl);
      tr.appendChild(tdStatus);
      tr.appendChild(tdDur);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  global.SnapapiLogsPage = {
    EMPTY_MESSAGE: EMPTY_MESSAGE,

    /**
     * @param {HTMLElement} root
     * @param {{ getAuthHeaders?: () => Record<string, string> }} [options]
     */
    async mount(root, options) {
      if (!root) return;
      options = options || {};
      const getAuthHeaders = options.getAuthHeaders;

      root.textContent = "";
      const loading = el("p", "rounded-xl border border-white/10 bg-zinc-950/50 px-6 py-8 text-center text-zinc-500", "Loading…");
      root.appendChild(loading);

      try {
        const data = await fetchLogs(getAuthHeaders);
        if (!data) return;
        root.textContent = "";
        const logs = Array.isArray(data.logs) ? data.logs : [];

        const section = el("section", "rounded-2xl border border-white/12 bg-white/[0.02] p-8 shadow-console backdrop-blur-sm lg:p-10");
        section.setAttribute("aria-labelledby", "request-logs-heading");

        const head = el("div", "mb-8");
        head.appendChild(el("h2", "text-lg font-bold text-white", "Request log"));
        head.appendChild(
          el("p", "mt-2 text-base text-zinc-500", "Last 20 API calls recorded for your account.")
        );
        section.appendChild(head);

        if (logs.length === 0) section.appendChild(renderEmpty());
        else section.appendChild(renderTable(logs));

        root.appendChild(section);
      } catch (e) {
        root.textContent = "";
        const errBox = el(
          "p",
          "rounded-xl border border-red-500/35 bg-red-500/10 px-6 py-4 text-base text-red-200",
          e && e.message ? e.message : "Something went wrong."
        );
        root.appendChild(errBox);
      }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

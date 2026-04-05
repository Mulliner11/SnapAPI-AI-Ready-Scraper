/**
 * LogsPage — fetches `/api/dashboard/request-logs` and renders a Tailwind-styled table.
 * Usage: SnapapiLogsPage.mount(document.getElementById("root"), { getAuthHeaders: () => ({}) });
 */
(function (global) {
  const EMPTY_MESSAGE = "No API calls yet. Start scraping to see your history!";

  function statusBadgeClass(code) {
    const c = Number(code);
    if (c >= 200 && c < 300) return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    if (c === 404) return "bg-amber-50 text-amber-800 ring-amber-200";
    if (c >= 400 && c < 500) return "bg-orange-50 text-orange-800 ring-orange-200";
    if (c >= 500) return "bg-red-50 text-red-800 ring-red-200";
    return "bg-gray-100 text-gray-800 ring-gray-200";
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
    const wrap = el("div", "rounded-xl border border-dashed border-gray-200 bg-gray-50 px-8 py-16 text-center");
    wrap.appendChild(el("p", "text-base text-gray-600", EMPTY_MESSAGE));
    return wrap;
  }

  function renderTable(logs) {
    const wrap = el("div", "overflow-x-auto rounded-xl border border-gray-200");
    const table = el("table", "w-full min-w-[640px] border-collapse text-left text-base");
    const thead = el("thead", "");
    const hr = el("tr", "border-b border-gray-200 bg-gray-50");
    for (const label of ["Time", "URL", "Status", "Duration"]) {
      const th = el("th", "px-5 py-4 text-sm font-bold uppercase tracking-wider text-gray-600", label);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody", "divide-y divide-gray-100 text-gray-600");
    for (const row of logs) {
      const tr = el("tr", "bg-white");
      const tdTime = el("td", "whitespace-nowrap px-5 py-4 text-sm text-gray-600");
      const created = row.createdAt ? new Date(row.createdAt) : null;
      tdTime.textContent = created && !isNaN(created.getTime()) ? created.toLocaleString() : "—";

      const tdUrl = el("td", "max-w-0 px-5 py-4");
      const urlSpan = el("span", "block truncate font-mono text-sm text-gray-600", row.url || "—");
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
        "whitespace-nowrap px-5 py-4 font-mono text-sm tabular-nums text-gray-600",
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
      const loading = el(
        "p",
        "rounded-xl border border-gray-200 bg-white px-6 py-8 text-center text-gray-600 shadow-sm",
        "Loading…"
      );
      root.appendChild(loading);

      try {
        const data = await fetchLogs(getAuthHeaders);
        if (!data) return;
        root.textContent = "";
        const logs = Array.isArray(data.logs) ? data.logs : [];

        const section = el("section", "rounded-2xl border border-gray-200 bg-white p-8 shadow-sm lg:p-10");
        section.setAttribute("aria-labelledby", "request-logs-heading");

        const head = el("div", "mb-8");
        head.appendChild(el("h2", "text-lg font-bold text-gray-900", "Request log"));
        head.appendChild(
          el("p", "mt-2 text-base text-gray-600", "Last 20 API calls recorded for your account.")
        );
        section.appendChild(head);

        if (logs.length === 0) section.appendChild(renderEmpty());
        else section.appendChild(renderTable(logs));

        root.appendChild(section);
      } catch (e) {
        root.textContent = "";
        const errBox = el(
          "p",
          "rounded-xl border border-red-200 bg-red-50 px-6 py-4 text-base text-red-800",
          e && e.message ? e.message : "Something went wrong."
        );
        root.appendChild(errBox);
      }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

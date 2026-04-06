import "./public/globals.css";
import React from "react";

/**
 * Landing: Hero + Pricing using the same Vercel/Linear-style Tailwind as the static hero
 * (white surface, gray-900 headings, gray-600/700 secondary, dark: variants).
 */
export default function IndexPage() {
  return (
    <div className="ds-root min-h-screen bg-white font-sans text-gray-900 antialiased dark:bg-black dark:text-gray-100">
      {/* Hero — matches index.html hero section classes */}
      <section className="border-b border-gray-200 bg-white dark:border-white/10 dark:bg-zinc-950">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
          <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16 xl:gap-20">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-600 dark:text-gray-400">
                WEB INTELLIGENCE API
              </p>
              <h1 className="mt-5 text-4xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-5xl sm:leading-[1.05] lg:text-[3.25rem] lg:leading-[1.05]">
                <span>Clean data for your </span>
                <span className="text-blue-600 dark:text-blue-400">AI stack</span>
                <span>.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-gray-700 dark:text-gray-300">
                Turn any URL into structured Markdown and JSON. 90% less noise than raw HTML. Built-in MCP for Claude and
                Cursor.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-4">
                <a
                  href="/login"
                  className="inline-flex items-center justify-center rounded-xl bg-gray-900 px-8 py-3.5 text-sm font-semibold text-white shadow-lg transition hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-zinc-200"
                >
                  Start free
                </a>
                <a
                  href="/docs"
                  className="text-sm font-semibold text-gray-600 underline-offset-4 transition hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-white"
                >
                  Read the docs
                </a>
              </div>
            </div>
            <div className="min-w-0" aria-label="Live stats">
              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-zinc-900/80 sm:p-8">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-gray-600 dark:text-gray-400">
                    LIVE STATS
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                    <span>All systems normal</span>
                  </span>
                </div>
                <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4">
                  {[
                    ["94%", "Token reduction avg"],
                    ["38ms", "Median latency"],
                    ["99.9%", "Uptime (30d)"],
                    ["1 POST", "To get started"],
                  ].map(([v, l]) => (
                    <div
                      key={l}
                      className="rounded-xl border border-gray-100 bg-gray-50/80 p-4 dark:border-white/10 dark:bg-white/[0.03]"
                    >
                      <p className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{v}</p>
                      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{l}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing — same shell + typography rhythm as hero (max-w-7xl, px-4 sm:px-6 lg:px-8, light table) */}
      <section id="pricing" className="scroll-mt-24 border-t border-gray-200 bg-white py-16 dark:border-white/20 dark:bg-black md:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.22em] text-gray-600 dark:text-gray-400">
              Plans
            </span>
            <div
              className="h-px flex-1 bg-gradient-to-r from-gray-200 via-gray-100 to-transparent dark:from-white/20 dark:via-white/10"
              aria-hidden="true"
            />
          </div>
          <h2 id="pricing-heading" className="text-2xl font-bold tracking-tight text-gray-900 md:text-3xl dark:text-white">
            Pricing
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            Three tiers: free to try, production-grade Pro, and Business for teams. All paid plans bill monthly via NOWPayments
            (300+ cryptocurrencies).
          </p>

          <div className="mt-8 overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm ring-1 ring-black/[0.04] dark:border-white/10 dark:bg-zinc-950 dark:ring-white/[0.06]">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/[0.04]">
                  <th
                    scope="col"
                    className="sticky left-0 z-20 w-[28%] min-w-[140px] border-r border-gray-200 bg-gray-50 px-4 py-4 text-xs font-semibold uppercase tracking-wider text-gray-600 backdrop-blur-sm dark:border-white/10 dark:bg-zinc-950 dark:text-gray-400"
                  >
                    Compare
                  </th>
                  <th scope="col" className="px-4 py-4 align-bottom text-base font-bold text-gray-900 dark:text-white">
                    Free
                  </th>
                  <th
                    scope="col"
                    className="relative overflow-hidden border-x border-gray-200 bg-gray-100/80 px-4 pb-4 pt-5 align-bottom text-base font-bold text-gray-900 dark:border-white/10 dark:bg-indigo-500/10 dark:text-white"
                  >
                    <span
                      className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-indigo-500 to-violet-500"
                      aria-hidden="true"
                    />
                    <span className="absolute right-3 top-3 rounded-full bg-gray-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white dark:bg-indigo-500">
                      Popular
                    </span>
                    Pro
                  </th>
                  <th
                    scope="col"
                    className="relative overflow-hidden px-4 pb-4 pt-5 align-bottom text-base font-bold text-gray-900 dark:bg-fuchsia-500/10 dark:text-white"
                  >
                    <span
                      className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-fuchsia-500 to-pink-500"
                      aria-hidden="true"
                    />
                    <span className="absolute right-3 top-3 rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white dark:bg-fuchsia-600">
                      Teams
                    </span>
                    Business
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white dark:divide-white/10 dark:bg-zinc-950/80">
                <tr className="hover:bg-gray-50/80 dark:hover:bg-white/[0.02]">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-r border-gray-200 bg-white px-4 py-3.5 text-xs font-medium uppercase tracking-wide text-gray-600 backdrop-blur-sm dark:border-white/10 dark:bg-zinc-950 dark:text-gray-400"
                  >
                    Price
                  </th>
                  <td className="px-4 py-3.5 text-gray-800 dark:text-gray-200">
                    $0<span className="text-gray-500 dark:text-gray-500"> / mo</span>
                  </td>
                  <td className="border-x border-gray-200 bg-gray-50/90 px-4 py-3.5 font-medium text-gray-900 dark:border-white/10 dark:bg-indigo-500/[0.08] dark:text-white">
                    $29<span className="font-normal text-gray-600 dark:text-indigo-200/80"> / mo</span>
                  </td>
                  <td className="bg-gray-50/50 px-4 py-3.5 font-medium text-gray-900 dark:bg-fuchsia-500/[0.08] dark:text-white">
                    $89<span className="font-normal text-gray-600 dark:text-fuchsia-200/85"> / mo</span>
                  </td>
                </tr>
                <tr className="hover:bg-gray-50/80 dark:hover:bg-white/[0.02]">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-r border-gray-200 bg-white px-4 py-3.5 text-xs font-medium uppercase tracking-wide text-gray-600 backdrop-blur-sm dark:border-white/10 dark:bg-zinc-950 dark:text-gray-400"
                  >
                    Scrape calls / mo
                  </th>
                  <td className="px-4 py-3.5 text-gray-700 dark:text-gray-300">
                    <span className="font-semibold text-gray-900 dark:text-white">200</span>
                  </td>
                  <td className="border-x border-gray-200 bg-gray-50/90 px-4 py-3.5 text-gray-700 dark:border-white/10 dark:bg-indigo-500/[0.08] dark:text-gray-200">
                    <span className="font-semibold text-gray-900 dark:text-white">5,000</span>
                  </td>
                  <td className="bg-gray-50/50 px-4 py-3.5 text-gray-700 dark:bg-fuchsia-500/[0.08] dark:text-gray-200">
                    <span className="font-semibold text-gray-900 dark:text-white">50,000</span>
                  </td>
                </tr>
                <tr className="hover:bg-gray-50/80 dark:hover:bg-white/[0.02]">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-r border-gray-200 bg-white px-4 py-3.5 text-xs font-medium uppercase tracking-wide text-gray-600 backdrop-blur-sm dark:border-white/10 dark:bg-zinc-950 dark:text-gray-400"
                  >
                    Best for
                  </th>
                  <td className="px-4 py-3.5 text-gray-600 dark:text-gray-400">Trying the API &amp; light workflows</td>
                  <td className="border-x border-gray-200 bg-gray-50/90 px-4 py-3.5 text-gray-700 dark:border-white/10 dark:bg-indigo-500/[0.08] dark:text-gray-300">
                    Production apps, agents &amp; full feature access
                  </td>
                  <td className="bg-gray-50/50 px-4 py-3.5 text-gray-700 dark:bg-fuchsia-500/[0.08] dark:text-gray-300">
                    Teams, higher volume &amp; priority support
                  </td>
                </tr>
                <tr className="border-t border-gray-200 bg-gray-50/50 dark:border-white/10 dark:bg-white/[0.02]">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-r border-gray-200 bg-white px-4 py-4 backdrop-blur-sm dark:border-white/10 dark:bg-zinc-950"
                  />
                  <td className="px-4 py-4 align-top">
                    <a
                      href="/login"
                      className="inline-flex w-full min-w-[7rem] items-center justify-center rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-center text-xs font-medium text-gray-900 transition hover:bg-gray-50 dark:border-white/15 dark:bg-transparent dark:text-gray-100 dark:hover:bg-white/10"
                    >
                      Get started
                    </a>
                  </td>
                  <td className="border-x border-gray-200 bg-gray-100/80 px-4 py-4 align-top dark:border-white/10 dark:bg-indigo-500/15">
                    <a
                      href="/checkout?plan=pro"
                      className="inline-flex w-full min-w-[7rem] items-center justify-center rounded-lg bg-gray-900 px-3 py-2.5 text-center text-xs font-semibold text-white transition hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
                    >
                      Subscribe
                    </a>
                  </td>
                  <td className="bg-gray-50 px-4 py-4 align-top dark:bg-fuchsia-500/15">
                    <a
                      href="/checkout?plan=business"
                      className="inline-flex w-full min-w-[7rem] items-center justify-center rounded-lg border border-gray-900 bg-gray-900 px-3 py-2.5 text-center text-xs font-semibold text-white transition hover:bg-gray-800 dark:border-white dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
                    >
                      Subscribe
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
            <em>Cheaper than building and maintaining your own scraper.</em>
          </p>
          <p className="mt-3 text-center text-xs text-gray-500 dark:text-gray-500">
            Powered by NOWPayments. We accept 300+ cryptocurrencies.
          </p>
        </div>
      </section>
    </div>
  );
}

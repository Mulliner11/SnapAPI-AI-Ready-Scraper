/**
 * Shared "Payment confirmation" dialog before redirecting to NOWPayments or checkout.
 * Exposes: window.snapapiOpenPaymentConfirmation(onContinue)
 */
(function () {
  const SUPPORT_EMAIL = "support@getsnapapi.uk";

  function closeModal(root) {
    root.classList.add("hidden");
    root.setAttribute("aria-hidden", "true");
    document.body.classList.remove("overflow-hidden");
  }

  function openModal(root) {
    root.classList.remove("hidden");
    root.setAttribute("aria-hidden", "false");
    document.body.classList.add("overflow-hidden");
  }

  function ensureModal() {
    let root = document.getElementById("snapapi-payment-confirm-root");
    if (root) return root;

    root = document.createElement("div");
    root.id = "snapapi-payment-confirm-root";
    root.className =
      "hidden fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6";
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "snapapi-pc-title");

    root.innerHTML =
      '<div class="snapapi-pc-backdrop absolute inset-0 bg-black/75 backdrop-blur-sm" data-pc-close tabindex="-1"></div>' +
      '<div class="relative z-10 w-full max-w-md rounded-2xl border border-white/20 bg-slate-950 p-6 shadow-2xl shadow-indigo-950/50 ring-1 ring-white/10 sm:p-8">' +
      '<h2 id="snapapi-pc-title" class="text-xl font-bold tracking-tight text-white">Payment confirmation</h2>' +
      '<p class="mt-3 text-sm leading-relaxed text-slate-300">' +
      "You&rsquo;re about to continue to our payment partner (NOWPayments). " +
      '<strong class="font-semibold text-white">300+ cryptocurrencies</strong> are supported.</p>' +
      '<ul class="mt-4 list-none space-y-3 text-sm text-slate-400">' +
      '<li class="flex gap-2"><span class="shrink-0 text-indigo-400" aria-hidden="true">→</span>' +
      "<span>After your payment confirms on-chain, your plan usually activates automatically within <strong class=\"text-slate-200\">2–5 minutes</strong>.</span></li>" +
      '<li class="flex gap-2"><span class="shrink-0 text-indigo-400" aria-hidden="true">→</span>' +
      "<span>Need help? Email <a class=\"font-medium text-indigo-300 underline decoration-indigo-400/50 underline-offset-2 hover:text-indigo-200\" href=\"mailto:" +
      SUPPORT_EMAIL +
      "\">" +
      SUPPORT_EMAIL +
      "</a>.</span></li>" +
      "</ul>" +
      '<div class="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap">' +
      '<button type="button" class="snapapi-pc-cancel inline-flex flex-1 min-h-[48px] min-w-[8rem] items-center justify-center rounded-xl border border-white/20 bg-white/5 px-5 py-3.5 text-sm font-medium text-slate-200 transition hover:bg-white/10">Cancel</button>' +
      '<button type="button" class="snapapi-pc-continue inline-flex flex-1 min-h-[48px] min-w-[8rem] items-center justify-center rounded-xl border border-indigo-400/50 bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/40 transition hover:brightness-110">Continue</button>' +
      "</div>" +
      "</div>";

    document.body.appendChild(root);

    root.addEventListener("click", function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute("data-pc-close") != null) {
        closeModal(root);
      }
    });
    root.querySelector(".snapapi-pc-cancel").addEventListener("click", function () {
      closeModal(root);
    });

    return root;
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var root = document.getElementById("snapapi-payment-confirm-root");
    if (!root || root.classList.contains("hidden")) return;
    closeModal(root);
  });

  window.snapapiOpenPaymentConfirmation = function (onContinue) {
    var root = ensureModal();
    var continueBtn = root.querySelector(".snapapi-pc-continue");
    continueBtn.onclick = function () {
      closeModal(root);
      continueBtn.onclick = null;
      if (typeof onContinue !== "function") return;
      try {
        var r = onContinue();
        if (r && typeof r.then === "function") {
          r.catch(function () {});
        }
      } catch (_) {}
    };
    openModal(root);
    continueBtn.focus();
  };
})();

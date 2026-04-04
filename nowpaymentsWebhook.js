/**
 * POST /webhooks/nowpayments and POST /api/webhooks/nowpayments — NOWPayments IPN callback.
 * Verifies `x-nowpayments-sig` (when enabled below). On payment_status === finished, updates Order + Prisma User
 * and syncs legacy `users` (dashboard / scrape quota).
 */
import { getPool, upgradeUserSubscriptionByEmail } from "./db.js";
import { prisma } from "./prismaClient.js";
import { computeNpIpnSignatureHex, verifyNowPaymentsIpnSignature } from "./nowpaymentsIpn.js";

/** Set to false to re-enable HMAC verification before production. */
const NP_IPN_SKIP_SIGNATURE_VERIFY = true;

function getNpIpnSecret() {
  return String(process.env.NP_IPN_SECRET ?? process.env.NOWPAYMENTS_IPN_SECRET ?? "").trim();
}
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
/** Verified in Resend; fixed address avoids 422 Invalid `from`. */
const RESEND_FROM = "SnapAPI <support@getsnapapi.uk>";

function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/**
 * Collect possible ids NOWPayments may send; we store invoice `id` as Order.paymentId.
 * `order_id` is preferred — it matches the `order_id` we send when creating the invoice (`orderRef`).
 */
function extractPaymentIdCandidates(payload) {
  const keys = ["order_id", "orderId", "payment_id", "invoice_id", "paymentId", "paymentID"];
  const out = [];
  for (const k of keys) {
    const v = payload?.[k];
    if (v != null && String(v).trim() !== "") out.push(String(v).trim());
  }
  return [...new Set(out)];
}

function normalizePlan(planType) {
  const p = String(planType || "").toLowerCase();
  if (p === "agency") return "agency";
  if (p === "business") return "business";
  return "pro";
}

async function sendApiKeyActivatedEmail(to, apiKey) {
  if (!RESEND_API_KEY) {
    console.warn(`[SnapAPI] RESEND_API_KEY not set; skipping activation email to ${to}`);
    return;
  }
  const safeKey = escapeHtmlText(apiKey);
  const dash = escapeHtmlText((process.env.PUBLIC_APP_URL || "https://getsnapapi.uk").replace(/\/$/, ""));
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to.trim()],
      subject: "Your SnapAPI API key is active",
      html: `<p>Your payment was received. Your API key is now active for your subscription period.</p>
        <p><strong>API key</strong> (keep it secret):</p>
        <pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;word-break:break-all;">${safeKey}</pre>
        <p><a href="${dash}/dashboard">Open dashboard</a></p>
        <p style="color:#64748b;font-size:12px;">付款已确认，您的 API Key 已激活，可在上方复制使用。</p>`,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Resend failed: ${res.status} ${t}`);
  }
}

/**
 * POST /webhooks/nowpayments — raw JSON body, verify x-nowpayments-sig, Prisma Order/User updates.
 */
export async function postNowpaymentsWebhook(request, reply) {
  console.log("WEBHOOK_HIT", request.body);

  const rawBody = request.body;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? "");

  if (!buf.length) {
    console.log("Incoming Webhook Body:", "{}");
    return reply.code(400).send({ error: "Empty body" });
  }

  try {
    console.log("Incoming Webhook Body:", JSON.stringify(JSON.parse(buf.toString("utf8"))));
  } catch {
    console.log("Incoming Webhook Body:", buf.toString("utf8"));
  }

  const isSandbox = String(process.env.NP_ENV ?? "").trim().toLowerCase() === "sandbox";
  const ipnSecret = getNpIpnSecret();
  const rawSig = request.headers["x-nowpayments-sig"];
  const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
  const sigStr = sig != null ? String(sig).trim() : "";

  if (NP_IPN_SKIP_SIGNATURE_VERIFY) {
    console.warn("[NP IPN] HMAC signature verification SKIPPED (NP_IPN_SKIP_SIGNATURE_VERIFY=true — re-enable for production)");
    if (ipnSecret) {
      const { expectedHex } = computeNpIpnSignatureHex(buf, ipnSecret);
      console.log("[NP IPN] x-nowpayments-sig (received):", sigStr || "(missing header)");
      console.log("[NP IPN] x-nowpayments-sig (computed):", expectedHex ?? "(parse failed)");
    }
  } else if (!isSandbox) {
    if (!ipnSecret) {
      request.log.error("[NP IPN] NP_IPN_SECRET (or NOWPAYMENTS_IPN_SECRET) is not set");
      return reply.code(503).send({ error: "IPN secret not configured" });
    }
    if (!sigStr) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { expectedHex } = computeNpIpnSignatureHex(buf, ipnSecret);
    console.log("[NP IPN] x-nowpayments-sig (received):", sigStr);
    console.log("[NP IPN] x-nowpayments-sig (computed):", expectedHex ?? "(parse failed)");
    if (!verifyNowPaymentsIpnSignature(buf, sigStr, ipnSecret)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  } else {
    console.warn("[NP IPN] SANDBOX: NP_ENV=sandbox — using relaxed path");
    if (ipnSecret) {
      const { expectedHex } = computeNpIpnSignatureHex(buf, ipnSecret);
      console.log("[NP IPN] x-nowpayments-sig (received):", sigStr || "(missing header)");
      console.log("[NP IPN] x-nowpayments-sig (computed):", expectedHex ?? "(parse failed)");
    }
  }

  let payload;
  try {
    payload = JSON.parse(buf.toString("utf8"));
  } catch {
    return reply.code(400).send({ error: "Invalid JSON" });
  }

  const paymentStatus = String(payload?.payment_status ?? "").toLowerCase();
  if (paymentStatus !== "finished") {
    return reply.send({ ok: true });
  }

  const ids = extractPaymentIdCandidates(payload);
  if (ids.length === 0) {
    request.log.warn({ keys: Object.keys(payload) }, "[NP IPN] finished but no id fields to match Order");
    return reply.send({ ok: true });
  }

  const orderIdRaw = payload?.order_id ?? payload?.orderId;
  const orderId = orderIdRaw != null ? String(orderIdRaw).trim() : "";

  console.log("[NP IPN] order_id from payload:", orderId || "(none)", "| id candidates:", ids);

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      let pending = null;
      if (orderId) {
        pending = await tx.order.findFirst({
          where: { status: "pending", orderRef: orderId },
          include: { user: true },
        });
        console.log(
          "[NP IPN] DB lookup by orderRef=",
          JSON.stringify(orderId),
          "status=pending →",
          pending ? `found order id=${pending.id}` : "NO MATCH"
        );
      }
      if (!pending) {
        pending = await tx.order.findFirst({
          where: {
            status: "pending",
            OR: [{ paymentId: { in: ids } }, { orderRef: { in: ids } }],
          },
          include: { user: true },
        });
        console.log(
          "[NP IPN] DB fallback lookup paymentId/orderRef in",
          JSON.stringify(ids),
          "→",
          pending ? `found order id=${pending.id}` : "NO MATCH"
        );
      }

      if (pending) {
        const plan = normalizePlan(pending.planType);
        const expiresAt = new Date();
        expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);

        await tx.order.update({
          where: { id: pending.id },
          data: { status: "finished" },
        });

        await tx.user.update({
          where: { id: pending.userId },
          data: { plan, expiresAt },
        });

        const user = await tx.user.findUnique({ where: { id: pending.userId } });
        return { type: "activated", user };
      }

      const any = await tx.order.findFirst({
        where: { OR: [{ paymentId: { in: ids } }, { orderRef: { in: ids } }] },
      });
      if (any?.status === "finished") {
        return { type: "already_done" };
      }
      return { type: "not_found" };
    });
  } catch (e) {
    request.log.error(e, "[NP IPN] prisma transaction failed");
    return reply.code(500).send({ error: "Database error" });
  }

  if (outcome.type === "not_found") {
    request.log.warn({ ids }, "[NP IPN] no pending order matching payment ids");
    return reply.send({ ok: true });
  }

  if (outcome.type === "already_done") {
    return reply.send({ ok: true });
  }

  /** Dashboard + /api/scrape quotas read legacy `users`; keep in sync with Prisma app_users.plan */
  try {
    if (getPool()) {
      await upgradeUserSubscriptionByEmail(outcome.user.email, outcome.user.plan);
    }
  } catch (e) {
    request.log.error(e, "[NP IPN] upgradeUserSubscriptionByEmail (legacy users) failed — Prisma was updated");
  }

  try {
    await sendApiKeyActivatedEmail(outcome.user.email, outcome.user.apiKey);
  } catch (e) {
    request.log.error(e, "[NP IPN] activation email failed (subscription was applied)");
  }

  return reply.code(200).send({
    ok: true,
    email: outcome.user.email,
    plan: outcome.user.plan,
  });
}

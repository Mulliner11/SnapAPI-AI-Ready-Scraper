/**
 * POST /webhooks/nowpayments — NOWPayments IPN callback.
 * Verifies `x-nowpayments-sig` (HMAC-SHA512 over sorted JSON body, see nowpaymentsIpn.js).
 * On payment_status === finished, marks Order finished and upgrades Prisma User plan.
 */
import { prisma } from "./prismaClient.js";
import { verifyNowPaymentsIpnSignature } from "./nowpaymentsIpn.js";

const NOWPAYMENTS_IPN_SECRET = String(process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
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
 * Includes `order_id` when NP echoes our custom `order_id` from invoice creation.
 */
function extractPaymentIdCandidates(payload) {
  const keys = ["payment_id", "invoice_id", "paymentId", "paymentID", "order_id", "orderId"];
  const out = [];
  for (const k of keys) {
    const v = payload?.[k];
    if (v != null && String(v).trim() !== "") out.push(String(v).trim());
  }
  return [...new Set(out)];
}

function normalizePlan(planType) {
  const p = String(planType || "").toLowerCase();
  return p === "business" ? "business" : "pro";
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
  const rawSig = request.headers["x-nowpayments-sig"];
  const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
  if (!sig) {
    return reply.code(403).send({ error: "Missing x-nowpayments-sig" });
  }

  const rawBody = request.body;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? "");
  if (!buf.length) {
    return reply.code(400).send({ error: "Empty body" });
  }

  if (!verifyNowPaymentsIpnSignature(buf, sig, NOWPAYMENTS_IPN_SECRET)) {
    return reply.code(403).send({ error: "Invalid signature" });
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

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const pending = await tx.order.findFirst({
        where: {
          status: "pending",
          OR: [{ paymentId: { in: ids } }, { orderRef: { in: ids } }],
        },
        include: { user: true },
      });

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

  try {
    await sendApiKeyActivatedEmail(outcome.user.email, outcome.user.apiKey);
  } catch (e) {
    request.log.error(e, "[NP IPN] activation email failed (subscription was applied)");
  }

  return reply.send({
    ok: true,
    email: outcome.user.email,
    plan: outcome.user.plan,
  });
}

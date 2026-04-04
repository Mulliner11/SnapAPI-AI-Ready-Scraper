/**
 * POST /webhooks/nowpayments and POST /api/webhooks/nowpayments — NOWPayments IPN.
 * Requires fastify-raw-body on these routes (request.rawBody = Buffer).
 * Verifies x-nowpayments-sig = HMAC-SHA512(NP_IPN_SECRET, raw UTF-8 body bytes), hex.
 * If payment_status === finished, resolves Order by order_id / orderRef and upgrades plan (pro/business) + expiry.
 */
import { getPool, upgradeUserSubscriptionByEmail } from "./db.js";
import { prisma } from "./prismaClient.js";
import {
  computeNpIpnSignatureHex,
  computeRawIpnBodyHmacSha512Hex,
  verifyNowPaymentsIpnRawBody,
  verifyNowPaymentsIpnSignature,
} from "./nowpaymentsIpn.js";

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();

function getNpIpnSecret() {
  return String(process.env.NP_IPN_SECRET ?? process.env.NOWPAYMENTS_IPN_SECRET ?? "").trim();
}
/** Verified in Resend; fixed address avoids 422 Invalid `from`. */
const RESEND_FROM = "SnapAPI <support@getsnapapi.uk>";

function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

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
  if (p === "agency") return "business";
  if (p === "business") return "business";
  return "pro";
}

function looksLikeUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || "").trim());
}

function getWebhookBuffer(request) {
  if (Buffer.isBuffer(request.rawBody) && request.rawBody.length > 0) {
    return request.rawBody;
  }
  if (Buffer.isBuffer(request.body) && request.body.length > 0) {
    return request.body;
  }
  return null;
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

export async function postNowpaymentsWebhook(request, reply) {
  console.log("--- WEBHOOK START ---");

  const buf = getWebhookBuffer(request);
  if (!buf) {
    request.log.warn("[NP IPN] missing raw body (enable fastify-raw-body with encoding:false on this route)");
    return reply.code(400).send({ error: "Empty or unreadable body" });
  }

  let payload;
  try {
    payload = JSON.parse(buf.toString("utf8"));
  } catch {
    return reply.code(400).send({ error: "Invalid JSON" });
  }
  if (!payload || typeof payload !== "object") {
    return reply.code(400).send({ error: "Invalid JSON" });
  }

  console.log("BODY:", JSON.stringify(payload, null, 2));

  const ipnSecret = getNpIpnSecret();
  if (!ipnSecret) {
    request.log.error("[NP IPN] NP_IPN_SECRET is not set");
    return reply.code(503).send({ error: "IPN secret not configured" });
  }

  const rawSig = request.headers["x-nowpayments-sig"];
  const sigHeader = Array.isArray(rawSig) ? rawSig[0] : rawSig;
  const receivedSignature = sigHeader != null ? String(sigHeader).trim() : "";

  if (!receivedSignature) {
    console.error("[Webhook Error] Missing Signature");
    request.log.warn("[NP IPN] missing x-nowpayments-sig");
    return reply.code(401).send({ error: "Unauthorized" });
  }

  /** Primary: HMAC-SHA512 over exact raw bytes. Fallback: key-sorted JSON (NP docs vary). */
  let signatureOk = verifyNowPaymentsIpnRawBody(buf, receivedSignature, ipnSecret);
  if (!signatureOk) {
    signatureOk = verifyNowPaymentsIpnSignature(payload, receivedSignature, ipnSecret);
    if (signatureOk) {
      request.log.info("[NP IPN] signature OK (sorted-JSON canonical fallback)");
    }
  }

  if (!signatureOk) {
    console.error("[Webhook Error] Signature mismatch");
    console.error("Expected Signature (raw-body HMAC):", computeRawIpnBodyHmacSha512Hex(buf, ipnSecret) ?? "(n/a)");
    console.error("Expected Signature (sorted-JSON HMAC):", computeNpIpnSignatureHex(payload, ipnSecret).expectedHex ?? "(n/a)");
    console.error("Received Signature:", receivedSignature);
    request.log.warn({ received: receivedSignature }, "[NP IPN] HMAC verification failed");
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const paymentStatus = String(payload?.payment_status ?? "").toLowerCase();
  if (paymentStatus !== "finished") {
    console.log("[NP IPN] skip: payment_status is not finished:", paymentStatus || "(empty)");
    return reply.send({ ok: true });
  }

  const ids = extractPaymentIdCandidates(payload);
  const orderIdRaw = payload?.order_id ?? payload?.orderId;
  const orderIdFromNp = orderIdRaw != null ? String(orderIdRaw).trim() : "";

  console.log("[NP IPN] payment_status=finished | order_id:", orderIdFromNp || "(none)", "| id candidates:", ids);

  if (ids.length === 0 && !orderIdFromNp) {
    request.log.warn({ keys: Object.keys(payload) }, "[NP IPN] finished but no id fields to match Order");
    return reply.send({ ok: true });
  }

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      let match = null;

      if (orderIdFromNp) {
        match = await tx.order.findFirst({
          where: { orderRef: orderIdFromNp },
          include: { user: true },
        });
        console.log(
          "[NP IPN] lookup orderRef=",
          JSON.stringify(orderIdFromNp),
          "→",
          match ? `found order prismaId=${match.id}` : "NO MATCH"
        );
      }

      if (!match && orderIdFromNp && looksLikeUuid(orderIdFromNp)) {
        match = await tx.order.findUnique({
          where: { id: orderIdFromNp },
          include: { user: true },
        });
        console.log(
          "[NP IPN] lookup Prisma Order.id (uuid)=",
          orderIdFromNp,
          "→",
          match ? `found order prismaId=${match.id}` : "NO MATCH"
        );
      }

      if (!match && ids.length > 0) {
        match = await tx.order.findFirst({
          where: {
            OR: [{ paymentId: { in: ids } }, { orderRef: { in: ids } }],
          },
          include: { user: true },
        });
        console.log(
          "[NP IPN] fallback lookup paymentId/orderRef in",
          JSON.stringify(ids),
          "→",
          match ? `found order prismaId=${match.id}` : "NO MATCH"
        );
      }

      if (!match) {
        const any = await tx.order.findFirst({
          where: {
            OR: [
              ...(orderIdFromNp ? [{ orderRef: orderIdFromNp }] : []),
              ...(ids.length ? [{ paymentId: { in: ids } }, { orderRef: { in: ids } }] : []),
            ],
          },
        });
        if (any?.status === "finished") {
          return { type: "already_done", user: null };
        }
        return { type: "not_found", user: null };
      }

      const plan = normalizePlan(match.planType);
      const expiresAt = new Date();
      expiresAt.setUTCDate(expiresAt.getUTCDate() + 30);

      await tx.order.update({
        where: { id: match.id },
        data: { status: "finished" },
      });

      await tx.user.update({
        where: { id: match.userId },
        data: { plan, expiresAt },
      });

      const user = await tx.user.findUnique({ where: { id: match.userId } });
      return { type: "activated", user };
    });
  } catch (e) {
    request.log.error(e, "[NP IPN] prisma transaction failed");
    console.error("[NP IPN] prisma transaction failed:", e);
    return reply.code(500).send({ error: "Database error" });
  }

  if (outcome.type === "not_found") {
    request.log.warn({ ids, orderIdFromNp }, "[NP IPN] no order matching payment / order_id");
    return reply.send({ ok: true });
  }

  if (outcome.type === "already_done") {
    console.log("[NP IPN] order already finished (idempotent skip)");
    return reply.send({ ok: true });
  }

  if (!outcome.user?.id) {
    request.log.error("[NP IPN] activated but user missing");
    return reply.code(500).send({ error: "User missing after update" });
  }

  console.log("PLAN_UPDATED_SUCCESSFULLY_FOR_USER:", outcome.user.id);

  try {
    if (getPool()) {
      await upgradeUserSubscriptionByEmail(outcome.user.email, outcome.user.plan);
    }
  } catch (e) {
    request.log.error(e, "[NP IPN] upgradeUserSubscriptionByEmail (legacy users) failed — Prisma was updated");
    console.error("[NP IPN] legacy users sync failed:", e);
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

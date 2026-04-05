/**
 * POST /webhooks/nowpayments and POST /api/webhooks/nowpayments — NOWPayments IPN.
 * HMAC-SHA512 verification using x-nowpayments-sig header.
 */
import { getPool, upgradeUserSubscriptionByEmail } from "./db.js";
import { prisma } from "./prismaClient.js";
import { verifyNowPaymentsIpnSignature, verifyNowPaymentsIpnRawBody } from "./nowpaymentsIpn.js";

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
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

/** Parsed JSON body (Fastify may already parse; else from raw buffer). */
function parseWebhookPayload(request) {
  if (request.body != null && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  const buf = getWebhookBuffer(request);
  if (!buf || !buf.length) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
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
  console.log("--- WEBHOOK RECEIVED ---", JSON.stringify(request.body, null, 2));

  // HMAC-SHA512 verification
  const signature = request.headers["x-nowpayments-sig"];
  const secret = String(process.env.NP_IPN_SECRET || process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
  
  if (!secret) {
    request.log.warn("[NP IPN] NP_IPN_SECRET/NOWPAYMENTS_IPN_SECRET not set, skipping HMAC verification");
  } else if (!signature) {
    return reply.code(401).send({ error: "Missing x-nowpayments-sig header" });
  } else {
    // Try raw body verification first (preferred)
    const rawBody = getWebhookBuffer(request);
    let verified = false;
    
    if (rawBody && rawBody.length > 0) {
      verified = verifyNowPaymentsIpnRawBody(rawBody, signature, secret);
    }
    
    // If raw body verification fails or raw body not available, try canonical JSON verification
    if (!verified) {
      const payloadForVerification = rawBody && rawBody.length > 0 ? rawBody : request.body;
      verified = verifyNowPaymentsIpnSignature(payloadForVerification, signature, secret);
    }
    
    if (!verified) {
      request.log.warn({ signature, hasRawBody: !!rawBody?.length }, "[NP IPN] HMAC verification failed");
      return reply.code(401).send({ error: "Invalid signature" });
    }
  }

  const payload = parseWebhookPayload(request);
  if (!payload || typeof payload !== "object") {
    return reply.code(400).send({ error: "Invalid or empty JSON body" });
  }

  const paymentStatus = String(payload?.payment_status ?? "").toLowerCase();
  if (paymentStatus !== "finished") {
    return reply.send({ ok: true, skipped: "payment_status not finished" });
  }

  const ids = extractPaymentIdCandidates(payload);
  const orderIdRaw = payload?.order_id ?? payload?.orderId;
  const orderIdFromNp = orderIdRaw != null ? String(orderIdRaw).trim() : "";

  if (ids.length === 0 && !orderIdFromNp) {
    request.log.warn({ keys: Object.keys(payload) }, "[NP IPN] finished but no order/payment id");
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
      }

      if (!match && orderIdFromNp && looksLikeUuid(orderIdFromNp)) {
        match = await tx.order.findUnique({
          where: { id: orderIdFromNp },
          include: { user: true },
        });
      }

      if (!match && ids.length > 0) {
        match = await tx.order.findFirst({
          where: {
            OR: [{ paymentId: { in: ids } }, { orderRef: { in: ids } }],
          },
          include: { user: true },
        });
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
    return reply.send({ ok: true, note: "order not found" });
  }

  if (outcome.type === "already_done") {
    return reply.send({ ok: true, note: "already finished" });
  }

  if (!outcome.user?.id) {
    return reply.code(500).send({ error: "User missing after update" });
  }

  console.log("PLAN_UPDATED_SUCCESSFULLY_FOR_USER:", outcome.user.id, "plan:", outcome.user.plan);

  try {
    if (getPool()) {
      await upgradeUserSubscriptionByEmail(outcome.user.email, outcome.user.plan);
    }
  } catch (e) {
    request.log.error(e, "[NP IPN] legacy users sync failed");
  }

  try {
    await sendApiKeyActivatedEmail(outcome.user.email, outcome.user.apiKey);
  } catch (e) {
    request.log.error(e, "[NP IPN] activation email failed");
  }

  return reply.code(200).send({
    ok: true,
    email: outcome.user.email,
    plan: outcome.user.plan,
  });
}

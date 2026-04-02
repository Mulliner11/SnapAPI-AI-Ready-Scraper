import axios from "axios";
import { prisma } from "./prismaClient.js";

const NP_BASE = (process.env.NP_API_BASE || "https://api.nowpayments.io").replace(/\/$/, "");

function getNpApiKey() {
  return String(process.env.NP_API_KEY || "").trim();
}

function priceUsdForPlan(planType) {
  const pro = Number(process.env.PLAN_PRICE_PRO_USD ?? 29);
  const business = Number(process.env.PLAN_PRICE_BUSINESS_USD ?? 99);
  if (planType === "business") return business;
  return pro;
}

function resolvePlanType(body) {
  const raw = body?.planType ?? body?.plan_type;
  if (raw == null) return null;
  const p = String(raw).toLowerCase();
  if (p === "pro" || p === "business") return p;
  return null;
}

function extractNpErrorMessage(data, status) {
  if (data == null) return `NOWPayments HTTP ${status}`;
  if (typeof data === "string") return data;
  const m = data.message ?? data.error;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.join("; ");
  try {
    return JSON.stringify(data);
  } catch {
    return `NOWPayments HTTP ${status}`;
  }
}

function pickInvoiceUrl(data) {
  if (!data || typeof data !== "object") return null;
  const u =
    data.invoice_url ??
    data.invoiceUrl ??
    data.url ??
    data.payment_url ??
    data.pay_url;
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
}

function pickInvoiceId(data) {
  if (!data || typeof data !== "object") return null;
  const id = data.id ?? data.invoice_id ?? data.invoiceId;
  if (id == null) return null;
  return String(id);
}

/**
 * POST /api/subscribe — create NOWPayments invoice, persist pending Order (Prisma).
 */
export async function postSubscribeHandler(request, reply) {
  const npKey = getNpApiKey();
  if (!npKey) {
    return reply.code(503).send({ error: "NP_API_KEY is not configured" });
  }

  const email = String(request.body?.email ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply.code(400).send({ error: "Invalid email" });
  }

  const planType = resolvePlanType(request.body);
  if (!planType) {
    return reply.code(400).send({ error: "planType must be pro or business (camelCase or plan_type)" });
  }

  const amount = priceUsdForPlan(planType);
  if (!Number.isFinite(amount) || amount <= 0) {
    return reply.code(500).send({ error: "Invalid plan pricing (set PLAN_PRICE_PRO_USD / PLAN_PRICE_BUSINESS_USD)" });
  }

  let user;
  try {
    user = await prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });
  } catch (e) {
    request.log.error(e, "[subscribe] prisma.user.upsert");
    return reply.code(500).send({ error: "Database error while resolving user" });
  }

  const baseUrl = (process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  const successUrl = process.env.NP_SUCCESS_URL || (baseUrl ? `${baseUrl}/success` : undefined);
  const cancelUrl = process.env.NP_CANCEL_URL || (baseUrl ? `${baseUrl}/` : undefined);
  const ipnUrl = process.env.NP_IPN_CALLBACK_URL || process.env.NOWPAYMENTS_IPN_CALLBACK_URL;

  const orderRef = `snapapi-${user.id}-${Date.now()}`;
  const invoiceBody = {
    price_amount: amount,
    price_currency: "usd",
    order_id: orderRef,
    order_description: `SnapAPI ${planType} — ${email}`,
  };
  if (successUrl) invoiceBody.success_url = successUrl;
  if (cancelUrl) invoiceBody.cancel_url = cancelUrl;
  if (ipnUrl) invoiceBody.ipn_callback_url = ipnUrl;
  const payCurrency = String(process.env.NP_PAY_CURRENCY || "").trim();
  if (payCurrency) invoiceBody.pay_currency = payCurrency;

  let npData;
  let npStatus;
  try {
    const res = await axios.post(`${NP_BASE}/v1/invoice`, invoiceBody, {
      headers: {
        "x-api-key": npKey,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
      timeout: 30_000,
    });
    npData = res.data;
    npStatus = res.status;
  } catch (e) {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status ?? 502;
      const msg = extractNpErrorMessage(e.response?.data, status);
      request.log.error({ err: e.message, status, data: e.response?.data }, "[subscribe] NOWPayments axios error");
      return reply.code(status >= 400 && status < 600 ? status : 502).send({ error: msg });
    }
    request.log.error(e, "[subscribe] unexpected error");
    return reply.code(500).send({ error: "Unexpected server error" });
  }

  if (npStatus < 200 || npStatus >= 300) {
    const msg = extractNpErrorMessage(npData, npStatus);
    request.log.warn({ npStatus, npData }, "[subscribe] NOWPayments invoice rejected");
    return reply.code(502).send({ error: msg });
  }

  const paymentId = pickInvoiceId(npData);
  const invoiceUrl = pickInvoiceUrl(npData);
  if (!paymentId || !invoiceUrl) {
    request.log.error({ npData }, "[subscribe] NOWPayments response missing id or invoice_url");
    return reply.code(502).send({ error: "Invalid response from NOWPayments (missing id or invoice_url)" });
  }

  try {
    await prisma.order.create({
      data: {
        userId: user.id,
        amount,
        status: "pending",
        paymentId,
        planType,
      },
    });
  } catch (e) {
    request.log.error(e, "[subscribe] prisma.order.create");
    return reply.code(500).send({ error: "Failed to save order" });
  }

  return reply.send({ invoice_url: invoiceUrl });
}

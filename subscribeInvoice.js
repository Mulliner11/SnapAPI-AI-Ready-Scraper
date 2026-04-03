import axios from "axios";
import { prisma } from "./prismaClient.js";

const NP_BASE = (process.env.NP_API_BASE || "https://api.nowpayments.io").replace(/\/$/, "");

export function getNpApiKey() {
  return String(process.env.NP_API_KEY || "").trim();
}

export function priceUsdForPlan(planType) {
  const pro = Number(process.env.PLAN_PRICE_PRO_USD ?? 9);
  const business = Number(process.env.PLAN_PRICE_BUSINESS_USD ?? 29);
  const agency = Number(process.env.PLAN_PRICE_AGENCY_USD ?? 99);
  if (planType === "agency") return agency;
  if (planType === "business") return business;
  return pro;
}

export function resolvePlanType(body) {
  const raw = body?.planType ?? body?.plan_type ?? body?.plan;
  if (raw == null) return null;
  const p = String(raw).toLowerCase();
  if (p === "pro" || p === "business" || p === "agency") return p;
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
 * Call NOWPayments invoice API and persist a pending Order (userId = Prisma app_users.id).
 * @param {{ id: string }} prismaUser
 * @param {string} email
 * @param {'pro'|'business'|'agency'} planType
 * @param {import('fastify').FastifyBaseLogger} log
 * @returns {Promise<{ ok: true, invoice_url: string } | { ok: false, statusCode: number, error: string }>}
 */
export async function createNowpaymentsInvoiceAndOrder({ prismaUser, email, planType, log }) {
  const npKey = getNpApiKey();
  if (!npKey) {
    return { ok: false, statusCode: 503, error: "NP_API_KEY is not configured" };
  }

  const amount = priceUsdForPlan(planType);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      statusCode: 500,
      error: "Invalid plan pricing (set PLAN_PRICE_PRO_USD / PLAN_PRICE_BUSINESS_USD / PLAN_PRICE_AGENCY_USD)",
    };
  }

  const baseUrl = (process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  const successUrl = process.env.NP_SUCCESS_URL || (baseUrl ? `${baseUrl}/success` : undefined);
  const cancelUrl = process.env.NP_CANCEL_URL || (baseUrl ? `${baseUrl}/` : undefined);
  const ipnUrl = process.env.NP_IPN_CALLBACK_URL || process.env.NOWPAYMENTS_IPN_CALLBACK_URL;

  const orderRef = `snapapi-${prismaUser.id}-${Date.now()}`;
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
      log.error({ err: e.message, status, data: e.response?.data }, "[NOWPayments] axios error");
      return { ok: false, statusCode: status >= 400 && status < 600 ? status : 502, error: msg };
    }
    log.error(e, "[NOWPayments] unexpected error");
    return { ok: false, statusCode: 500, error: "Unexpected server error" };
  }

  if (npStatus < 200 || npStatus >= 300) {
    const msg = extractNpErrorMessage(npData, npStatus);
    log.warn({ npStatus, npData }, "[NOWPayments] invoice rejected");
    return { ok: false, statusCode: 502, error: msg };
  }

  const paymentId = pickInvoiceId(npData);
  const invoiceUrl = pickInvoiceUrl(npData);
  if (!paymentId || !invoiceUrl) {
    log.error({ npData }, "[NOWPayments] response missing id or invoice_url");
    return { ok: false, statusCode: 502, error: "Invalid response from NOWPayments (missing id or invoice_url)" };
  }

  try {
    await prisma.order.create({
      data: {
        userId: prismaUser.id,
        amount,
        status: "pending",
        paymentId,
        orderRef,
        planType,
      },
    });
  } catch (e) {
    log.error(e, "[NOWPayments] prisma.order.create");
    return { ok: false, statusCode: 500, error: "Failed to save order" };
  }

  return { ok: true, invoice_url: invoiceUrl };
}

/**
 * POST /api/subscribe — create NOWPayments invoice, persist pending Order (Prisma).
 */
export async function postSubscribeHandler(request, reply) {
  const email = String(request.body?.email ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply.code(400).send({ error: "Invalid email" });
  }

  const planType = resolvePlanType(request.body);
  if (!planType) {
    return reply.code(400).send({ error: "planType must be pro, business, or agency (camelCase or plan_type)" });
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

  const result = await createNowpaymentsInvoiceAndOrder({
    prismaUser: user,
    email,
    planType,
    log: request.log,
  });

  if (!result.ok) {
    return reply.code(result.statusCode).send({ error: result.error });
  }

  return reply.send({ invoice_url: result.invoice_url });
}

import { getUserIdFromRequest } from "./authContext.js";
import { getPool, getUserDashboardRow } from "./db.js";
import { prisma } from "./prismaClient.js";
import { createNowpaymentsInvoiceAndOrder, resolvePlanType } from "./subscribeInvoice.js";

/**
 * POST /api/payment/create-invoice
 * Auth: session or Bearer JWT. Resolves Prisma `app_users` row by dashboard email, creates NOWPayments invoice + pending Order.
 */
export async function postPaymentCreateInvoice(request, reply) {
  const uid = await getUserIdFromRequest(request);
  if (!uid) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const pool = getPool();
  if (!pool) {
    return reply.code(503).send({ error: "Database not configured" });
  }

  const row = await getUserDashboardRow(uid);
  if (!row?.email) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const planType = resolvePlanType(request.body);
  if (!planType) {
    return reply.code(400).send({ error: "plan must be pro or business" });
  }

  const email = String(row.email).trim().toLowerCase();

  let prismaUser;
  try {
    prismaUser = await prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });
  } catch (e) {
    request.log.error(e, "[payment/create-invoice] prisma.user.upsert");
    return reply.code(500).send({ error: "Database error while resolving user" });
  }

  const result = await createNowpaymentsInvoiceAndOrder({
    prismaUser,
    email,
    planType,
    log: request.log,
  });

  if (!result.ok) {
    return reply.code(result.statusCode).send({ error: result.error });
  }

  return reply.send({
    invoice_url: result.invoice_url,
    user_id: prismaUser.id,
  });
}

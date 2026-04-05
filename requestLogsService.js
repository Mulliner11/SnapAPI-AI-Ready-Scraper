import { getPool } from "./db.js";
import { prisma } from "./prismaClient.js";

/**
 * Prisma `RequestLog` rows for the dashboard (legacy `users.id` → email → `app_users`).
 */
export async function listRequestLogsForLegacyUserId(legacyUserId, take = 20) {
  const pool = getPool();
  if (!pool) return [];
  const uid = Number(legacyUserId);
  if (!Number.isFinite(uid) || uid < 1) return [];

  let email;
  try {
    const r = await pool.query(`SELECT lower(email) AS email FROM users WHERE id = $1`, [uid]);
    email = r.rows[0]?.email;
  } catch {
    return [];
  }
  if (!email) return [];

  try {
    const pu = await prisma.user.findUnique({ where: { email } });
    if (!pu) return [];
    return await prisma.requestLog.findMany({
      where: { userId: pu.id },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        userId: true,
        url: true,
        status: true,
        duration: true,
        responseSize: true,
        createdAt: true,
      },
    });
  } catch (e) {
    console.warn("[requestLogs] list failed:", e?.message || e);
    return [];
  }
}

export async function recordPrismaRequestLogForScrape(legacyUserRow, { url, status, durationMs, responseSize }) {
  if (!legacyUserRow?.email) return;
  const email = String(legacyUserRow.email).trim().toLowerCase();
  if (!email) return;

  const st = Number(status);
  const httpStatus = Number.isFinite(st) ? Math.trunc(st) : 500;
  const dur = Number(durationMs);
  const duration = Number.isFinite(dur) ? Math.max(0, Math.trunc(dur)) : 0;
  const rs = Number(responseSize);
  const size = Number.isFinite(rs) ? Math.max(0, Math.trunc(rs)) : 0;
  const u = String(url || "").slice(0, 8000);

  try {
    const pu = await prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });
    await prisma.requestLog.create({
      data: {
        userId: pu.id,
        url: u,
        status: httpStatus,
        duration,
        responseSize: size,
      },
    });
  } catch (e) {
    console.warn("[requestLogs] write failed:", e?.message || e);
  }
}

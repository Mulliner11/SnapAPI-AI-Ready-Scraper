import { prisma } from "./prismaClient.js";

/** @param {string} raw */
export function displayPlanFromSlug(raw) {
  const p = String(raw || "free").toLowerCase();
  if (p === "pro") return "Pro";
  if (p === "business" || p === "agency") return "Agency";
  return "Free";
}

/**
 * @param {string} email
 * @param {string} [legacyPlanFallback] from `users.plan`
 * @returns {Promise<{ plan: string, expiresAt: string | null }>}
 */
export async function getUserPlanPayloadByEmail(email, legacyPlanFallback) {
  const em = String(email || "").trim().toLowerCase();
  let planRaw = String(legacyPlanFallback || "free").toLowerCase();
  /** @type {Date | null} */
  let expiresAt = null;

  try {
    const pu = await prisma.user.findUnique({
      where: { email: em },
      select: { plan: true, expiresAt: true },
    });
    if (pu) {
      if (pu.plan != null && String(pu.plan).trim() !== "") {
        planRaw = String(pu.plan).toLowerCase();
      }
      expiresAt = pu.expiresAt;
    }
  } catch {
    // Prisma offline or schema mismatch — fall back to legacy plan only
  }

  const iso =
    expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null;

  return {
    plan: displayPlanFromSlug(planRaw),
    expiresAt: iso,
  };
}

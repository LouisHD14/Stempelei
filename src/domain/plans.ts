export const TRIAL_DAYS = 14;

export function trialEndsAt(start: Date): Date {
  return new Date(start.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

export type Plan = 'klein' | 'mittel' | 'gross';

/** Grenzen der Pakete, wie auf /pricing beschrieben. Infinity = unbegrenzt. */
export const PLAN_LIMITS: Record<Plan, { programs: number; staff: number; locations: number }> = {
  klein: { programs: 1, staff: 3, locations: 1 },
  mittel: { programs: 3, staff: 10, locations: 3 },
  gross: { programs: Number.POSITIVE_INFINITY, staff: Number.POSITIVE_INFINITY, locations: 10 },
};

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete';

/**
 * Darf die Kasse stempeln? In der Testphase bis zu ihrem Ende, danach nur mit bezahltem Abo.
 * shortcut: past_due sperrt sofort statt nach 7 Tagen Kulanz. Mit Phase 5 (Stripe) die Kulanz einbauen.
 */
export function tillAllowed(
  biz: { subscriptionStatus: SubscriptionStatus; trialEndsAt: Date },
  now = new Date(),
): boolean {
  if (biz.subscriptionStatus === 'active') return true;
  return biz.subscriptionStatus === 'trialing' && now < biz.trialEndsAt;
}

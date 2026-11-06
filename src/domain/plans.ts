export const TRIAL_DAYS = 14;

export type PlanId = 'klein' | 'mittel' | 'gross';

export interface Plan {
  label: string;
  priceCents: number;
  /** null = unbegrenzt */
  locations: number | null;
  programs: number | null;
  staff: number | null;
  weeklyReport: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  klein: { label: 'Klein', priceCents: 2900, locations: 1, programs: 1, staff: 3, weeklyReport: false },
  mittel: { label: 'Mittel', priceCents: 5900, locations: 3, programs: 3, staff: 10, weeklyReport: false },
  gross: { label: 'Groß', priceCents: 9900, locations: 10, programs: null, staff: null, weeklyReport: true },
};

export type LimitedResource = 'locations' | 'programs' | 'staff';

/** Darf der Betrieb noch eines davon anlegen? */
export function canAdd(plan: PlanId, resource: LimitedResource, currentCount: number): boolean {
  const limit = PLANS[plan][resource];
  return limit === null || currentCount < limit;
}

/** Kleinstes Paket, das mindestens `needed` Stück erlaubt, für die Meldung „Wechsle zu …“. */
export function smallestPlanFor(resource: LimitedResource, needed: number): PlanId | null {
  const order: PlanId[] = ['klein', 'mittel', 'gross'];
  return order.find((id) => canAdd(id, resource, needed - 1)) ?? null;
}

export function trialEndsAt(start: Date): Date {
  return new Date(start.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

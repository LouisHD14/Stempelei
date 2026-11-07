import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import { businesses } from '../db/schema.js';
import type { Plan } from '../domain/plans.js';
import type { SessionUser } from './auth.js';

/**
 * Auswertung für den Inhaber. Alle Zahlen zählen nur Buchungen, die nicht zurückgenommen wurden.
 * Zeiträume: 30 Tage für alle, 90 Tage und 12 Monate nur im Paket Groß (so steht es auf /pricing).
 * shortcut: Tage und Monate in Europe/Berlin, wie das Tagesprotokoll der Kasse. Zeitzone am Betrieb
 * speichern, wenn Betriebe in anderen Zeitzonen dazukommen.
 */
export const RANGES = {
  '30d': { days: 30, bucket: 'day', plans: ['klein', 'mittel', 'gross'] },
  '90d': { days: 90, bucket: 'day', plans: ['gross'] },
  '12m': { days: 365, bucket: 'month', plans: ['gross'] },
} as const satisfies Record<string, { days: number; bucket: 'day' | 'month'; plans: readonly Plan[] }>;
export type RangeKey = keyof typeof RANGES;

const TZ = 'Europe/Berlin';
/** Karten gelten als „kurz vor einer Prämie“, wenn höchstens so viele Stempel fehlen. */
export const NEAR_REWARD_STAMPS = 2;

const rangeQuery = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { range: { type: 'string', enum: Object.keys(RANGES) } },
  },
};

interface SeriesRow extends Record<string, unknown> {
  bucket: string;
  stamps: number;
  redeemed: number;
  issued: number;
}

export async function statsFor(db: Db, businessId: string, key: RangeKey) {
  const range = RANGES[key];
  const unit = sql.raw(`'${range.bucket}'`);
  const step = sql.raw(range.bucket === 'day' ? `interval '1 day'` : `interval '1 month'`);
  // Erster Tag (bzw. Monat) des Zeitraums, heute zählt mit. 12 Monate = laufender Monat plus 11 davor.
  const start =
    range.bucket === 'day'
      ? sql`(date_trunc('day', now() at time zone ${TZ}) - ${sql.raw(`interval '${range.days - 1} days'`)})`
      : sql`(date_trunc('month', now() at time zone ${TZ}) - interval '11 months')`;
  // Vorperiode gleicher Länge, für die Veränderung in den Kennzahlen
  const prevStart =
    range.bucket === 'day'
      ? sql`(${start} - ${sql.raw(`interval '${range.days} days'`)})`
      : sql`(${start} - interval '12 months')`;
  const local = sql`(e.created_at at time zone ${TZ})`;
  const live = sql`e.business_id = ${businessId} and e.undone_by_event_id is null`;

  const series = await db.execute<SeriesRow>(sql`
    with buckets as (
      select generate_series(${start}, date_trunc(${unit}, now() at time zone ${TZ}), ${step}) as b
    ),
    agg as (
      select date_trunc(${unit}, ${local}) as b,
        coalesce(sum(e.amount) filter (where e.type = 'give'), 0)::int as stamps,
        (count(*) filter (where e.type = 'redeem'))::int as redeemed,
        (count(*) filter (where e.type = 'issue'))::int as issued
      from events e
      where ${live} and ${local} >= ${start}
      group by 1
    )
    select to_char(buckets.b, 'YYYY-MM-DD') as bucket,
      coalesce(agg.stamps, 0) as stamps, coalesce(agg.redeemed, 0) as redeemed, coalesce(agg.issued, 0) as issued
    from buckets left join agg on agg.b = buckets.b
    order by buckets.b`);

  const [previous] = await db.execute<{ stamps: number; redeemed: number; issued: number }>(sql`
    select coalesce(sum(e.amount) filter (where e.type = 'give'), 0)::int as stamps,
      (count(*) filter (where e.type = 'redeem'))::int as redeemed,
      (count(*) filter (where e.type = 'issue'))::int as issued
    from events e
    where ${live} and ${local} >= ${prevStart} and ${local} < ${start}`);

  // Ein Besuch = ein Tag, an dem die Karte mindestens einen Stempel bekam
  const [guests] = await db.execute<{ active: number; returning: number; visits: number }>(sql`
    with v as (
      select e.card_id, count(distinct date_trunc('day', ${local}))::int as visits
      from events e
      where ${live} and e.type = 'give' and ${local} >= ${start}
      group by e.card_id
    )
    select count(*)::int as active,
      (count(*) filter (where visits >= 2))::int as returning,
      coalesce(sum(visits), 0)::int as visits
    from v`);

  // Prämien: alle aktiven, dazu archivierte, die im Zeitraum eingelöst wurden
  const rewardRows = await db.execute<{
    text: string;
    threshold: number;
    program: string;
    redeemed: number;
  }>(sql`
    select r.text, r.threshold, p.name as program, count(e.id)::int as redeemed
    from rewards r
    join programs p on p.id = r.program_id
    left join events e on e.reward_id = r.id and e.type = 'redeem' and ${live} and ${local} >= ${start}
    where p.business_id = ${businessId}
    group by r.id, r.text, r.threshold, r.archived_at, p.name, p.created_at, p.archived_at
    having (r.archived_at is null and p.archived_at is null) or count(e.id) > 0
    order by redeemed desc, p.created_at, r.threshold`);

  // Karten mit Aktivität in den letzten 90 Tagen, denen höchstens 2 Stempel zur nächsten Prämie fehlen
  const [near] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from cards c
    join lateral (
      select min(r.threshold) as t from rewards r
      where r.program_id = c.program_id and r.archived_at is null
        and r.threshold > c.stamps and not (r.id = any(c.claimed_reward_ids))
    ) nxt on true
    where c.business_id = ${businessId} and nxt.t is not null
      and nxt.t - c.stamps <= ${NEAR_REWARD_STAMPS}
      and c.last_activity_at > now() - interval '90 days'`);

  const totals = { stamps: 0, redeemed: 0, issued: 0 };
  for (const r of series) {
    totals.stamps += r.stamps;
    totals.redeemed += r.redeemed;
    totals.issued += r.issued;
  }
  const g = guests ?? { active: 0, returning: 0, visits: 0 };
  return {
    range: key,
    bucket: range.bucket,
    series: [...series].map((r) => ({
      date: r.bucket,
      stamps: r.stamps,
      redeemed: r.redeemed,
      issued: r.issued,
    })),
    totals,
    previous: previous ?? { stamps: 0, redeemed: 0, issued: 0 },
    guests: {
      activeCards: g.active,
      returningCards: g.returning,
      avgVisits: g.active ? Math.round((g.visits / g.active) * 10) / 10 : 0,
    },
    rewards: [...rewardRows].map((r) => ({
      text: r.text,
      threshold: r.threshold,
      program: r.program,
      redeemed: r.redeemed,
    })),
    nearReward: near?.n ?? 0,
  };
}

export async function statsRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  async function planOf(businessId: string): Promise<Plan> {
    const [biz] = await db
      .select({ plan: businesses.plan })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    return biz?.plan ?? 'klein';
  }
  const allowed = (plan: Plan) =>
    (Object.keys(RANGES) as RangeKey[]).filter((k) => (RANGES[k].plans as readonly Plan[]).includes(plan));
  const locked = (reply: FastifyReply) =>
    reply.code(403).send({
      error: 'plan_feature',
      message: 'Diese Auswertung gibt es im Paket Groß.',
    });

  app.get<{ Querystring: { range?: RangeKey } }>(
    '/api/stats',
    { preHandler: app.requireUser, schema: rangeQuery },
    async (req, reply) => {
      const u = req.user as SessionUser;
      const plan = await planOf(u.businessId);
      const key = req.query.range ?? '30d';
      if (!allowed(plan).includes(key)) return locked(reply);
      const stats = await statsFor(db, u.businessId, key);
      return reply
        .header('Cache-Control', 'no-store')
        .send({ ...stats, plan, allowedRanges: allowed(plan), csv: plan === 'gross' });
    },
  );

  app.get<{ Querystring: { range?: RangeKey } }>(
    '/api/stats.csv',
    { preHandler: app.requireUser, schema: rangeQuery },
    async (req, reply) => {
      const u = req.user as SessionUser;
      if ((await planOf(u.businessId)) !== 'gross') return locked(reply);
      const key = req.query.range ?? '30d';
      const stats = await statsFor(db, u.businessId, key);
      // Semikolon und Komma-Dezimal sind in deutschen Tabellenprogrammen der Standard
      const lines = [
        'Zeitraum;Stempel;Einlösungen;Neue Karten',
        ...stats.series.map((r) => `${r.date};${r.stamps};${r.redeemed};${r.issued}`),
      ];
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="stempelei-${key}.csv"`)
        .header('Cache-Control', 'no-store')
        .send(`﻿${lines.join('\r\n')}\r\n`);
    },
  );
}

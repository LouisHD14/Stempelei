import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { businesses, programs, rewards } from '../db/schema.js';
import { PLAN_LIMITS } from '../domain/plans.js';
import { MAX_STAMPS } from '../domain/stamps.js';
import { publishProgramChange } from '../live.js';
import { body, type SessionUser } from './auth.js';

export const INKS = ['tinte', 'blau', 'gruen', 'koralle'] as const;
export const MAX_REWARDS = 5;

interface RewardInput {
  id?: string;
  threshold: number;
  text: string;
}
interface ProgramInput {
  name: string;
  earnRule: string;
  ink: (typeof INKS)[number];
  rewards: RewardInput[];
}

const uuid = { type: 'string', format: 'uuid' } as const;
const programSchema = body({
  name: { type: 'string', minLength: 1, maxLength: 60 },
  earnRule: { type: 'string', maxLength: 120 },
  ink: { type: 'string', enum: [...INKS] },
  rewards: {
    type: 'array',
    minItems: 1,
    maxItems: MAX_REWARDS,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['threshold', 'text'],
      properties: {
        id: uuid,
        threshold: { type: 'integer', minimum: 1, maximum: MAX_STAMPS },
        text: { type: 'string', minLength: 1, maxLength: 60 },
      },
    },
  },
});
const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: uuid } },
};

/** Prüft, was das Schema nicht ausdrücken kann. Liefert das Feld mit dem Fehler oder null. */
function problem(input: ProgramInput): string | null {
  if (!input.name.trim()) return 'name';
  if (input.rewards.some((r) => !r.text.trim())) return 'rewardText';
  const thresholds = input.rewards.map((r) => r.threshold);
  if (new Set(thresholds).size !== thresholds.length) return 'rewardThreshold';
  return null;
}

const clean = (input: ProgramInput) => ({
  name: input.name.trim(),
  earnRule: input.earnRule.trim(),
  ink: input.ink,
});

export interface ProgramView {
  id: string;
  name: string;
  earnRule: string;
  ink: string;
  rewards: { id: string; threshold: number; text: string }[];
  updatedAt: Date;
}

/** Aktive Karten eines Betriebs mit ihren aktiven Prämien, älteste zuerst. */
export async function loadPrograms(
  db: Db,
  businessId: string,
  ids?: string[],
  opts: { includeArchived?: boolean } = {},
): Promise<ProgramView[]> {
  const progs = await db
    .select({
      id: programs.id,
      name: programs.name,
      earnRule: programs.earnRule,
      ink: programs.ink,
      updatedAt: programs.updatedAt,
    })
    .from(programs)
    .where(
      and(
        eq(programs.businessId, businessId),
        opts.includeArchived ? undefined : isNull(programs.archivedAt),
        ids ? inArray(programs.id, ids) : undefined,
      ),
    )
    .orderBy(asc(programs.createdAt));
  if (progs.length === 0) return [];
  const rows = await db
    .select({
      id: rewards.id,
      programId: rewards.programId,
      threshold: rewards.threshold,
      text: rewards.text,
    })
    .from(rewards)
    .where(
      and(
        inArray(
          rewards.programId,
          progs.map((p) => p.id),
        ),
        isNull(rewards.archivedAt),
      ),
    )
    .orderBy(asc(rewards.threshold));
  return progs.map((p) => ({
    ...p,
    rewards: rows
      .filter((r) => r.programId === p.id)
      .map(({ id, threshold, text }) => ({ id, threshold, text })),
  }));
}

export async function programRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  const bad = (field: string) => ({ error: 'bad_request', field, message: 'Bitte prüfe deine Eingaben.' });

  app.get('/api/programs', { preHandler: app.requireUser }, async (req) => {
    const u = req.user as SessionUser;
    const [biz] = await db
      .select({ plan: businesses.plan })
      .from(businesses)
      .where(eq(businesses.id, u.businessId));
    const limit = PLAN_LIMITS[biz?.plan ?? 'klein'].programs;
    // Infinity ist kein gültiges JSON, unbegrenzt wird als null gesendet
    return { programs: await loadPrograms(db, u.businessId), limit: Number.isFinite(limit) ? limit : null };
  });

  app.post<{ Body: ProgramInput }>(
    '/api/programs',
    { preHandler: app.requireUser, schema: programSchema },
    async (req, reply) => {
      const u = req.user as SessionUser;
      const field = problem(req.body);
      if (field) return reply.code(400).send(bad(field));

      const id = await db.transaction(async (tx) => {
        // Betrieb sperren, damit zwei gleichzeitige Anfragen die Paketgrenze nicht überspringen
        const [biz] = await tx
          .select({ plan: businesses.plan })
          .from(businesses)
          .where(eq(businesses.id, u.businessId))
          .for('update');
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(programs)
          .where(and(eq(programs.businessId, u.businessId), isNull(programs.archivedAt)));
        if (!biz || n >= PLAN_LIMITS[biz.plan].programs) return null;
        const [prog] = await tx
          .insert(programs)
          .values({ businessId: u.businessId, ...clean(req.body) })
          .returning({ id: programs.id });
        if (!prog) throw new Error('Karte wurde nicht angelegt');
        await tx.insert(rewards).values(
          req.body.rewards.map((r) => ({
            programId: prog.id,
            threshold: r.threshold,
            text: r.text.trim(),
          })),
        );
        return prog.id;
      });
      if (!id) {
        return reply.code(403).send({
          error: 'plan_limit',
          message: 'Dein Paket erlaubt keine weitere Stempelkarte. Ein größeres Paket erlaubt mehr.',
        });
      }
      const [view] = await loadPrograms(db, u.businessId, [id]);
      return reply.code(201).send({ program: view });
    },
  );

  app.put<{ Params: { id: string }; Body: ProgramInput }>(
    '/api/programs/:id',
    { preHandler: app.requireUser, schema: { ...programSchema, ...idParam } },
    async (req, reply) => {
      const u = req.user as SessionUser;
      const field = problem(req.body);
      if (field) return reply.code(400).send(bad(field));

      const found = await db.transaction(async (tx) => {
        const [prog] = await tx
          .update(programs)
          .set({ ...clean(req.body), updatedAt: new Date() })
          .where(
            and(
              eq(programs.id, req.params.id),
              eq(programs.businessId, u.businessId),
              isNull(programs.archivedAt),
            ),
          )
          .returning({ id: programs.id });
        if (!prog) return false;

        const current = await tx
          .select({ id: rewards.id })
          .from(rewards)
          .where(and(eq(rewards.programId, prog.id), isNull(rewards.archivedAt)));
        const currentIds = new Set(current.map((r) => r.id));
        const keep = new Set<string>();
        for (const r of req.body.rewards) {
          if (r.id && currentIds.has(r.id)) {
            keep.add(r.id);
            await tx
              .update(rewards)
              .set({ threshold: r.threshold, text: r.text.trim() })
              .where(eq(rewards.id, r.id));
          } else {
            // Unbekannte IDs (z. B. von einer anderen Karte) werden wie neue Prämien behandelt
            await tx
              .insert(rewards)
              .values({ programId: prog.id, threshold: r.threshold, text: r.text.trim() });
          }
        }
        // Entfernte Prämien nur archivieren, damit alte Einlösungen lesbar bleiben
        const gone = [...currentIds].filter((rid) => !keep.has(rid));
        if (gone.length) {
          await tx.update(rewards).set({ archivedAt: new Date() }).where(inArray(rewards.id, gone));
        }
        return true;
      });
      if (!found) return reply.code(404).send({ error: 'not_found', message: 'Diese Karte gibt es nicht.' });
      publishProgramChange(req.params.id);
      const [view] = await loadPrograms(db, u.businessId, [req.params.id]);
      return { program: view };
    },
  );
}

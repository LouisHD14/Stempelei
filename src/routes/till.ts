import { and, asc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { hashToken, randomToken, verifyPassword } from '../auth/crypto.js';
import { cardUrl, issueCard } from '../cards.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { businesses, devices, pairingCodes, staff, tillSessions } from '../db/schema.js';
import { tillAllowed } from '../domain/plans.js';
import { MAX_STAMPS } from '../domain/stamps.js';
import {
  findCard,
  giveAction,
  redeemAction,
  type TillActor,
  tillCard,
  todayLog,
  undoAction,
} from '../till-actions.js';
import { body } from './auth.js';
import { loadPrograms } from './programs.js';
import { PIN_PATTERN } from './team.js';

export const DEVICE_COOKIE = 'till_device';
export const TILL_SESSION_COOKIE = 'till_session';
const DEVICE_DAYS = 400;
const SESSION_MINUTES = 15;
export const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 5;
const MINUTE_MS = 60_000;

interface TillDevice {
  id: string;
  name: string;
  businessId: string;
  locationId: string | null;
  failedPinAttempts: number;
  pinLockedUntil: Date | null;
  business: {
    name: string;
    subscriptionStatus: Parameters<typeof tillAllowed>[0]['subscriptionStatus'];
    trialEndsAt: Date;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Gesetzt von den Kassen-preHandlern */
    tillDevice?: TillDevice;
    tillStaff?: { id: string; name: string };
  }
}

const uuid = { type: 'string', format: 'uuid' } as const;
const idParam = { params: { type: 'object', required: ['id'], properties: { id: uuid } } };

/** Fehlercodes der Kasse mit Status und Meldung. */
const ERRORS = {
  device_required: [401, 'Dieses Gerät ist nicht als Kasse freigeschaltet.'],
  pin_required: [401, 'Bitte gib deine PIN ein.'],
  subscription_required: [402, 'Die Testphase ist vorbei. Für die Kasse braucht der Betrieb ein Paket.'],
  invalid_code: [400, 'Dieser Code ist ungültig oder abgelaufen. Lass dir im Dashboard einen neuen geben.'],
  not_found: [404, 'Diese Karte gibt es nicht.'],
  foreign_card: [404, 'Diese Karte gehört zu einem anderen Betrieb.'],
  no_program: [400, 'Lege zuerst im Dashboard eine Stempelkarte an.'],
  card_full: [409, 'Die Karte ist voll. Löse zuerst eine Prämie ein.'],
  reward_not_available: [409, 'Diese Prämie kann gerade nicht eingelöst werden.'],
  nothing_to_undo: [409, 'Hier gibt es nichts rückgängig zu machen.'],
  idempotency_conflict: [
    409,
    'Diese Aktion wurde schon für eine andere Karte verwendet. Lade die Seite neu.',
  ],
} as const satisfies Record<string, readonly [number, string]>;
type TillError = keyof typeof ERRORS;

function fail(reply: FastifyReply, error: TillError, extra: object = {}) {
  const [status, message] = ERRORS[error];
  return reply.code(status).send({ error, message, ...extra });
}

/** Kasse: Gerät freischalten, PIN-Anmeldung und alle Aktionen an Karten. */
export async function tillRoutes(
  app: FastifyInstance,
  { config, db }: { config: Config; db: Db },
): Promise<void> {
  const secureCookie = config.publicUrl.protocol === 'https:';
  const cookieOpts = { path: '/', httpOnly: true, secure: secureCookie, sameSite: 'lax' } as const;

  /** Gerät aus dem Cookie. Gesperrte Geräte und gelöschte Betriebe zählen nicht. Merkt sich „zuletzt gesehen“. */
  async function deviceOf(req: FastifyRequest): Promise<TillDevice | null> {
    const t = req.cookies[DEVICE_COOKIE];
    if (!t || t.length > 100) return null;
    const [d] = await db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(devices.tokenHash, hashToken(t)), isNull(devices.revokedAt)))
      .returning({
        id: devices.id,
        name: devices.name,
        businessId: devices.businessId,
        locationId: devices.locationId,
        failedPinAttempts: devices.failedPinAttempts,
        pinLockedUntil: devices.pinLockedUntil,
      });
    if (!d) return null;
    const [business] = await db
      .select({
        name: businesses.name,
        subscriptionStatus: businesses.subscriptionStatus,
        trialEndsAt: businesses.trialEndsAt,
      })
      .from(businesses)
      .where(and(eq(businesses.id, d.businessId), isNull(businesses.deletedAt)));
    return business ? { ...d, business } : null;
  }

  /** PIN-Sitzung auf diesem Gerät. Jede Anfrage verlängert sie auf 15 Minuten ab jetzt. */
  async function sessionOf(req: FastifyRequest, deviceId: string) {
    const t = req.cookies[TILL_SESSION_COOKIE];
    if (!t || t.length > 100) return null;
    const expiresAt = new Date(Date.now() + SESSION_MINUTES * MINUTE_MS);
    const [s] = await db
      .update(tillSessions)
      .set({ expiresAt })
      .where(
        and(
          eq(tillSessions.idHash, hashToken(t)),
          eq(tillSessions.deviceId, deviceId),
          gt(tillSessions.expiresAt, new Date()),
          // Archivierte Team-Mitglieder verlieren ihre Sitzung sofort
          sql`exists (select 1 from ${staff} where ${staff.id} = ${tillSessions.staffId} and ${staff.archivedAt} is null)`,
        ),
      )
      .returning({ staffId: tillSessions.staffId });
    if (!s) return null;
    const [member] = await db
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(eq(staff.id, s.staffId));
    return member ? { staff: member, expiresAt } : null;
  }

  const requireDevice: preHandlerHookHandler = async (req, reply) => {
    const d = await deviceOf(req);
    if (!d) return fail(reply, 'device_required');
    req.tillDevice = d;
  };
  /** Für Aktionen an Karten: Gerät, PIN-Sitzung und ein Betrieb, der die Kasse nutzen darf. */
  const requireTill: preHandlerHookHandler = async (req, reply) => {
    const d = await deviceOf(req);
    if (!d) return fail(reply, 'device_required');
    const s = await sessionOf(req, d.id);
    if (!s) return fail(reply, 'pin_required');
    if (!tillAllowed(d.business)) return fail(reply, 'subscription_required');
    req.tillDevice = d;
    req.tillStaff = s.staff;
  };
  const actorOf = (req: FastifyRequest): TillActor => {
    const d = req.tillDevice as TillDevice;
    return {
      businessId: d.businessId,
      deviceId: d.id,
      staffId: (req.tillStaff as { id: string }).id,
      locationId: d.locationId,
    };
  };
  const view = (req: FastifyRequest, cardId: string) => tillCard(db, config.publicUrl, cardId, actorOf(req));

  // shortcut: Zähler liegen im Speicher des Prozesses, gilt nur bei einer Instanz. Bei mehreren Instanzen auf Redis umstellen.
  const pairLimit = app.rateLimit({
    max: 10,
    timeWindow: 15 * MINUTE_MS,
    keyGenerator: (req) => `till-pair|${req.ip}`,
  });

  app.post<{ Body: { code: string; name: string } }>(
    '/api/till/pair',
    {
      preHandler: pairLimit,
      // Das Format des Codes prüft der Handler, damit jeder falsche Code dieselbe Antwort bekommt
      schema: body({
        code: { type: 'string', maxLength: 20 },
        name: { type: 'string', minLength: 1, maxLength: 40 },
      }),
    },
    async (req, reply) => {
      const code = req.body.code.trim();
      const name = req.body.name.trim();
      if (!name) {
        return reply
          .code(400)
          .send({ error: 'bad_request', field: 'name', message: 'Bitte gib dem Gerät einen Namen.' });
      }
      if (!/^[0-9]{8}$/.test(code)) return fail(reply, 'invalid_code');
      const token = randomToken();
      const res = await db.transaction(async (tx) => {
        // Löschen beim Einlösen: so gilt jeder Code genau einmal, auch bei gleichzeitigen Versuchen
        const [pc] = await tx
          .delete(pairingCodes)
          .where(and(eq(pairingCodes.codeHash, hashToken(code)), gt(pairingCodes.expiresAt, new Date())))
          .returning({ businessId: pairingCodes.businessId });
        if (!pc) return null;
        const [biz] = await tx
          .select({ name: businesses.name })
          .from(businesses)
          .where(and(eq(businesses.id, pc.businessId), isNull(businesses.deletedAt)));
        if (!biz) return null;
        const [d] = await tx
          .insert(devices)
          .values({ businessId: pc.businessId, name, tokenHash: hashToken(token) })
          .returning({ id: devices.id, name: devices.name });
        if (!d) throw new Error('Gerät wurde nicht angelegt');
        return { device: d, business: biz };
      });
      if (!res) return fail(reply, 'invalid_code');
      reply.setCookie(DEVICE_COOKIE, token, {
        ...cookieOpts,
        expires: new Date(Date.now() + DEVICE_DAYS * 24 * 60 * MINUTE_MS),
      });
      return res;
    },
  );

  app.get('/api/till/state', { preHandler: requireDevice }, async (req, reply) => {
    const d = req.tillDevice as TillDevice;
    const [members, session, programs] = await Promise.all([
      db
        .select({ id: staff.id, name: staff.name })
        .from(staff)
        .where(and(eq(staff.businessId, d.businessId), isNull(staff.archivedAt)))
        .orderBy(asc(staff.createdAt)),
      sessionOf(req, d.id),
      loadPrograms(db, d.businessId),
    ]);
    return reply.header('Cache-Control', 'no-store').send({
      device: { id: d.id, name: d.name },
      business: { name: d.business.name },
      tillAllowed: tillAllowed(d.business),
      staff: members,
      session: session ? { staff: session.staff, expiresAt: session.expiresAt.toISOString() } : null,
      programs,
    });
  });

  app.post<{ Body: { pin: string } }>(
    '/api/till/pin',
    { preHandler: requireDevice, schema: body({ pin: { type: 'string', pattern: PIN_PATTERN } }) },
    async (req, reply) => {
      const d = req.tillDevice as TillDevice;
      const locked = (until: Date) =>
        reply.code(423).send({
          error: 'pin_locked',
          message: 'Zu viele falsche PINs. Warte ein paar Minuten.',
          lockedUntil: until.toISOString(),
        });
      // Jeden Versuch zuerst in der Datenbank buchen und erst dann prüfen. So kommen auch parallele
      // Anfragen höchstens auf 5 Prüfungen pro Sperrfenster. Nach Ablauf einer Sperre zählt es neu.
      const expired = sql`(${devices.pinLockedUntil} is not null and ${devices.pinLockedUntil} <= now())`;
      const attempt = sql`(case when ${expired} then 1 else ${devices.failedPinAttempts} + 1 end)`;
      const [booked] = await db
        .update(devices)
        .set({
          failedPinAttempts: attempt,
          pinLockedUntil: sql`case when ${attempt} >= ${MAX_PIN_ATTEMPTS} then now() + ${sql.raw(`interval '${LOCK_MINUTES} minutes'`)} else null end`,
        })
        .where(
          and(
            eq(devices.id, d.id),
            or(isNull(devices.pinLockedUntil), lte(devices.pinLockedUntil, sql`now()`)),
          ),
        )
        .returning({ failed: devices.failedPinAttempts, lockedUntil: devices.pinLockedUntil });
      if (!booked) {
        const [cur] = await db
          .select({ lockedUntil: devices.pinLockedUntil })
          .from(devices)
          .where(eq(devices.id, d.id));
        return locked(cur?.lockedUntil ?? new Date(Date.now() + LOCK_MINUTES * MINUTE_MS));
      }
      // shortcut: eine Argon2-Prüfung pro Team-Mitglied, reicht für kleine Teams (siehe team.ts)
      const members = await db
        .select({ id: staff.id, name: staff.name, pinHash: staff.pinHash })
        .from(staff)
        .where(and(eq(staff.businessId, d.businessId), isNull(staff.archivedAt)));
      let found: { id: string; name: string } | null = null;
      for (const m of members) {
        if (await verifyPassword(m.pinHash, req.body.pin)) {
          found = { id: m.id, name: m.name };
          break;
        }
      }

      if (!found) {
        if (booked.lockedUntil) return locked(booked.lockedUntil);
        return reply.code(401).send({
          error: 'invalid_pin',
          message: 'Diese PIN stimmt nicht.',
          attemptsLeft: MAX_PIN_ATTEMPTS - booked.failed,
        });
      }

      const t = randomToken();
      const expiresAt = new Date(Date.now() + SESSION_MINUTES * MINUTE_MS);
      await db.transaction(async (tx) => {
        await tx
          .update(devices)
          .set({ failedPinAttempts: 0, pinLockedUntil: null })
          .where(eq(devices.id, d.id));
        // Eine Sitzung pro Gerät: wer sich anmeldet, löst die vorige Person ab. Abgelaufene gleich mit.
        await tx.delete(tillSessions).where(eq(tillSessions.deviceId, d.id));
        await tx.delete(tillSessions).where(lt(tillSessions.expiresAt, new Date()));
        await tx
          .insert(tillSessions)
          .values({ idHash: hashToken(t), staffId: found.id, deviceId: d.id, expiresAt });
      });
      // Ohne expires: Der Server bestimmt die Laufzeit, der Browser vergisst das Cookie beim Beenden
      reply.setCookie(TILL_SESSION_COOKIE, t, cookieOpts);
      return { staff: found };
    },
  );

  app.post('/api/till/logout', async (req, reply) => {
    const t = req.cookies[TILL_SESSION_COOKIE];
    if (t && t.length <= 100) await db.delete(tillSessions).where(eq(tillSessions.idHash, hashToken(t)));
    reply.clearCookie(TILL_SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get<{ Params: { ref: string } }>(
    '/api/till/cards/:ref',
    {
      preHandler: requireTill,
      schema: {
        params: { type: 'object', required: ['ref'], properties: { ref: { type: 'string', maxLength: 40 } } },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const found = await findCard(db, actor.businessId, req.params.ref);
      if ('error' in found) return fail(reply, found.error);
      return reply.header('Cache-Control', 'no-store').send({ card: await view(req, found.cardId) });
    },
  );

  app.post<{ Body: { programId?: string } }>(
    '/api/till/cards',
    { preHandler: requireTill, schema: body({}, { programId: uuid }) },
    async (req, reply) => {
      const actor = actorOf(req);
      const progs = await loadPrograms(db, actor.businessId);
      const prog = req.body.programId ? progs.find((p) => p.id === req.body.programId) : progs[0];
      if (!prog) return fail(reply, 'no_program');
      const card = await issueCard(db, {
        businessId: actor.businessId,
        programId: prog.id,
        deviceId: actor.deviceId,
        staffId: actor.staffId,
        ...(actor.locationId ? { locationId: actor.locationId } : {}),
      });
      return reply.code(201).send({
        card: await view(req, card.id),
        url: cardUrl(config.publicUrl, card.publicToken),
        qrUrl: `/api/public/cards/${card.publicToken}/qr.svg`,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { amount: number; idempotencyKey: string } }>(
    '/api/till/cards/:id/stamps',
    {
      preHandler: requireTill,
      schema: {
        ...body({ amount: { type: 'integer', minimum: 1, maximum: MAX_STAMPS }, idempotencyKey: uuid }),
        ...idParam,
      },
    },
    async (req, reply) => {
      const res = await giveAction(db, actorOf(req), req.params.id, req.body.amount, req.body.idempotencyKey);
      if ('error' in res) return fail(reply, res.error);
      return { card: await view(req, req.params.id), added: res.added };
    },
  );

  app.post<{ Params: { id: string }; Body: { rewardId: string; idempotencyKey: string } }>(
    '/api/till/cards/:id/redeem',
    { preHandler: requireTill, schema: { ...body({ rewardId: uuid, idempotencyKey: uuid }), ...idParam } },
    async (req, reply) => {
      const res = await redeemAction(
        db,
        actorOf(req),
        req.params.id,
        req.body.rewardId,
        req.body.idempotencyKey,
      );
      if ('error' in res) return fail(reply, res.error);
      return { card: await view(req, req.params.id), restarted: res.restarted };
    },
  );

  app.post<{ Params: { id: string }; Body: { idempotencyKey: string } }>(
    '/api/till/cards/:id/undo',
    { preHandler: requireTill, schema: { ...body({ idempotencyKey: uuid }), ...idParam } },
    async (req, reply) => {
      const res = await undoAction(db, actorOf(req), req.params.id, req.body.idempotencyKey);
      if ('error' in res) return fail(reply, res.error);
      return { card: await view(req, req.params.id) };
    },
  );

  app.get('/api/till/log', { preHandler: requireTill }, async (req, reply) => {
    const d = req.tillDevice as TillDevice;
    return reply.header('Cache-Control', 'no-store').send(await todayLog(db, d.businessId));
  });
}

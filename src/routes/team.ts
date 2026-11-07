import { randomInt } from 'node:crypto';
import { and, asc, count, eq, isNull, lt, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword, hashToken, verifyPassword } from '../auth/crypto.js';
import { isUniqueViolation } from '../cards.js';
import type { Db } from '../db/client.js';
import { businesses, devices, pairingCodes, staff, tillSessions } from '../db/schema.js';
import { PLAN_LIMITS } from '../domain/plans.js';
import { body, type SessionUser } from './auth.js';

export const PIN_PATTERN = '^[0-9]{4,6}$';
export const PAIRING_MINUTES = 10;
const MINUTE_MS = 60_000;

const uuid = { type: 'string', format: 'uuid' } as const;
const idParam = { params: { type: 'object', required: ['id'], properties: { id: uuid } } };
const pin = { type: 'string', pattern: PIN_PATTERN } as const;
const name = { type: 'string', minLength: 1, maxLength: 40 } as const;

const notFound = (what: string) => ({ error: 'not_found', message: `Dieses ${what} gibt es nicht.` });
const pinTaken = {
  error: 'pin_taken',
  field: 'pin',
  message: 'Diese PIN hat schon jemand im Team. Bitte wähle eine andere.',
};

/** 8 Ziffern, führende Nullen erlaubt. */
const pairingCode = () => String(randomInt(0, 100_000_000)).padStart(8, '0');

/** Team-Mitglieder mit PIN und Kassengeräte. Nur für den Inhaber. */
export async function teamRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  /**
   * Eine PIN muss im Betrieb eindeutig sein, weil die Kasse die Person allein an der PIN erkennt.
   * Die Hashes sind gesalzen, deshalb wird gegen jede aktive PIN geprüft.
   * shortcut: eine Argon2-Prüfung pro Team-Mitglied (je ~20 ms). Bei sehr großen Teams eine
   * schnelle, betriebsweit gepfefferte HMAC-Spalte zum Nachschlagen ergänzen.
   */
  async function pinInUse(q: Pick<Db, 'select'>, businessId: string, value: string, exceptId?: string) {
    const rows = await q
      .select({ pinHash: staff.pinHash })
      .from(staff)
      .where(
        and(
          eq(staff.businessId, businessId),
          isNull(staff.archivedAt),
          exceptId ? ne(staff.id, exceptId) : undefined,
        ),
      );
    for (const r of rows) if (await verifyPassword(r.pinHash, value)) return true;
    return false;
  }

  /** Sperrt den Betrieb, damit zwei gleichzeitige Änderungen weder Grenze noch PIN-Eindeutigkeit umgehen. */
  const lockBusiness = (tx: Pick<Db, 'select'>, businessId: string) =>
    tx
      .select({ plan: businesses.plan })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .for('update')
      .then((r) => r[0]);

  app.get('/api/staff', { preHandler: app.requireUser }, async (req) => {
    const u = req.user as SessionUser;
    const [biz] = await db
      .select({ plan: businesses.plan })
      .from(businesses)
      .where(eq(businesses.id, u.businessId));
    const limit = PLAN_LIMITS[biz?.plan ?? 'klein'].staff;
    const list = await db
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(and(eq(staff.businessId, u.businessId), isNull(staff.archivedAt)))
      .orderBy(asc(staff.createdAt));
    // Infinity ist kein gültiges JSON, unbegrenzt wird als null gesendet
    return { staff: list, limit: Number.isFinite(limit) ? limit : null };
  });

  app.post<{ Body: { name: string; pin: string } }>(
    '/api/staff',
    { preHandler: app.requireUser, schema: body({ name, pin }) },
    async (req, reply) => {
      const u = req.user as SessionUser;
      const clean = req.body.name.trim();
      if (!clean) {
        return reply
          .code(400)
          .send({ error: 'bad_request', field: 'name', message: 'Bitte gib einen Namen an.' });
      }
      const pinHash = await hashPassword(req.body.pin);
      const res = await db.transaction(async (tx) => {
        const biz = await lockBusiness(tx, u.businessId);
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(staff)
          .where(and(eq(staff.businessId, u.businessId), isNull(staff.archivedAt)));
        if (!biz || n >= PLAN_LIMITS[biz.plan].staff) return 'plan_limit' as const;
        if (await pinInUse(tx, u.businessId, req.body.pin)) return 'pin_taken' as const;
        const [row] = await tx
          .insert(staff)
          .values({ businessId: u.businessId, name: clean, pinHash })
          .returning({ id: staff.id, name: staff.name });
        if (!row) throw new Error('Team-Mitglied wurde nicht angelegt');
        return row;
      });
      if (res === 'plan_limit') {
        return reply.code(403).send({
          error: 'plan_limit',
          message: 'Dein Paket erlaubt kein weiteres Team-Mitglied. Ein größeres Paket erlaubt mehr.',
        });
      }
      if (res === 'pin_taken') return reply.code(409).send(pinTaken);
      return reply.code(201).send({ staff: res });
    },
  );

  app.put<{ Params: { id: string }; Body: { pin: string } }>(
    '/api/staff/:id/pin',
    { preHandler: app.requireUser, schema: { ...body({ pin }), ...idParam } },
    async (req, reply) => {
      const u = req.user as SessionUser;
      const pinHash = await hashPassword(req.body.pin);
      const res = await db.transaction(async (tx) => {
        await lockBusiness(tx, u.businessId);
        if (await pinInUse(tx, u.businessId, req.body.pin, req.params.id)) return 'pin_taken' as const;
        const [row] = await tx
          .update(staff)
          .set({ pinHash })
          .where(
            and(eq(staff.id, req.params.id), eq(staff.businessId, u.businessId), isNull(staff.archivedAt)),
          )
          .returning({ id: staff.id });
        if (!row) return 'not_found' as const;
        // Neue PIN: offene Kassen-Sitzungen mit der alten enden
        await tx.delete(tillSessions).where(eq(tillSessions.staffId, row.id));
        return 'ok' as const;
      });
      if (res === 'pin_taken') return reply.code(409).send(pinTaken);
      if (res === 'not_found') return reply.code(404).send(notFound('Team-Mitglied'));
      return { ok: true };
    },
  );

  // Archivieren statt löschen, damit das Protokoll weiter zeigt, wer gestempelt hat
  app.delete<{ Params: { id: string } }>(
    '/api/staff/:id',
    { preHandler: app.requireUser, schema: idParam },
    async (req, reply) => {
      const u = req.user as SessionUser;
      const found = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(staff)
          .set({ archivedAt: new Date() })
          .where(
            and(eq(staff.id, req.params.id), eq(staff.businessId, u.businessId), isNull(staff.archivedAt)),
          )
          .returning({ id: staff.id });
        if (!row) return false;
        await tx.delete(tillSessions).where(eq(tillSessions.staffId, row.id));
        return true;
      });
      if (!found) return reply.code(404).send(notFound('Team-Mitglied'));
      return { ok: true };
    },
  );

  app.get('/api/devices', { preHandler: app.requireUser }, async (req) => {
    const u = req.user as SessionUser;
    const list = await db
      .select({
        id: devices.id,
        name: devices.name,
        lastSeenAt: devices.lastSeenAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .where(and(eq(devices.businessId, u.businessId), isNull(devices.revokedAt)))
      .orderBy(asc(devices.createdAt));
    return { devices: list };
  });

  /**
   * Code zum Freischalten eines Geräts. 8 Ziffern lassen sich leicht abtippen. Erraten ist trotzdem
   * aussichtslos: 10 Minuten gültig, einmal nutzbar, Ratenbegrenzung beim Einlösen.
   */
  app.post('/api/devices/pairing-code', { preHandler: app.requireUser }, async (req, reply) => {
    const u = req.user as SessionUser;
    // Abgelaufene Codes aufräumen, damit ihre Hashes nicht mit neuen kollidieren
    await db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, new Date()));
    const expiresAt = new Date(Date.now() + PAIRING_MINUTES * MINUTE_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = pairingCode();
      try {
        await db
          .insert(pairingCodes)
          .values({ codeHash: hashToken(code), businessId: u.businessId, expiresAt });
        return reply.code(201).send({ code, expiresAt: expiresAt.toISOString() });
      } catch (err) {
        // Gleicher Code gerade bei einem anderen Betrieb gültig: neu würfeln
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error('Kein freier Code gefunden');
  });

  app.delete<{ Params: { id: string } }>(
    '/api/devices/:id',
    { preHandler: app.requireUser, schema: idParam },
    async (req, reply) => {
      const u = req.user as SessionUser;
      const found = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(devices.id, req.params.id),
              eq(devices.businessId, u.businessId),
              isNull(devices.revokedAt),
            ),
          )
          .returning({ id: devices.id });
        if (!row) return false;
        await tx.delete(tillSessions).where(eq(tillSessions.deviceId, row.id));
        return true;
      });
      if (!found) return reply.code(404).send(notFound('Gerät'));
      return { ok: true };
    },
  );
}

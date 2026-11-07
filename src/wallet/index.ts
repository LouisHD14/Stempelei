import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { cardUrl, loadCard, TOKEN_PATTERN } from '../cards.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { appleRegistrations, businesses, cards, programs } from '../db/schema.js';
import { onAnyCardChange, onProgramChange } from '../live.js';
import { type AppleConfig, buildPkpass, checkPassAuth, type Pusher } from './apple.js';
import { type GoogleConfig, type googleApi, saveUrl } from './google.js';

export interface Wallet {
  apple?: { cfg: AppleConfig; pusher: Pusher };
  google?: { cfg: GoogleConfig; api: ReturnType<typeof googleApi> };
}

/** Bilder im Apple-Pass, erzeugt mit tools/wallet-images.mjs */
export const APPLE_IMAGES = [
  'icon.png',
  'icon@2x.png',
  'icon@3x.png',
  'logo.png',
  'logo@2x.png',
  'logo@3x.png',
];

export function loadAppleImages(publicDir: string): Record<string, Buffer> {
  return Object.fromEntries(APPLE_IMAGES.map((f) => [f, readFileSync(join(publicDir, 'assets/wallet', f))]));
}

/** Die offiziellen Knöpfe müssen von Apple und Google geladen werden (Lizenz), siehe README. Ohne Datei kein Knopf. */
export function badgesPresent(publicDir: string) {
  const has = (file: string) =>
    ['de', 'en'].every((lang) => existsSync(join(publicDir, 'assets/wallet/badges', lang, file)));
  return { apple: has('apple.svg'), google: has('google.svg') };
}

const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const device = '^[A-Za-z0-9._-]{1,128}$';

export async function walletRoutes(
  app: FastifyInstance,
  { config, db, wallet, publicDir }: { config: Config; db: Db; wallet: Wallet; publicDir: string },
): Promise<void> {
  const badges = badgesPresent(publicDir);
  const enabled = {
    apple: Boolean(wallet.apple && badges.apple),
    google: Boolean(wallet.google && badges.google),
  };
  const guestLimit = app.rateLimit({
    max: 30,
    timeWindow: 60_000,
    keyGenerator: (req) => `wallet|${req.ip}`,
  });
  const notFound = { error: 'not_found', message: 'Diese Karte gibt es nicht.' };
  const tokenParam = {
    params: {
      type: 'object',
      required: ['token'],
      properties: { token: { type: 'string', pattern: TOKEN_PATTERN } },
    },
  };

  // Welche Knöpfe die Gast-Ansicht zeigt
  app.get('/api/public/wallet', async (_req, reply) =>
    reply.header('Cache-Control', 'no-cache').send(enabled),
  );

  app.get<{ Params: { token: string } }>(
    '/api/public/cards/:token/wallet/apple',
    { preHandler: guestLimit, schema: tokenParam },
    async (req, reply) => {
      if (!wallet.apple) return reply.code(404).send(notFound);
      const card = await loadCard(db, { token: req.params.token });
      if (!card) return reply.code(404).send(notFound);
      const pkpass = buildPkpass(wallet.apple.cfg, card.id, card.view, cardUrl(config.publicUrl, card.token));
      return reply
        .type('application/vnd.apple.pkpass')
        .header('Content-Disposition', 'attachment; filename="stempelkarte.pkpass"')
        .header('Cache-Control', 'no-store')
        .send(pkpass);
    },
  );

  app.get<{ Params: { token: string } }>(
    '/api/public/cards/:token/wallet/google',
    { preHandler: guestLimit, schema: tokenParam },
    async (req, reply) => {
      if (!wallet.google) return reply.code(404).send(notFound);
      const card = await loadCard(db, { token: req.params.token });
      if (!card) return reply.code(404).send(notFound);
      const url = saveUrl(
        wallet.google.cfg,
        card.programId,
        card.id,
        card.view,
        cardUrl(config.publicUrl, card.token),
      );
      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .redirect(url, 302);
    },
  );

  if (wallet.apple) appleWebService(app, { config, db, apple: wallet.apple });
}

/**
 * Der Web-Service, den iPhones für Pässe aufrufen (Apple „Wallet Passes Web Service“).
 * Basis: <PUBLIC_URL>/wallet/apple, steht als webServiceURL im Pass.
 */
function appleWebService(
  app: FastifyInstance,
  { config, db, apple }: { config: Config; db: Db; apple: NonNullable<Wallet['apple']> },
) {
  const { cfg } = apple;
  const base = '/wallet/apple/v1';
  const limit = app.rateLimit({ max: 120, timeWindow: 60_000, keyGenerator: (req) => `apple|${req.ip}` });
  const params = (props: Record<string, string>) => ({
    params: {
      type: 'object',
      required: Object.keys(props),
      properties: Object.fromEntries(
        Object.entries(props).map(([k, p]) => [k, { type: 'string', pattern: p }]),
      ),
    },
  });
  const passType = `^${cfg.passTypeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  type Reg = { device: string; passType: string; serial: string };

  // Gerät meldet sich für Updates eines Passes an
  app.post<{ Params: Reg; Body: { pushToken: string } }>(
    `${base}/devices/:device/registrations/:passType/:serial`,
    {
      preHandler: limit,
      schema: {
        ...params({ device, passType, serial: uuid }),
        body: {
          type: 'object',
          required: ['pushToken'],
          properties: { pushToken: { type: 'string', pattern: '^[0-9a-fA-F]{32,200}$' } },
        },
      },
    },
    async (req, reply) => {
      if (!checkPassAuth(cfg, req.params.serial, req.headers.authorization)) return reply.code(401).send();
      const card = await loadCard(db, { id: req.params.serial });
      if (!card) return reply.code(401).send();
      // 200 schon bekannt (nur das Token aktualisieren), 201 neu angemeldet
      const known = await db
        .update(appleRegistrations)
        .set({ pushToken: req.body.pushToken })
        .where(
          and(eq(appleRegistrations.deviceId, req.params.device), eq(appleRegistrations.cardId, card.id)),
        )
        .returning({ cardId: appleRegistrations.cardId });
      if (known.length) return reply.code(200).send();
      await db
        .insert(appleRegistrations)
        .values({ deviceId: req.params.device, cardId: card.id, pushToken: req.body.pushToken })
        .onConflictDoNothing();
      return reply.code(201).send();
    },
  );

  // Welche Pässe dieses Geräts haben sich seit dem letzten Abruf geändert?
  app.get<{ Params: Omit<Reg, 'serial'>; Querystring: { passesUpdatedSince?: string } }>(
    `${base}/devices/:device/registrations/:passType`,
    {
      preHandler: limit,
      schema: {
        ...params({ device, passType }),
        querystring: {
          type: 'object',
          properties: { passesUpdatedSince: { type: 'string', pattern: '^[0-9]{1,16}$' } },
        },
      },
    },
    async (req, reply) => {
      const since = Number(req.query.passesUpdatedSince ?? 0);
      // Auf Millisekunden gekürzt, weil lastUpdated für Apple nur Millisekunden hat (Postgres speichert Mikrosekunden)
      const changed = sql<Date>`date_trunc('milliseconds', greatest(${cards.lastActivityAt}, ${programs.updatedAt}))`;
      const rows = await db
        .select({ serial: cards.id, updated: changed })
        .from(appleRegistrations)
        .innerJoin(cards, eq(cards.id, appleRegistrations.cardId))
        .innerJoin(programs, eq(programs.id, cards.programId))
        .where(
          and(
            eq(appleRegistrations.deviceId, req.params.device),
            sql`${changed} > to_timestamp(${since} / 1000.0)`,
          ),
        );
      if (!rows.length) return reply.code(204).send();
      const last = Math.max(...rows.map((r) => new Date(r.updated).getTime()));
      return { serialNumbers: rows.map((r) => r.serial), lastUpdated: String(last) };
    },
  );

  // Aktuellen Pass abholen
  app.get<{ Params: Omit<Reg, 'device'> }>(
    `${base}/passes/:passType/:serial`,
    { preHandler: limit, schema: params({ passType, serial: uuid }) },
    async (req, reply) => {
      if (!checkPassAuth(cfg, req.params.serial, req.headers.authorization)) return reply.code(401).send();
      const card = await loadCard(db, { id: req.params.serial });
      if (!card) return reply.code(401).send();
      const modified = new Date(Math.floor(card.updatedAt.getTime() / 1000) * 1000);
      const since = Date.parse(String(req.headers['if-modified-since'] ?? ''));
      if (!Number.isNaN(since) && modified.getTime() <= since) return reply.code(304).send();
      return reply
        .type('application/vnd.apple.pkpass')
        .header('Last-Modified', modified.toUTCString())
        .header('Cache-Control', 'no-store')
        .send(buildPkpass(cfg, card.id, card.view, cardUrl(config.publicUrl, card.token)));
    },
  );

  // Gerät hat den Pass gelöscht
  app.delete<{ Params: Reg }>(
    `${base}/devices/:device/registrations/:passType/:serial`,
    { preHandler: limit, schema: params({ device, passType, serial: uuid }) },
    async (req, reply) => {
      if (!checkPassAuth(cfg, req.params.serial, req.headers.authorization)) return reply.code(401).send();
      await db
        .delete(appleRegistrations)
        .where(
          and(
            eq(appleRegistrations.deviceId, req.params.device),
            eq(appleRegistrations.cardId, req.params.serial),
          ),
        );
      return reply.code(200).send();
    },
  );

  // Fehlermeldungen von Wallet, hilfreich beim Einrichten
  app.post<{ Body: { logs?: unknown } }>(`${base}/log`, { preHandler: limit }, async (req, reply) => {
    const logs = Array.isArray(req.body?.logs)
      ? req.body.logs.slice(0, 20).map((l) => String(l).slice(0, 500))
      : [];
    if (logs.length) req.log.warn({ logs }, 'Meldungen von Apple Wallet');
    return reply.code(200).send();
  });
}

/**
 * Hält Wallet-Karten aktuell: Nach jeder Änderung bekommt Apple Wallet einen Push und Google ein PATCH.
 * Fehler werden nur protokolliert, die Kasse soll davon nichts merken.
 */
export function startWalletSync(db: Db, wallet: Wallet, publicUrl: URL, log: FastifyBaseLogger): () => void {
  const { apple, google } = wallet;
  if (!apple && !google) return () => {};

  async function pushAll(rows: { deviceId: string; cardId: string; pushToken: string }[]) {
    if (!apple) return;
    for (const r of rows) {
      const result = await apple.pusher.push(r.pushToken);
      if (result === 'gone') {
        await db
          .delete(appleRegistrations)
          .where(and(eq(appleRegistrations.deviceId, r.deviceId), eq(appleRegistrations.cardId, r.cardId)));
      } else if (result === 'error') {
        log.warn({ cardId: r.cardId }, 'Apple-Wallet-Push fehlgeschlagen');
      }
    }
  }

  const offCard = onAnyCardChange((cardId) => {
    void (async () => {
      if (apple) {
        await pushAll(
          await db.select().from(appleRegistrations).where(eq(appleRegistrations.cardId, cardId)),
        );
      }
      if (google) {
        const card = await loadCard(db, { id: cardId });
        if (card)
          await google.api.patchObject(card.programId, card.id, card.view, cardUrl(publicUrl, card.token));
      }
    })().catch((err: unknown) => log.warn({ err, cardId }, 'Wallet-Abgleich der Karte fehlgeschlagen'));
  });

  const offProgram = onProgramChange((programId) => {
    void (async () => {
      if (apple) {
        const ids = db.select({ id: cards.id }).from(cards).where(eq(cards.programId, programId));
        await pushAll(
          await db.select().from(appleRegistrations).where(inArray(appleRegistrations.cardId, ids)),
        );
      }
      if (google) {
        const [prog] = await db
          .select({ name: programs.name, ink: programs.ink, business: businesses.name })
          .from(programs)
          .innerJoin(businesses, eq(businesses.id, programs.businessId))
          .where(eq(programs.id, programId));
        // shortcut: nur die Klasse wird aktualisiert. Texte zur nächsten Prämie auf den einzelnen Karten folgen
        // mit dem nächsten Stempel. Bei vielen Karten pro Betrieb ggf. als Hintergrundjob alle Objekte nachziehen.
        if (prog) await google.api.patchClass(programId, prog);
      }
    })().catch((err: unknown) =>
      log.warn({ err, programId }, 'Wallet-Abgleich der Kartenart fehlgeschlagen'),
    );
  });

  return () => {
    offCard();
    offProgram();
    apple?.pusher.close();
  };
}

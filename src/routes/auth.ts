import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { dummyPasswordHash, hashPassword, hashToken, randomToken, verifyPassword } from '../auth/crypto.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { businesses, cards, devices, emailTokens, programs, sessions, users } from '../db/schema.js';
import { trialEndsAt } from '../domain/plans.js';
import type { Mailer } from '../mail.js';
import { LOCALES, type Locale, mailTexts } from '../mail-texts.js';

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;
const VERIFY_HOURS = 48;
const RESET_HOURS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const PASSWORD_MIN = 10;
// Argon2 hasht beliebig lange Eingaben, die Grenze schützt nur vor riesigen Anfragen
const PASSWORD_MAX = 200;

export interface AuthDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
}

export interface SessionUser {
  userId: string;
  businessId: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Gesetzt von requireUser */
    user?: SessionUser;
  }
}

const email = { type: 'string', format: 'email', minLength: 3, maxLength: 254 } as const;
const password = { type: 'string', minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX } as const;
const token = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } as const;
/** Sprache der Seite, aus der die Anfrage kommt. Bestimmt die Sprache der E-Mail. */
const locale = { type: 'string', enum: [...LOCALES] } as const;
const body = (properties: Record<string, object>, optional: Record<string, object> = {}) => ({
  body: {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties: { ...properties, ...optional },
  },
});

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

const normalizeEmail = (raw: string) => raw.trim().toLowerCase();

/** Lesbarer Teil plus Zufall, damit gleichnamige Betriebe sich nicht in die Quere kommen. */
export function businessSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${base || 'betrieb'}-${randomToken()
    .slice(0, 6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;
}

export async function authRoutes(app: FastifyInstance, { config, db, mailer }: AuthDeps): Promise<void> {
  const secureCookie = config.publicUrl.protocol === 'https:';
  const link = (path: string, t: string) => new URL(`${path}#token=${t}`, config.publicUrl).href;

  // Ratenbegrenzung: pro IP und zusätzlich pro E-Mail-Adresse (gegen verteilte Versuche auf ein Konto)
  const perIp = (max: number, minutes: number) =>
    app.rateLimit({
      max,
      timeWindow: minutes * 60_000,
      keyGenerator: (req) => `${req.routeOptions.url}|ip:${req.ip}`,
    });
  const perEmail = (max: number, minutes: number) =>
    app.rateLimit({
      max,
      timeWindow: minutes * 60_000,
      keyGenerator: (req) => {
        const e = (req.body as { email?: unknown } | undefined)?.email;
        return `${req.routeOptions.url}|${typeof e === 'string' ? `email:${normalizeEmail(e)}` : `ip:${req.ip}`}`;
      },
    });
  // shortcut: Zähler liegen im Speicher des Prozesses, gilt nur bei einer Instanz. Bei mehreren Instanzen auf Redis umstellen.
  const loginLimit = [perIp(10, 15), perEmail(10, 15)];
  const mailLimit = [perIp(5, 60), perEmail(3, 60)];
  const tokenLimit = [perIp(20, 15)];

  async function createToken(userId: string, purpose: 'verify' | 'reset'): Promise<string> {
    const t = randomToken();
    const hours = purpose === 'verify' ? VERIFY_HOURS : RESET_HOURS;
    await db.insert(emailTokens).values({
      tokenHash: hashToken(t),
      userId,
      purpose,
      expiresAt: new Date(Date.now() + hours * HOUR_MS),
    });
    return t;
  }

  /** Löst ein Token genau einmal ein. Liefert die Nutzer-ID oder null. */
  async function consumeToken(t: string, purpose: 'verify' | 'reset'): Promise<string | null> {
    const [row] = await db
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailTokens.tokenHash, hashToken(t)),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: emailTokens.userId });
    return row?.userId ?? null;
  }

  async function startSession(reply: FastifyReply, userId: string): Promise<void> {
    const t = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);
    await db.insert(sessions).values({ idHash: hashToken(t), userId, expiresAt });
    reply.setCookie(SESSION_COOKIE, t, {
      path: '/',
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'lax',
      expires: expiresAt,
    });
  }

  async function sendVerifyMail(userId: string, to: string, lang: Locale): Promise<void> {
    const t = await createToken(userId, 'verify');
    await mailer.send({ to, ...mailTexts.verify(lang, link('/verify', t), VERIFY_HOURS) });
  }

  /** Liest die Sitzung aus dem Cookie. Abgelaufene Sitzungen zählen nicht. */
  async function sessionUser(req: FastifyRequest): Promise<SessionUser | null> {
    const t = req.cookies[SESSION_COOKIE];
    if (!t || t.length > 100) return null;
    const [row] = await db
      .select({ userId: users.id, businessId: users.businessId, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(businesses, eq(businesses.id, users.businessId))
      .where(
        and(
          eq(sessions.idHash, hashToken(t)),
          gt(sessions.expiresAt, new Date()),
          isNull(businesses.deletedAt),
        ),
      );
    return row ?? null;
  }

  const requireUser: preHandlerHookHandler = async (req, reply) => {
    const u = await sessionUser(req);
    if (!u) return reply.code(401).send({ error: 'unauthorized', message: 'Bitte melde dich an.' });
    req.user = u;
  };
  app.decorate('requireUser', requireUser);

  app.post<{ Body: { businessName: string; email: string; password: string; locale?: Locale } }>(
    '/api/auth/register',
    {
      preHandler: mailLimit,
      schema: body(
        { businessName: { type: 'string', minLength: 2, maxLength: 80 }, email, password },
        { locale },
      ),
    },
    async (req, reply) => {
      const addr = normalizeEmail(req.body.email);
      const lang = req.body.locale ?? 'de';
      const name = req.body.businessName.trim();
      if (name.length < 2) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'Bitte gib den Namen deines Betriebs an.' });
      }
      const passwordHash = await hashPassword(req.body.password);
      const userId = await db
        .transaction(async (tx) => {
          const [taken] = await tx
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.email}) = ${addr}`);
          if (taken) return null;
          const [biz] = await tx
            .insert(businesses)
            .values({ name, slug: businessSlug(name), trialEndsAt: trialEndsAt(new Date()) })
            .returning({ id: businesses.id });
          if (!biz) throw new Error('Betrieb wurde nicht angelegt');
          const [u] = await tx
            .insert(users)
            .values({ businessId: biz.id, email: addr, passwordHash, locale: lang })
            .returning({ id: users.id });
          return u?.id ?? null;
        })
        // Zwei gleichzeitige Anmeldungen mit derselben Adresse: der eindeutige Index entscheidet
        .catch((err: unknown) => {
          if (isUniqueViolation(err)) return null;
          throw err;
        });

      if (userId) {
        await sendVerifyMail(userId, addr, lang);
      } else {
        // Gleiche Antwort wie bei einem neuen Konto, damit niemand fremde Adressen abfragen kann
        const forgot = new URL('/forgot-password', config.publicUrl).href;
        await mailer.send({ to: addr, ...mailTexts.alreadyRegistered(lang, forgot) });
      }
      return reply.code(201).send({ ok: true });
    },
  );

  app.post<{ Body: { token: string } }>(
    '/api/auth/verify',
    { preHandler: tokenLimit, schema: body({ token }) },
    async (req, reply) => {
      const userId = await consumeToken(req.body.token, 'verify');
      if (!userId) {
        return reply.code(400).send({
          error: 'invalid_token',
          message:
            'Dieser Link ist abgelaufen oder wurde schon benutzt. Melde dich an, um einen neuen zu bekommen.',
        });
      }
      await db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
      await startSession(reply, userId);
      return { ok: true };
    },
  );

  app.post<{ Body: { email: string; locale?: Locale } }>(
    '/api/auth/verify/resend',
    { preHandler: mailLimit, schema: body({ email }, { locale }) },
    async (req) => {
      const addr = normalizeEmail(req.body.email);
      const [u] = await db
        .select({ id: users.id, verified: users.emailVerifiedAt, locale: users.locale })
        .from(users)
        .where(sql`lower(${users.email}) = ${addr}`);
      if (u && !u.verified) await sendVerifyMail(u.id, addr, req.body.locale ?? u.locale);
      return { ok: true };
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    {
      preHandler: loginLimit,
      // Beim Login keine Mindestlänge prüfen, sonst verrät die Fehlermeldung die Regel für alte Passwörter
      schema: body({ email, password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX } }),
    },
    async (req, reply) => {
      const addr = normalizeEmail(req.body.email);
      const [u] = await db
        .select({ id: users.id, passwordHash: users.passwordHash, verified: users.emailVerifiedAt })
        .from(users)
        .innerJoin(businesses, eq(businesses.id, users.businessId))
        .where(and(sql`lower(${users.email}) = ${addr}`, isNull(businesses.deletedAt)));
      const ok = await verifyPassword(u?.passwordHash ?? (await dummyPasswordHash()), req.body.password);
      if (!u || !ok) {
        return reply
          .code(401)
          .send({ error: 'invalid_credentials', message: 'E-Mail-Adresse oder Passwort stimmen nicht.' });
      }
      if (!u.verified) {
        return reply.code(403).send({
          error: 'email_not_verified',
          message: 'Bitte bestätige zuerst deine E-Mail-Adresse. Den Link findest du in deinem Postfach.',
        });
      }
      await startSession(reply, u.id);
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await db.delete(sessions).where(eq(sessions.idHash, hashToken(t)));
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: secureCookie, sameSite: 'lax' });
    return { ok: true };
  });

  app.post<{ Body: { email: string; locale?: Locale } }>(
    '/api/auth/password-reset/request',
    { preHandler: mailLimit, schema: body({ email }, { locale }) },
    async (req) => {
      const addr = normalizeEmail(req.body.email);
      const [u] = await db
        .select({ id: users.id, locale: users.locale })
        .from(users)
        .where(sql`lower(${users.email}) = ${addr}`);
      if (u) {
        const t = await createToken(u.id, 'reset');
        const lang = req.body.locale ?? u.locale;
        await mailer.send({ to: addr, ...mailTexts.reset(lang, link('/reset-password', t), RESET_HOURS) });
      }
      return { ok: true };
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/api/auth/password-reset/confirm',
    { preHandler: tokenLimit, schema: body({ token, password }) },
    async (req, reply) => {
      const passwordHash = await hashPassword(req.body.password);
      const userId = await consumeToken(req.body.token, 'reset');
      if (!userId) {
        return reply.code(400).send({
          error: 'invalid_token',
          message: 'Dieser Link ist abgelaufen oder wurde schon benutzt. Fordere einen neuen an.',
        });
      }
      await db.transaction(async (tx) => {
        // Der Link kam per E-Mail an, damit ist die Adresse auch bestätigt
        await tx
          .update(users)
          .set({ passwordHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
          .where(eq(users.id, userId));
        // Alle alten Sitzungen beenden, falls jemand Fremdes angemeldet war
        await tx.delete(sessions).where(eq(sessions.userId, userId));
      });
      return { ok: true };
    },
  );

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => {
    const u = req.user as SessionUser;
    const [biz] = await db
      .select({
        name: businesses.name,
        plan: businesses.plan,
        subscriptionStatus: businesses.subscriptionStatus,
        trialEndsAt: businesses.trialEndsAt,
      })
      .from(businesses)
      .where(eq(businesses.id, u.businessId));
    // Fortschritt für die Checkliste im Dashboard
    const any = async (rows: Promise<unknown[]>) => (await rows).length > 0;
    const [cardDesigned, tillSetUp, firstCardIssued] = await Promise.all([
      any(
        db
          .select({ id: programs.id })
          .from(programs)
          .where(and(eq(programs.businessId, u.businessId), isNull(programs.archivedAt)))
          .limit(1),
      ),
      any(
        db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.businessId, u.businessId), isNull(devices.revokedAt)))
          .limit(1),
      ),
      any(db.select({ id: cards.id }).from(cards).where(eq(cards.businessId, u.businessId)).limit(1)),
    ]);
    return {
      user: { email: u.email },
      business: biz,
      steps: { cardDesigned, tillSetUp, firstCardIssued, planChosen: biz?.subscriptionStatus === 'active' },
    };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: preHandlerHookHandler;
  }
}

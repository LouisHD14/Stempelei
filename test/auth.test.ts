import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/crypto.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { businesses, emailTokens, sessions, users } from '../src/db/schema.js';
import type { Mail } from '../src/mail.js';
import { businessSlug } from '../src/routes/auth.js';

describe('businessSlug', () => {
  it('macht aus dem Namen einen lesbaren Teil mit Zufall', () => {
    assert.match(businessSlug('Café Müller & Söhne'), /^cafe-mueller-soehne-[a-z0-9]{6}$/);
    assert.match(businessSlug('!!!'), /^betrieb-[a-z0-9]{6}$/);
    assert.notEqual(businessSlug('Mia'), businessSlug('Mia'));
  });
});

// Diese Tests löschen den Inhalt der Datenbank. Sie laufen nur mit einer eigenen Test-Datenbank.
const url = process.env.TEST_DATABASE_URL;

describe('Konten', { skip: url ? false : 'TEST_DATABASE_URL ist nicht gesetzt' }, () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url ?? '',
    PUBLIC_URL: 'https://stempelei.test',
  });
  const ORIGIN = config.publicUrl.origin;
  let conn: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let mails: Mail[] = [];
  let ipCounter = 0;
  // Jeder Test bekommt eine eigene IP, damit die Ratenbegrenzung nur dort greift, wo sie getestet wird
  let ip = '';

  const post = (path: string, payload: object, cookie?: string) =>
    app.inject({
      method: 'POST',
      url: path,
      payload,
      remoteAddress: ip,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    });
  const me = (cookie?: string) =>
    app.inject({ url: '/api/auth/me', remoteAddress: ip, headers: cookie ? { cookie } : {} });
  const sessionCookie = (res: LightMyRequestResponse) => {
    const c = res.cookies.find((x) => x.name === 'sid');
    assert.ok(c, 'Sitzungs-Cookie fehlt');
    return `sid=${c.value}`;
  };
  const tokenFrom = (mail: Mail | undefined, path: string) => {
    assert.ok(mail, 'E-Mail fehlt');
    const m = new RegExp(`https://stempelei\\.test${path}#token=([A-Za-z0-9_-]{43})`).exec(mail.text);
    assert.ok(m?.[1], `Link ${path} fehlt in: ${mail.text}`);
    return m[1];
  };
  /** Legt ein bestätigtes Konto an und liefert das Sitzungs-Cookie. */
  async function verifiedAccount(email: string, password = 'richtig-langes-passwort') {
    assert.equal(
      (await post('/api/auth/register', { businessName: 'Café Test', email, password })).statusCode,
      201,
    );
    const res = await post('/api/auth/verify', { token: tokenFrom(mails.at(-1), '/bestaetigen') });
    assert.equal(res.statusCode, 200);
    return sessionCookie(res);
  }

  before(async () => {
    const admin = createDb(url as string, { max: 1 });
    await admin.sql.unsafe(
      'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
    );
    await admin.close();
    await runMigrations(url as string);
    conn = createDb(url as string, { max: 4 });
    app = await buildApp({
      config,
      pingDb: conn.ping,
      db: conn.db,
      mailer: {
        send: async (m) => {
          mails.push(m);
        },
      },
    });
  });
  after(async () => {
    await app?.close();
    await conn?.close();
  });
  beforeEach(() => {
    mails = [];
    ip = `10.0.0.${++ipCounter}`;
  });

  it('Registrieren, Bestätigen, Konto ansehen, Abmelden', async () => {
    const reg = await post('/api/auth/register', {
      businessName: '  Trattoria Mia ',
      email: 'Mia@Example.org',
      password: 'richtig-langes-passwort',
    });
    assert.equal(reg.statusCode, 201);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]?.to, 'mia@example.org');

    // Vor der Bestätigung: Passwort stimmt, aber Login ist noch gesperrt
    const early = await post('/api/auth/login', {
      email: 'mia@example.org',
      password: 'richtig-langes-passwort',
    });
    assert.equal(early.statusCode, 403);
    assert.equal(early.json().error, 'email_not_verified');

    const token = tokenFrom(mails[0], '/bestaetigen');
    const verify = await post('/api/auth/verify', { token });
    assert.equal(verify.statusCode, 200);
    const sid = verify.cookies.find((c) => c.name === 'sid');
    assert.ok(sid);
    assert.equal(sid.httpOnly, true);
    assert.equal(sid.secure, true);
    assert.equal(sid.sameSite, 'Lax');

    // Der Link funktioniert nur einmal
    assert.equal((await post('/api/auth/verify', { token })).statusCode, 400);

    const cookie = `sid=${sid.value}`;
    const res = await me(cookie);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.user.email, 'mia@example.org');
    assert.equal(body.business.name, 'Trattoria Mia');
    assert.equal(body.business.plan, 'klein');
    assert.equal(body.business.subscriptionStatus, 'trialing');
    const trialDays = (new Date(body.business.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(trialDays > 13.9 && trialDays <= 14, `Testphase ${trialDays} Tage`);

    // Im Cookie steht das Token, in der Datenbank nur sein Hash
    const rows = await conn.db
      .select()
      .from(sessions)
      .where(eq(sessions.idHash, hashToken(sid.value)));
    assert.equal(rows.length, 1);

    assert.equal((await post('/api/auth/logout', {}, cookie)).statusCode, 200);
    assert.equal((await me(cookie)).statusCode, 401);
  });

  it('Login mit richtigem und falschem Passwort', async () => {
    await verifiedAccount('login@example.org');
    const ok = await post('/api/auth/login', {
      email: 'LOGIN@example.org',
      password: 'richtig-langes-passwort',
    });
    assert.equal(ok.statusCode, 200);
    assert.equal((await me(sessionCookie(ok))).statusCode, 200);

    const wrong = await post('/api/auth/login', {
      email: 'login@example.org',
      password: 'falsches-passwort',
    });
    const unknown = await post('/api/auth/login', {
      email: 'niemand@example.org',
      password: 'falsches-passwort',
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    // Gleiche Antwort, egal ob es das Konto gibt
    assert.deepEqual(wrong.json(), unknown.json());
  });

  it('verrät bei doppelter Registrierung nicht, dass die Adresse vergeben ist', async () => {
    await verifiedAccount('doppelt@example.org');
    mails = [];
    const again = await post('/api/auth/register', {
      businessName: 'Anderer Betrieb',
      email: 'DOPPELT@example.org',
      password: 'noch-ein-passwort-123',
    });
    assert.equal(again.statusCode, 201);
    assert.equal(mails.length, 1);
    assert.match(mails[0]?.subject ?? '', /schon ein Konto/);
    const owners = await conn.db.select().from(users).where(eq(users.email, 'doppelt@example.org'));
    assert.equal(owners.length, 1);
    const named = await conn.db.select().from(businesses).where(eq(businesses.name, 'Anderer Betrieb'));
    assert.equal(named.length, 0, 'Kein zweiter Betrieb ohne Inhaber');
  });

  it('Bestätigungslink neu senden', async () => {
    await post('/api/auth/register', {
      businessName: 'Später',
      email: 'spaet@example.org',
      password: 'richtig-langes-passwort',
    });
    mails = [];
    assert.equal((await post('/api/auth/verify/resend', { email: 'spaet@example.org' })).statusCode, 200);
    assert.equal(
      (await post('/api/auth/verify/resend', { email: 'gibtsnicht@example.org' })).statusCode,
      200,
    );
    assert.equal(mails.length, 1);
    assert.equal(
      (await post('/api/auth/verify', { token: tokenFrom(mails[0], '/bestaetigen') })).statusCode,
      200,
    );
  });

  it('Passwort zurücksetzen beendet alte Sitzungen', async () => {
    const oldCookie = await verifiedAccount('reset@example.org', 'altes-passwort-123');
    mails = [];
    assert.equal(
      (await post('/api/auth/password-reset/request', { email: 'niemand@example.org' })).statusCode,
      200,
    );
    assert.equal(mails.length, 0);
    assert.equal(
      (await post('/api/auth/password-reset/request', { email: 'Reset@example.org' })).statusCode,
      200,
    );
    const token = tokenFrom(mails[0], '/passwort-neu');

    const short = await post('/api/auth/password-reset/confirm', { token, password: 'kurz' });
    assert.equal(short.statusCode, 400);
    const done = await post('/api/auth/password-reset/confirm', { token, password: 'neues-passwort-456' });
    assert.equal(done.statusCode, 200);
    assert.equal(
      (await post('/api/auth/password-reset/confirm', { token, password: 'noch-ein-neues-789' })).statusCode,
      400,
    );

    assert.equal((await me(oldCookie)).statusCode, 401);
    const oldPw = await post('/api/auth/login', {
      email: 'reset@example.org',
      password: 'altes-passwort-123',
    });
    assert.equal(oldPw.statusCode, 401);
    const newPw = await post('/api/auth/login', {
      email: 'reset@example.org',
      password: 'neues-passwort-456',
    });
    assert.equal(newPw.statusCode, 200);
  });

  it('abgelaufene Links gelten nicht', async () => {
    await post('/api/auth/register', {
      businessName: 'Zu spät',
      email: 'abgelaufen@example.org',
      password: 'richtig-langes-passwort',
    });
    const token = tokenFrom(mails[0], '/bestaetigen');
    await conn.db
      .update(emailTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailTokens.tokenHash, hashToken(token)));
    assert.equal((await post('/api/auth/verify', { token })).statusCode, 400);
  });

  it('prüft Eingaben', async () => {
    const cases: [string, object][] = [
      ['/api/auth/register', { businessName: 'X', email: 'a@b.de', password: 'richtig-langes-passwort' }],
      [
        '/api/auth/register',
        { businessName: 'Gut', email: 'keine-adresse', password: 'richtig-langes-passwort' },
      ],
      ['/api/auth/register', { businessName: 'Gut', email: 'a@b.de', password: 'kurz' }],
      ['/api/auth/register', { businessName: 'Gut', email: 'a@b.de', password: 'x'.repeat(201) }],
      ['/api/auth/register', { businessName: '   ', email: 'a@b.de', password: 'richtig-langes-passwort' }],
      ['/api/auth/verify', { token: 'zu-kurz' }],
    ];
    for (const [path, payload] of cases) {
      const res = await post(path, payload);
      assert.equal(res.statusCode, 400, `${path} ${JSON.stringify(payload)}`);
      // Verständliche deutsche Meldung statt der technischen aus der Schema-Prüfung
      assert.doesNotMatch(res.json().message, /must|body\//, path);
    }
    const short = await post('/api/auth/register', {
      businessName: 'Gut',
      email: 'a@b.de',
      password: 'kurz',
    });
    assert.equal(short.json().message, 'Das Passwort braucht mindestens 10 Zeichen.');
    assert.equal(mails.length, 0);
    // Unbekannte Felder entfernt Fastify, statt sie abzulehnen. Sie dürfen nichts bewirken.
    const extra = await post('/api/auth/login', { email: 'a@b.de', password: 'egal', admin: true });
    assert.equal(extra.statusCode, 401);
  });

  it('lehnt Anfragen von fremden Seiten ab', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.de', password: 'egal' },
      remoteAddress: ip,
      headers: { origin: 'https://boese.example' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('ignoriert ungültige Cookies', async () => {
    assert.equal((await me('sid=quatsch')).statusCode, 401);
    assert.equal((await me(`sid=${'x'.repeat(500)}`)).statusCode, 401);
  });

  it('begrenzt Login-Versuche', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await post('/api/auth/login', { email: 'brute@example.org', password: `versuch-${i}` });
      codes.push(res.statusCode);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
    assert.equal(codes[10], 429);
    const blocked = await post('/api/auth/login', { email: 'brute@example.org', password: 'noch-einer' });
    assert.match(blocked.json().message, /Zu viele Versuche/);
  });

  it('liefert die Konto-Seiten ohne .html aus', async () => {
    for (const path of [
      '/registrieren',
      '/anmelden',
      '/bestaetigen',
      '/passwort-vergessen',
      '/passwort-neu',
      '/konto',
    ]) {
      const res = await app.inject(path);
      assert.equal(res.statusCode, 200, path);
      assert.match(res.body, new RegExp(`data-page="${path.slice(1)}"`), path);
    }
  });
});

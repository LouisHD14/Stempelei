import assert from 'node:assert/strict';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Mail } from '../src/mail.js';

// Diese Tests löschen den Inhalt der Datenbank. Sie laufen nur mit einer eigenen Test-Datenbank.
export const TEST_DB = process.env.TEST_DATABASE_URL;
export const skipWithoutDb = TEST_DB ? false : 'TEST_DATABASE_URL ist nicht gesetzt';
export const ORIGIN = 'https://stempelei.test';

let ipCounter = 0;

/** App mit leerer Datenbank und Mail-Postfach im Speicher. */
export async function setupApp() {
  const url = TEST_DB as string;
  const admin = createDb(url, { max: 1 });
  await admin.sql.unsafe(
    'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
  );
  await admin.close();
  await runMigrations(url);
  const conn = createDb(url, { max: 4 });
  const mails: Mail[] = [];
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, PUBLIC_URL: ORIGIN });
  const app: FastifyInstance = await buildApp({
    config,
    pingDb: conn.ping,
    db: conn.db,
    mailer: {
      send: async (m) => {
        mails.push(m);
      },
    },
  });

  /** Eine Anfrage wie aus dem Browser: eigene IP pro Client, Origin der Seite, Cookies. */
  function client() {
    const ip = `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
    const jar = new Map<string, string>();
    const remember = (res: LightMyRequestResponse) => {
      for (const c of res.cookies) {
        if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
      return res;
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const send = async (opts: InjectOptions) =>
      remember(
        await app.inject({
          ...opts,
          remoteAddress: ip,
          headers: { origin: ORIGIN, ...(jar.size ? { cookie: cookie() } : {}), ...(opts.headers ?? {}) },
        }),
      );
    return {
      jar,
      get: (url: string) => send({ method: 'GET', url }),
      post: (url: string, payload: object = {}) => send({ method: 'POST', url, payload }),
      put: (url: string, payload: object) => send({ method: 'PUT', url, payload }),
      del: (url: string) => send({ method: 'DELETE', url }),
    };
  }

  /** Registriert einen Betrieb, bestätigt die Adresse und liefert einen angemeldeten Client. */
  async function owner(email: string, businessName = 'Café Test') {
    const c = client();
    const reg = await c.post('/api/auth/register', {
      businessName,
      email,
      password: 'richtig-langes-passwort',
    });
    assert.equal(reg.statusCode, 201);
    const mail = [...mails].reverse().find((m) => m.to === email);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1];
    assert.ok(token, 'Bestätigungslink fehlt');
    assert.equal((await c.post('/api/auth/verify', { token })).statusCode, 200);
    return c;
  }

  async function close() {
    await app.close();
    await conn.close();
  }

  return { app, conn, mails, client, owner, close };
}

export type TestApp = Awaited<ReturnType<typeof setupApp>>;

export const CAFE_CARD = {
  name: 'Café Test',
  earnRule: 'jedes Heißgetränk',
  ink: 'koralle',
  rewards: [
    { threshold: 5, text: 'Espresso' },
    { threshold: 10, text: 'Kuchen' },
  ],
};

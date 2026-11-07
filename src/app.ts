import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Mailer } from './mail.js';
import { authRoutes } from './routes/auth.js';
import { programRoutes } from './routes/programs.js';

export const PUBLIC_DIR = resolve(import.meta.dirname, '../public');

export interface AppDeps {
  config: Config;
  /** Prüft die Datenbank. Wirft, wenn sie nicht erreichbar ist. */
  pingDb: () => Promise<void>;
  /** Ohne Datenbank und Mailer startet nur die statische Website (für Tests ohne Datenbank). */
  db?: Db;
  mailer?: Mailer;
}

const DB_PING_TIMEOUT_MS = 2000;

/** Seiten, deren Adresse nicht dem Dateinamen entspricht. */
const PAGES: Record<string, string> = {
  '/dashboard/card': 'dashboard-card.html',
};

const VALIDATION_MESSAGES: Record<string, string> = {
  email: 'Bitte gib eine gültige E-Mail-Adresse ein.',
  password: 'Das Passwort braucht mindestens 10 Zeichen.',
  businessName: 'Der Name des Betriebs braucht 2 bis 80 Zeichen.',
  token: 'Dieser Link ist ungültig. Öffne ihn bitte direkt aus der E-Mail.',
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Zeitüberschreitung nach ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function buildApp({ config, pingDb, db, mailer }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    bodyLimit: 64 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Die Stempel-Grafiken setzen style-Attribute (Drehung), daher Inline-Styles erlaubt
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.nodeEnv === 'production' ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: config.nodeEnv === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  // Kamera für den Scanner an der Kasse erlauben, alles andere sperren
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  });

  // Schutz gegen CSRF: Schreibende Anfragen aus dem Browser müssen von der eigenen Seite kommen.
  // Ohne Origin-Header (curl, Server-zu-Server wie Stripe) gibt es kein Browser-Cookie zu missbrauchen.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== config.publicUrl.origin) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Anfrage von einer fremden Seite abgelehnt.' });
    }
  });

  await app.register(fastifyCookie);
  await app.register(rateLimit, { global: false });

  app.get('/api/health', async (_req, reply) => {
    try {
      await withTimeout(pingDb(), DB_PING_TIMEOUT_MS);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'Datenbank nicht erreichbar');
      return reply.code(503).send({ status: 'error', db: 'error' });
    }
  });

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    // /login liefert public/login.html
    extensions: ['html'],
    setHeaders(res, path) {
      res.header('Cache-Control', path.endsWith('.html') ? 'no-cache' : 'public, max-age=86400');
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: 'Diese Adresse gibt es nicht.' });
    }
    return reply.code(404).type('text/plain; charset=utf-8').send('Seite nicht gefunden.');
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const code = err.statusCode;
    const status = code !== undefined && code >= 400 && code < 600 ? code : 500;
    if (status >= 500) req.log.error({ err }, 'Unerwarteter Fehler');
    if (status === 429) {
      return reply.code(429).send({
        error: 'too_many_requests',
        message: 'Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.',
      });
    }
    if (err.validation) {
      // Die Meldungen der Schema-Prüfung sind englisch und technisch, deshalb eine eigene pro Feld
      const field = err.validation[0]?.instancePath.split('/')[1] ?? '';
      return reply.code(400).send({
        error: 'bad_request',
        field,
        message: VALIDATION_MESSAGES[field] ?? 'Bitte prüfe deine Eingaben.',
      });
    }
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'Etwas ist schiefgelaufen. Versuch es gleich noch einmal.' : err.message,
    });
  });

  // Erst nach setErrorHandler: Fastify merkt sich den Fehler-Handler beim Anlegen der Route
  if (db && mailer) {
    await authRoutes(app, { config, db, mailer });
    await programRoutes(app, { db });
  }

  // Seiten mit Unterpfad: /dashboard/card liefert public/dashboard-card.html
  for (const [path, file] of Object.entries(PAGES)) {
    app.get(path, (_req, reply) => reply.header('Cache-Control', 'no-cache').sendFile(file));
  }

  return app;
}

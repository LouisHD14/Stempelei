import { resolve } from 'node:path';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';

export const PUBLIC_DIR = resolve(import.meta.dirname, '../public');

export interface AppDeps {
  config: Config;
  /** Prüft die Datenbank. Wirft, wenn sie nicht erreichbar ist. */
  pingDb: () => Promise<void>;
}

const DB_PING_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Zeitüberschreitung nach ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function buildApp({ config, pingDb }: AppDeps): Promise<FastifyInstance> {
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
    index: ['index.html'],
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
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'Etwas ist schiefgelaufen. Versuch es gleich noch einmal.' : err.message,
    });
  });

  return app;
}

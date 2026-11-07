import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused@localhost/unused' });

describe('App ohne Datenbank', () => {
  let app: FastifyInstance;
  let dbUp = true;
  before(async () => {
    app = await buildApp({
      config,
      pingDb: async () => {
        if (!dbUp) throw new Error('down');
      },
    });
  });
  after(() => app.close());

  it('meldet Gesundheit', async () => {
    dbUp = true;
    const res = await app.inject('/api/health');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok', db: 'ok' });
  });

  it('meldet 503, wenn die Datenbank fehlt', async () => {
    dbUp = false;
    const res = await app.inject('/api/health');
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { status: 'error', db: 'error' });
  });

  it('liefert die Website mit Sicherheits-Headern aus', async () => {
    const res = await app.inject('/');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.match(res.body, /<title[^>]*>[^<]*Stempelei<\/title>/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(String(res.headers['permissions-policy']), /camera=\(self\)/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('liefert Assets mit Cache aus', async () => {
    const res = await app.inject('/assets/js/i18n.js');
    assert.equal(res.statusCode, 200);
    // Skripte werden bei jedem Aufruf geprüft, damit Updates sofort ankommen
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.ok(res.headers.etag);
    const again = await app.inject({
      url: '/assets/js/i18n.js',
      headers: { 'if-none-match': String(res.headers.etag) },
    });
    assert.equal(again.statusCode, 304);
    const font = await app.inject('/assets/fonts/geist-mono-latin-400-normal.woff2');
    assert.equal(font.headers['cache-control'], 'public, max-age=86400');
  });

  it('antwortet auf unbekannte API-Pfade mit JSON', async () => {
    const res = await app.inject('/api/gibt-es-nicht');
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'not_found');
  });

  it('lässt keinen Zugriff außerhalb von public zu', async () => {
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/assets/../../src/app.ts']) {
      const res = await app.inject(url);
      assert.notEqual(res.statusCode, 200, url);
      assert.doesNotMatch(res.body, /"name": "stempelei"|buildApp/, url);
    }
  });
});

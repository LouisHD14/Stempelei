import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { publicToken, SHORT_CODE_ALPHABET, shortCode } from '../src/domain/codes.js';
import { trialEndsAt } from '../src/domain/plans.js';

describe('publicToken', () => {
  it('hat 22 Zeichen aus Base62 und wiederholt sich nicht', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = publicToken();
      assert.match(t, /^[0-9A-Za-z]{22}$/);
      seen.add(t);
    }
    assert.equal(seen.size, 2000);
  });
});

describe('shortCode', () => {
  it('nutzt nur eindeutige Zeichen', () => {
    for (let i = 0; i < 500; i++) {
      const c = shortCode();
      assert.match(c, /^[2-9A-HJKMNP-Z]{6}$/);
    }
    for (const ch of '01ILO') assert.equal(SHORT_CODE_ALPHABET.includes(ch), false);
  });
});

describe('trialEndsAt', () => {
  it('endet nach 14 Tagen', () => {
    const start = new Date('2026-11-06T10:00:00Z');
    assert.equal(trialEndsAt(start).toISOString(), '2026-11-20T10:00:00.000Z');
  });
});

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };
  it('nutzt sinnvolle Vorgaben', () => {
    const c = loadConfig(base);
    assert.equal(c.port, 3000);
    assert.equal(c.nodeEnv, 'development');
    assert.equal(c.publicUrl.href, 'http://localhost:3000/');
    assert.equal(c.trustProxy, false);
  });
  it('meldet alle Fehler auf einmal', () => {
    try {
      loadConfig({ PORT: 'abc', NODE_ENV: 'prod', TRUST_PROXY: 'ja' });
      assert.fail('hätte werfen sollen');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 4);
    }
  });
  it('verlangt im Betrieb eine HTTPS-Adresse', () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /PUBLIC_URL fehlt/);
    assert.throws(
      () => loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'http://stempelei.de' }),
      /https/,
    );
    assert.equal(
      loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://stempelei.de' }).publicUrl.host,
      'stempelei.de',
    );
  });
});

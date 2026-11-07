import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { businesses, rewards } from '../src/db/schema.js';
import { CAFE_CARD, setupApp, skipWithoutDb, type TestApp } from './helpers.js';

describe('Stempelkarten', { skip: skipWithoutDb }, () => {
  let t: TestApp;
  before(async () => {
    t = await setupApp();
  });
  after(() => t?.close());

  it('anlegen, lesen, ändern', async () => {
    const c = await t.owner('karte@example.org');
    assert.deepEqual((await c.get('/api/programs')).json(), { programs: [], limit: 1 });

    const created = await c.post('/api/programs', CAFE_CARD);
    assert.equal(created.statusCode, 201);
    const prog = created.json().program;
    assert.equal(prog.name, 'Café Test');
    assert.deepEqual(
      prog.rewards.map((r: { threshold: number }) => r.threshold),
      [5, 10],
    );
    assert.equal((await c.get('/api/auth/me')).json().steps.cardDesigned, true);

    // Espresso behalten (mit ID), Kuchen entfernen, neue Prämie bei 8
    const espresso = prog.rewards[0];
    const kuchen = prog.rewards[1];
    const updated = await c.put(`/api/programs/${prog.id}`, {
      ...CAFE_CARD,
      name: '  Neuer Name ',
      rewards: [
        { id: espresso.id, threshold: 4, text: 'Espresso doppelt' },
        { threshold: 8, text: 'Croissant' },
      ],
    });
    assert.equal(updated.statusCode, 200);
    const after = updated.json().program;
    assert.equal(after.name, 'Neuer Name');
    assert.deepEqual(
      after.rewards.map((r: { id: string; threshold: number; text: string }) => [
        r.id === espresso.id,
        r.threshold,
        r.text,
      ]),
      [
        [true, 4, 'Espresso doppelt'],
        [false, 8, 'Croissant'],
      ],
    );
    // Entfernte Prämie ist nur archiviert
    const [old] = await t.conn.db.select().from(rewards).where(eq(rewards.id, kuchen.id));
    assert.ok(old?.archivedAt);
  });

  it('hält die Paketgrenze ein', async () => {
    const c = await t.owner('grenze@example.org', 'Grenze GmbH');
    assert.equal((await c.post('/api/programs', CAFE_CARD)).statusCode, 201);
    const second = await c.post('/api/programs', CAFE_CARD);
    assert.equal(second.statusCode, 403);
    assert.equal(second.json().error, 'plan_limit');

    // Paket Mittel erlaubt drei Karten
    await t.conn.db.update(businesses).set({ plan: 'mittel' }).where(eq(businesses.name, 'Grenze GmbH'));
    assert.equal((await c.post('/api/programs', CAFE_CARD)).statusCode, 201);
    assert.equal((await c.post('/api/programs', CAFE_CARD)).statusCode, 201);
    assert.equal((await c.post('/api/programs', CAFE_CARD)).statusCode, 403);
    assert.equal((await c.get('/api/programs')).json().limit, 3);
  });

  it('ein Betrieb kann die Karte eines anderen nicht ändern', async () => {
    const a = await t.owner('a@example.org', 'Betrieb A');
    const b = await t.owner('b@example.org', 'Betrieb B');
    const prog = (await a.post('/api/programs', CAFE_CARD)).json().program;
    const res = await b.put(`/api/programs/${prog.id}`, { ...CAFE_CARD, name: 'Gekapert' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual((await b.get('/api/programs')).json().programs, []);
    // Prämien-IDs einer fremden Karte werden nicht übernommen, sondern neu angelegt
    const own = (await b.post('/api/programs', CAFE_CARD)).json().program;
    const foreign = prog.rewards[0].id;
    const upd = await b.put(`/api/programs/${own.id}`, {
      ...CAFE_CARD,
      rewards: [{ id: foreign, threshold: 3, text: 'Fremd' }],
    });
    assert.equal(upd.statusCode, 200);
    assert.notEqual(upd.json().program.rewards[0].id, foreign);
    const [untouched] = await t.conn.db.select().from(rewards).where(eq(rewards.id, foreign));
    assert.equal(untouched?.text, 'Espresso');
    assert.equal(untouched?.archivedAt, null);
  });

  it('prüft Eingaben', async () => {
    const c = await t.owner('pruefen@example.org');
    const cases: [object, string | undefined][] = [
      [{ ...CAFE_CARD, name: '   ' }, 'name'],
      [{ ...CAFE_CARD, ink: 'pink' }, 'ink'],
      [{ ...CAFE_CARD, rewards: [] }, 'rewards'],
      [{ ...CAFE_CARD, rewards: [{ threshold: 21, text: 'Zu viel' }] }, 'rewards'],
      [{ ...CAFE_CARD, rewards: [{ threshold: 0, text: 'Null' }] }, 'rewards'],
      [{ ...CAFE_CARD, rewards: [{ threshold: 5, text: ' ' }] }, 'rewardText'],
      [
        {
          ...CAFE_CARD,
          rewards: [
            { threshold: 5, text: 'A' },
            { threshold: 5, text: 'B' },
          ],
        },
        'rewardThreshold',
      ],
      [
        { ...CAFE_CARD, rewards: Array.from({ length: 6 }, (_, i) => ({ threshold: i + 1, text: `P${i}` })) },
        'rewards',
      ],
    ];
    for (const [payload, field] of cases) {
      const res = await c.post('/api/programs', payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().field, field, JSON.stringify(payload));
    }
    assert.equal((await c.put('/api/programs/keine-uuid', CAFE_CARD)).statusCode, 400);
  });

  it('verlangt eine Anmeldung', async () => {
    const anon = t.client();
    assert.equal((await anon.get('/api/programs')).statusCode, 401);
    assert.equal((await anon.post('/api/programs', CAFE_CARD)).statusCode, 401);
  });

  it('liefert die Editor-Seite aus', async () => {
    const res = await t.client().get('/dashboard/card');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-page="dashboard-card"/);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { businesses, events, users } from '../src/db/schema.js';
import { CAFE_CARD, setupApp, skipWithoutDb, type TestApp } from './helpers.js';

describe('Statistik', { skip: skipWithoutDb }, () => {
  let t: TestApp;
  before(async () => {
    t = await setupApp();
  });
  after(() => t?.close());

  type Client = ReturnType<TestApp['client']>;

  /** Betrieb mit Karte (5 = Espresso, 10 = Kuchen), Team-Mitglied und angemeldeter Kasse. */
  async function shop(email: string, name: string) {
    const owner = await t.owner(email, name);
    const program = (await owner.post('/api/programs', CAFE_CARD)).json().program;
    await owner.post('/api/staff', { name: 'Anna', pin: '1234' });
    const { code } = (await owner.post('/api/devices/pairing-code')).json();
    const till = t.client();
    assert.equal((await till.post('/api/till/pair', { code, name: 'Tresen' })).statusCode, 200);
    assert.equal((await till.post('/api/till/pin', { pin: '1234' })).statusCode, 200);
    const [u] = await t.conn.db.select().from(users).where(eq(users.email, email));
    assert.ok(u);
    return { owner, till, program, businessId: u.businessId };
  }
  const issue = async (till: Client) => (await till.post('/api/till/cards', {})).json().card;
  const stamp = (till: Client, id: string, amount: number) =>
    till.post(`/api/till/cards/${id}/stamps`, { amount, idempotencyKey: randomUUID() });

  it('zählt Stempel, Einlösungen, Karten, Gäste und Prämien', async () => {
    const { owner, till, program, businessId } = await shop('stats@example.org', 'Stats Café');
    const a = await issue(till);
    const b = await issue(till);
    const c = await issue(till);
    await stamp(till, a.id, 3);
    await stamp(till, a.id, 2);
    await till.post(`/api/till/cards/${a.id}/redeem`, {
      rewardId: program.rewards[0].id,
      idempotencyKey: randomUUID(),
    });
    await stamp(till, b.id, 4); // b fehlt 1 Stempel bis Espresso
    await stamp(till, c.id, 1);
    // Zurückgenommen: zählt nirgends
    await stamp(till, c.id, 7);
    await till.post(`/api/till/cards/${c.id}/undo`, { idempotencyKey: randomUUID() });

    // Karte a war auch vor 3 Tagen da: zweiter Besuch
    await t.conn.db
      .update(events)
      .set({ createdAt: sql`now() - interval '3 days'` })
      .where(and(eq(events.cardId, a.id), eq(events.type, 'give'), eq(events.amount, 3)));
    // Ein Stempel vor 40 Tagen gehört in die Vorperiode
    await stamp(till, c.id, 2);
    await t.conn.db
      .update(events)
      .set({ createdAt: sql`now() - interval '40 days'` })
      .where(and(eq(events.cardId, c.id), eq(events.type, 'give'), eq(events.amount, 2)));

    const res = await owner.get('/api/stats');
    assert.equal(res.statusCode, 200);
    const s = res.json();
    assert.equal(s.range, '30d');
    assert.equal(s.series.length, 30);
    assert.deepEqual(s.totals, { stamps: 3 + 2 + 4 + 1, redeemed: 1, issued: 3 });
    assert.deepEqual(s.previous, { stamps: 2, redeemed: 0, issued: 0 });
    // Die Summe der Tage ergibt die Summe, der letzte Tag ist heute
    assert.equal(
      s.series.reduce((n: number, d: { stamps: number }) => n + d.stamps, 0),
      s.totals.stamps,
    );
    assert.equal(s.series.at(-4).stamps, 3);
    assert.deepEqual(s.guests, {
      activeCards: 3,
      returningCards: 1,
      avgVisits: Math.round((4 / 3) * 10) / 10,
    });
    assert.deepEqual(
      s.rewards.map((r: { text: string; redeemed: number }) => [r.text, r.redeemed]),
      [
        ['Espresso', 1],
        ['Kuchen', 0],
      ],
    );
    // b fehlt 1 bis Espresso, c hat 1 + 2 = 3 (2 fehlen), a hat Espresso eingelöst und 5 von 10 (5 fehlen)
    assert.equal(s.nearReward, 2);
    assert.deepEqual(s.allowedRanges, ['30d']);
    assert.equal(s.csv, false);
    assert.equal(businessId.length, 36);
  });

  it('längere Zeiträume und CSV nur im Paket Groß', async () => {
    const { owner, till, businessId } = await shop('gross@example.org', 'Gross GmbH');
    const card = await issue(till);
    await stamp(till, card.id, 2);
    assert.equal((await owner.get('/api/stats?range=90d')).json().error, 'plan_feature');
    assert.equal((await owner.get('/api/stats.csv')).statusCode, 403);

    await t.conn.db.update(businesses).set({ plan: 'gross' }).where(eq(businesses.id, businessId));
    const d90 = (await owner.get('/api/stats?range=90d')).json();
    assert.equal(d90.series.length, 90);
    assert.deepEqual(d90.allowedRanges, ['30d', '90d', '12m']);
    const m12 = (await owner.get('/api/stats?range=12m')).json();
    assert.equal(m12.bucket, 'month');
    assert.equal(m12.series.length, 12);
    assert.equal(m12.series.at(-1).stamps, 2);
    assert.match(m12.series.at(-1).date, /^\d{4}-\d{2}-01$/);

    const csv = await owner.get('/api/stats.csv?range=30d');
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], 'Zeitraum;Stempel;Einlösungen;Neue Karten');
    assert.equal(lines.length, 31);
    assert.match(lines.at(-1) ?? '', /;2;0;1$/);
    assert.equal((await owner.get('/api/stats?range=7d')).statusCode, 400);
  });

  it('jeder Betrieb sieht nur seine Zahlen', async () => {
    const empty = await t.owner('leer@example.org', 'Leer');
    const s = (await empty.get('/api/stats')).json();
    assert.deepEqual(s.totals, { stamps: 0, redeemed: 0, issued: 0 });
    assert.deepEqual(s.rewards, []);
    assert.equal(s.nearReward, 0);
    assert.equal((await t.client().get('/api/stats')).statusCode, 401);
  });

  it('liefert die Statistik-Seite', async () => {
    const res = await t.client().get('/dashboard/stats');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-page="dashboard-stats"/);
  });
});

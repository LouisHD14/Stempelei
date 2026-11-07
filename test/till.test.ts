import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { businesses, cards, events, pairingCodes, users } from '../src/db/schema.js';
import { onCardChange } from '../src/live.js';
import { CAFE_CARD, setupApp, skipWithoutDb, type TestApp } from './helpers.js';

type Client = ReturnType<TestApp['client']>;

describe('Kasse', { skip: skipWithoutDb }, () => {
  let t: TestApp;
  before(async () => {
    t = await setupApp();
  });
  after(() => t?.close());

  /** Betrieb mit Karte, Team-Mitglied „Anna“ (PIN 1234) und einer angemeldeten Kasse. */
  async function shop(email: string, name: string) {
    const owner = await t.owner(email, name);
    const program = (await owner.post('/api/programs', CAFE_CARD)).json().program;
    assert.equal((await owner.post('/api/staff', { name: 'Anna', pin: '1234' })).statusCode, 201);
    const till = await pair(owner, 'Tresen');
    assert.equal((await till.post('/api/till/pin', { pin: '1234' })).statusCode, 200);
    const [u] = await t.conn.db.select().from(users).where(eq(users.email, email));
    assert.ok(u);
    return { owner, till, program, businessId: u.businessId };
  }

  async function pair(owner: Client, name: string) {
    const { code } = (await owner.post('/api/devices/pairing-code')).json();
    const till = t.client();
    const res = await till.post('/api/till/pair', { code, name });
    assert.equal(res.statusCode, 200);
    return till;
  }

  const stamp = (c: Client, id: string, amount: number, key = randomUUID()) =>
    c.post(`/api/till/cards/${id}/stamps`, { amount, idempotencyKey: key });
  const redeem = (c: Client, id: string, rewardId: string, key = randomUUID()) =>
    c.post(`/api/till/cards/${id}/redeem`, { rewardId, idempotencyKey: key });

  it('Gerät freischalten: gültig, falsch, abgelaufen, schon benutzt', async () => {
    const owner = await t.owner('pair@example.org', 'Pair Bar');
    const { code } = (await owner.post('/api/devices/pairing-code')).json();

    const wrong = await t
      .client()
      .post('/api/till/pair', { code: code === '00000000' ? '11111111' : '00000000', name: 'X' });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error, 'invalid_code');
    assert.equal(
      (await t.client().post('/api/till/pair', { code: 'abc', name: 'X' })).json().error,
      'invalid_code',
    );

    const till = t.client();
    const ok = await till.post('/api/till/pair', { code, name: ' Tresen ' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().device.name, 'Tresen');
    assert.equal(ok.json().business.name, 'Pair Bar');
    const cookie = ok.cookies.find((c) => c.name === 'till_device');
    assert.ok(cookie?.httpOnly);
    assert.equal(cookie?.sameSite, 'Lax');
    assert.equal(cookie?.secure, true);

    // Jeder Code gilt nur einmal
    assert.equal(
      (await t.client().post('/api/till/pair', { code, name: 'Zweit' })).json().error,
      'invalid_code',
    );

    // Abgelaufen
    const { code: old } = (await owner.post('/api/devices/pairing-code')).json();
    await t.conn.db.update(pairingCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    assert.equal(
      (await t.client().post('/api/till/pair', { code: old, name: 'Spät' })).json().error,
      'invalid_code',
    );

    // Status ohne PIN-Sitzung
    const state = (await till.get('/api/till/state')).json();
    assert.equal(state.device.name, 'Tresen');
    assert.equal(state.tillAllowed, true);
    assert.equal(state.session, null);
    assert.deepEqual(state.staff, []);
    assert.deepEqual(state.programs, []);
    assert.equal((await t.client().get('/api/till/state')).json().error, 'device_required');
    const devs = (await owner.get('/api/devices')).json().devices;
    assert.ok(devs[0].lastSeenAt);
  });

  it('PIN-Anmeldung, Sperre nach 5 Fehlversuchen, Abmelden', async () => {
    const owner = await t.owner('pin@example.org', 'Pin Bar');
    await owner.post('/api/programs', CAFE_CARD);
    await owner.post('/api/staff', { name: 'Anna', pin: '1234' });
    const till = await pair(owner, 'Tresen');

    // Ohne Gerät keine PIN
    assert.equal((await t.client().post('/api/till/pin', { pin: '1234' })).json().error, 'device_required');
    // Aktionen brauchen eine PIN-Sitzung
    assert.equal((await till.get('/api/till/log')).json().error, 'pin_required');

    // Erfolg setzt den Zähler zurück
    for (let i = 0; i < 3; i++) await till.post('/api/till/pin', { pin: '0000' });
    const ok = await till.post('/api/till/pin', { pin: '1234' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().staff.name, 'Anna');
    const state = (await till.get('/api/till/state')).json();
    assert.equal(state.session.staff.name, 'Anna');
    assert.equal(state.programs.length, 1);
    assert.equal((await till.get('/api/till/log')).statusCode, 200);

    assert.equal((await till.post('/api/till/logout')).statusCode, 200);
    assert.equal((await till.get('/api/till/log')).json().error, 'pin_required');

    for (let i = 1; i <= 4; i++) {
      const res = await till.post('/api/till/pin', { pin: '0000' });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, 'invalid_pin');
      assert.equal(res.json().attemptsLeft, 5 - i);
    }
    const locked = await till.post('/api/till/pin', { pin: '0000' });
    assert.equal(locked.statusCode, 423);
    assert.equal(locked.json().error, 'pin_locked');
    const until = new Date(locked.json().lockedUntil).getTime() - Date.now();
    assert.ok(until > 4 * 60_000 && until <= 5 * 60_000);
    // Auch die richtige PIN hilft während der Sperre nicht
    assert.equal((await till.post('/api/till/pin', { pin: '1234' })).statusCode, 423);
    // Die Sperre gilt pro Gerät
    const other = await pair(owner, 'Küche');
    assert.equal((await other.post('/api/till/pin', { pin: '1234' })).statusCode, 200);
  });

  it('parallele PIN-Versuche umgehen die Sperre nicht', async () => {
    const owner = await t.owner('burst@example.org', 'Burst Bar');
    await owner.post('/api/staff', { name: 'Anna', pin: '4321' });
    const till = await pair(owner, 'Tresen');
    // 30 falsche PINs und die richtige gleichzeitig: höchstens 5 Versuche werden überhaupt geprüft
    const guesses = Array.from({ length: 30 }, (_, i) => String(1000 + i));
    const results = await Promise.all([...guesses, '4321'].map((pin) => till.post('/api/till/pin', { pin })));
    const codes = results.map((r) => r.statusCode);
    assert.equal(
      codes.filter((c) => c === 401).length + codes.filter((c) => c === 200).length <= 5,
      true,
      String(codes),
    );
    assert.ok(codes.filter((c) => c === 423).length >= 26, String(codes));
  });

  it('Archivierte Team-Mitglieder und gesperrte Geräte kommen nicht mehr rein', async () => {
    const { owner, till } = await shop('raus@example.org', 'Raus Bar');
    const annaId = (await owner.get('/api/staff')).json().staff[0].id;
    assert.equal((await till.get('/api/till/log')).statusCode, 200);
    await owner.del(`/api/staff/${annaId}`);
    assert.equal((await till.get('/api/till/log')).json().error, 'pin_required');
    assert.equal((await till.post('/api/till/pin', { pin: '1234' })).statusCode, 401);

    await owner.post('/api/staff', { name: 'Ben', pin: '5678' });
    assert.equal((await till.post('/api/till/pin', { pin: '5678' })).statusCode, 200);
    const deviceId = (await owner.get('/api/devices')).json().devices[0].id;
    await owner.del(`/api/devices/${deviceId}`);
    assert.equal((await till.get('/api/till/log')).json().error, 'device_required');
    assert.equal((await till.post('/api/till/pin', { pin: '5678' })).json().error, 'device_required');
  });

  it('Karte ausgeben, finden, stempeln, einlösen, neue Runde', async () => {
    const { till, program } = await shop('stempel@example.org', 'Stempel Bar');
    const created = await till.post('/api/till/cards', {});
    assert.equal(created.statusCode, 201);
    const { card, url, qrUrl } = created.json();
    const token = url.split('/c/')[1];
    assert.equal(url, `https://stempelei.test/c/${token}`);
    assert.equal(qrUrl, `/api/public/cards/${token}/qr.svg`);
    assert.equal(card.program.id, program.id);
    assert.equal(card.stamps, 0);
    assert.equal(card.canUndo, false);

    // Finden per Token und per Kurzcode (Groß-/Kleinschreibung egal)
    assert.equal((await till.get(`/api/till/cards/${token}`)).json().card.id, card.id);
    assert.equal((await till.get(`/api/till/cards/${card.shortCode.toLowerCase()}`)).json().card.id, card.id);
    assert.equal((await till.get(`/api/till/cards/%20${card.shortCode}%20`)).json().card.id, card.id);
    assert.equal((await till.get('/api/till/cards/ZZZZZZ')).json().error, 'not_found');
    assert.equal((await till.get(`/api/till/cards/${'A'.repeat(22)}`)).json().error, 'not_found');
    assert.equal((await till.get('/api/till/cards/quatsch')).statusCode, 404);

    const changes: number[] = [];
    const off = onCardChange(card.id, () => changes.push(Date.now()));
    const s1 = await stamp(till, card.id, 3);
    assert.equal(s1.statusCode, 200);
    assert.equal(s1.json().added, 3);
    assert.equal(s1.json().card.stamps, 3);
    assert.equal(s1.json().card.canUndo, true);
    assert.equal(changes.length, 1);

    // Prämie noch nicht erreicht
    const [espresso, kuchen] = program.rewards;
    assert.equal((await redeem(till, card.id, espresso.id)).json().error, 'reward_not_available');

    // Höchstens bis zur Kartenlänge (10)
    const s2 = await stamp(till, card.id, 20);
    assert.equal(s2.json().added, 7);
    assert.equal(s2.json().card.stamps, 10);
    const full = await stamp(till, card.id, 1);
    assert.equal(full.statusCode, 409);
    assert.equal(full.json().error, 'card_full');
    assert.equal((await stamp(till, card.id, 0)).statusCode, 400);
    assert.equal((await stamp(till, card.id, 21)).statusCode, 400);

    const r1 = await redeem(till, card.id, espresso.id);
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().restarted, false);
    assert.deepEqual(
      r1.json().card.program.rewards.map((r: { claimed: boolean }) => r.claimed),
      [true, false],
    );
    assert.equal((await redeem(till, card.id, espresso.id)).json().error, 'reward_not_available');
    assert.equal((await redeem(till, card.id, randomUUID())).json().error, 'reward_not_available');

    const r2 = await redeem(till, card.id, kuchen.id);
    assert.equal(r2.json().restarted, true);
    assert.equal(r2.json().card.stamps, 0);
    assert.equal(r2.json().card.cycle, 2);
    assert.ok(r2.json().card.program.rewards.every((r: { claimed: boolean }) => !r.claimed));
    assert.equal(changes.length, 4);
    off();

    // Die Gast-Ansicht zeigt den neuen Stand
    const guest = (await t.client().get(`/api/public/cards/${token}`)).json().card;
    assert.equal(guest.cycle, 2);

    // Ohne Kartenart keine neue Karte
    const empty = await t.owner('leer@example.org', 'Leer Bar');
    await empty.post('/api/staff', { name: 'Anna', pin: '1234' });
    const emptyTill = await pair(empty, 'Tresen');
    await emptyTill.post('/api/till/pin', { pin: '1234' });
    const none = await emptyTill.post('/api/till/cards', {});
    assert.equal(none.statusCode, 400);
    assert.equal(none.json().error, 'no_program');
  });

  it('gleicher Schlüssel bucht nur einmal', async () => {
    const { till, program } = await shop('idem@example.org', 'Idem Bar');
    const { card } = (await till.post('/api/till/cards', {})).json();
    const key = randomUUID();
    const a = await stamp(till, card.id, 2, key);
    const b = await stamp(till, card.id, 2, key);
    assert.equal(a.json().added, 2);
    assert.equal(b.statusCode, 200);
    assert.equal(b.json().added, 2);
    assert.equal(b.json().card.stamps, 2);
    // Gleichzeitig abgeschickt
    const key2 = randomUUID();
    const both = await Promise.all([stamp(till, card.id, 3, key2), stamp(till, card.id, 3, key2)]);
    assert.deepEqual(
      both.map((r) => r.statusCode),
      [200, 200],
    );
    const gives = await t.conn.db
      .select()
      .from(events)
      .where(and(eq(events.cardId, card.id), eq(events.type, 'give')));
    assert.equal(gives.length, 2);
    const [row] = await t.conn.db.select().from(cards).where(eq(cards.id, card.id));
    assert.equal(row?.stamps, 5);

    // Einlösen ebenso
    const rkey = randomUUID();
    assert.equal((await redeem(till, card.id, program.rewards[0].id, rkey)).json().restarted, false);
    const again = await redeem(till, card.id, program.rewards[0].id, rkey);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().restarted, false);
    // Schlüssel für eine andere Aktion wiederverwendet
    assert.equal(
      (await redeem(till, card.id, program.rewards[0].id, key)).json().error,
      'idempotency_conflict',
    );
  });

  it('Rückgängig nur auf demselben Gerät und innerhalb von 24 Stunden', async () => {
    const { owner, till, program } = await shop('undo@example.org', 'Undo Bar');
    const other = await pair(owner, 'Küche');
    await other.post('/api/till/pin', { pin: '1234' });
    const { card } = (await till.post('/api/till/cards', {})).json();

    assert.equal(
      (await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: randomUUID() })).json().error,
      'nothing_to_undo',
    );
    await stamp(till, card.id, 5);
    await redeem(till, card.id, program.rewards[0].id);

    // Andere Kasse sieht die Karte, darf aber nicht zurücknehmen
    assert.equal((await other.get(`/api/till/cards/${card.shortCode}`)).json().card.canUndo, false);
    const foreign = await other.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: randomUUID() });
    assert.equal(foreign.statusCode, 409);
    assert.equal(foreign.json().error, 'nothing_to_undo');

    const u1 = await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: randomUUID() });
    assert.equal(u1.statusCode, 200);
    assert.equal(u1.json().card.stamps, 5);
    assert.ok(u1.json().card.program.rewards.every((r: { claimed: boolean }) => !r.claimed));
    assert.equal(u1.json().card.canUndo, true);
    const u2 = await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: randomUUID() });
    assert.equal(u2.json().card.stamps, 0);
    assert.equal(u2.json().card.canUndo, false);
    assert.equal(
      (await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: randomUUID() })).json().error,
      'nothing_to_undo',
    );

    // Älter als 24 Stunden
    await stamp(till, card.id, 1);
    await t.conn.db
      .update(events)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(and(eq(events.cardId, card.id), eq(events.type, 'give')));
    assert.equal(
      (await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: randomUUID() })).json().error,
      'nothing_to_undo',
    );

    // Derselbe Schlüssel zweimal (Netzfehler, nochmal getippt) nimmt nur eine Aktion zurück
    await stamp(till, card.id, 2);
    await stamp(till, card.id, 3);
    const key = randomUUID();
    const r1 = await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: key });
    const r2 = await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: key });
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().card.stamps, r1.json().card.stamps);
    assert.equal(r2.json().card.stamps, 3);
    assert.equal(
      (await till.post(`/api/till/cards/${card.id}/undo`, {})).statusCode,
      400,
      'ohne Schlüssel abgelehnt',
    );

    const undos = await t.conn.db
      .select()
      .from(events)
      .where(and(eq(events.cardId, card.id), eq(events.type, 'undo')));
    assert.equal(undos.length, 3);
  });

  it('Karten anderer Betriebe bleiben tabu', async () => {
    const a = await shop('iso-a@example.org', 'A Bar');
    const b = await shop('iso-b@example.org', 'B Bar');
    const created = (await b.till.post('/api/till/cards', {})).json();
    const token = created.url.split('/c/')[1];
    const bCard = created.card;

    const res = await a.till.get(`/api/till/cards/${token}`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'foreign_card');
    assert.equal(res.json().message, 'Diese Karte gehört zu einem anderen Betrieb.');
    assert.equal((await a.till.get(`/api/till/cards/${bCard.shortCode}`)).json().error, 'not_found');
    assert.equal((await stamp(a.till, bCard.id, 1)).json().error, 'not_found');
    assert.equal((await redeem(a.till, bCard.id, b.program.rewards[0].id)).statusCode, 404);
    assert.equal(
      (await a.till.post(`/api/till/cards/${bCard.id}/undo`, { idempotencyKey: randomUUID() })).statusCode,
      404,
    );
    // Eine fremde Kartenart lässt sich nicht ausgeben
    assert.equal(
      (await a.till.post('/api/till/cards', { programId: b.program.id })).json().error,
      'no_program',
    );
    const [row] = await t.conn.db.select().from(cards).where(eq(cards.id, bCard.id));
    assert.equal(row?.stamps, 0);
    // Im Protokoll von A steht nichts von B
    assert.equal((await a.till.get('/api/till/log')).json().events.length, 0);
  });

  it('nach der Testphase ist die Kasse gesperrt', async () => {
    const { till, businessId } = await shop('trial@example.org', 'Trial Bar');
    await t.conn.db
      .update(businesses)
      .set({ trialEndsAt: new Date(Date.now() - 1000) })
      .where(eq(businesses.id, businessId));
    assert.equal((await till.get('/api/till/state')).json().tillAllowed, false);
    const res = await till.post('/api/till/cards', {});
    assert.equal(res.statusCode, 402);
    assert.equal(res.json().error, 'subscription_required');
    assert.equal((await till.get('/api/till/log')).statusCode, 402);

    await t.conn.db
      .update(businesses)
      .set({ subscriptionStatus: 'active' })
      .where(eq(businesses.id, businessId));
    assert.equal((await till.post('/api/till/cards', {})).statusCode, 201);
  });

  it('Tagesprotokoll mit Zahlen', async () => {
    const { till, program } = await shop('log@example.org', 'Log Bar');
    const { card } = (await till.post('/api/till/cards', {})).json();
    await till.post('/api/till/cards', {});
    await stamp(till, card.id, 4);
    await stamp(till, card.id, 2);
    await redeem(till, card.id, program.rewards[0].id);
    await stamp(till, card.id, 1);
    await till.post(`/api/till/cards/${card.id}/undo`, { idempotencyKey: randomUUID() });

    const log = (await till.get('/api/till/log')).json();
    assert.deepEqual(log.stats, { issued: 2, stamps: 6, redeemed: 1 });
    assert.deepEqual(
      log.events.map((e: { type: string; undone: boolean }) => [e.type, e.undone]),
      [
        ['undo', false],
        ['give', true],
        ['redeem', false],
        ['give', false],
        ['give', false],
        ['issue', false],
        ['issue', false],
      ],
    );
    const r = log.events.find((e: { type: string }) => e.type === 'redeem');
    assert.equal(r.rewardText, 'Espresso');
    assert.equal(r.staffName, 'Anna');
    assert.equal(r.shortCode, card.shortCode);
    assert.equal(log.events[1].amount, 1);
  });

  it('liefert jsQR', async () => {
    const res = await t.client().get('/assets/vendor/jsQR.js');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /application\/javascript/);
    assert.match(res.body, /jsQR/);
  });

  it('Kasse verlinkt die Verwaltung', async () => {
    const res = await t.client().get('/till');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<a [^>]*href="\/dashboard"[^>]*>Verwaltung<\/a>/);
  });
});

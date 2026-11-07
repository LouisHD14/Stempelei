import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { businesses, pairingCodes, staff, users } from '../src/db/schema.js';
import { setupApp, skipWithoutDb, type TestApp } from './helpers.js';

describe('Team und Geräte', { skip: skipWithoutDb }, () => {
  let t: TestApp;
  before(async () => {
    t = await setupApp();
  });
  after(() => t?.close());

  it('Team anlegen, PIN ändern, archivieren', async () => {
    const c = await t.owner('team@example.org', 'Team Café');
    assert.deepEqual((await c.get('/api/staff')).json(), { staff: [], limit: 3 });

    const anna = await c.post('/api/staff', { name: '  Anna ', pin: '1234' });
    assert.equal(anna.statusCode, 201);
    const annaId = anna.json().staff.id;
    assert.equal(anna.json().staff.name, 'Anna');
    // PIN-Hash ist kein Klartext
    const [row] = await t.conn.db.select().from(staff).where(eq(staff.id, annaId));
    assert.ok(row && !row.pinHash.includes('1234'));

    // Gleiche PIN im selben Betrieb ist vergeben
    const dup = await c.post('/api/staff', { name: 'Ben', pin: '1234' });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error, 'pin_taken');
    const ben = await c.post('/api/staff', { name: 'Ben', pin: '5678' });
    assert.equal(ben.statusCode, 201);
    const benId = ben.json().staff.id;

    assert.equal((await c.put(`/api/staff/${benId}/pin`, { pin: '1234' })).json().error, 'pin_taken');
    // Die eigene PIN noch einmal setzen ist erlaubt
    assert.equal((await c.put(`/api/staff/${benId}/pin`, { pin: '5678' })).statusCode, 200);
    assert.equal((await c.put(`/api/staff/${benId}/pin`, { pin: '9999' })).statusCode, 200);

    // Ungültige Eingaben
    assert.equal((await c.post('/api/staff', { name: 'Cem', pin: '12' })).json().field, 'pin');
    assert.equal((await c.post('/api/staff', { name: 'Cem', pin: '12a4' })).statusCode, 400);
    assert.equal((await c.post('/api/staff', { name: '   ', pin: '4321' })).json().field, 'name');
    assert.equal((await c.post('/api/staff', { name: 'x'.repeat(41), pin: '4321' })).statusCode, 400);

    // Archivieren gibt die PIN frei
    assert.equal((await c.del(`/api/staff/${annaId}`)).statusCode, 200);
    assert.equal((await c.del(`/api/staff/${annaId}`)).statusCode, 404);
    assert.deepEqual(
      (await c.get('/api/staff')).json().staff.map((s: { name: string }) => s.name),
      ['Ben'],
    );
    assert.equal((await c.post('/api/staff', { name: 'Cem', pin: '1234' })).statusCode, 201);
  });

  it('hält die Paketgrenze ein', async () => {
    const c = await t.owner('grenze-team@example.org', 'Grenze Team');
    for (const pin of ['1111', '2222', '3333']) {
      assert.equal((await c.post('/api/staff', { name: `P${pin}`, pin })).statusCode, 201);
    }
    const res = await c.post('/api/staff', { name: 'Zu viel', pin: '4444' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'plan_limit');

    // Größeres Paket: unbegrenzt wird als null gemeldet
    const [u] = await t.conn.db.select().from(users).where(eq(users.email, 'grenze-team@example.org'));
    assert.ok(u);
    await t.conn.db.update(businesses).set({ plan: 'gross' }).where(eq(businesses.id, u.businessId));
    assert.equal((await c.get('/api/staff')).json().limit, null);
    assert.equal((await c.post('/api/staff', { name: 'Jetzt ja', pin: '4444' })).statusCode, 201);
  });

  it('fremde Team-Mitglieder sind unsichtbar', async () => {
    const a = await t.owner('a-team@example.org', 'A Team');
    const b = await t.owner('b-team@example.org', 'B Team');
    const id = (await a.post('/api/staff', { name: 'Anna', pin: '1234' })).json().staff.id;
    // Gleiche PIN in einem anderen Betrieb ist erlaubt
    assert.equal((await b.post('/api/staff', { name: 'Bea', pin: '1234' })).statusCode, 201);
    assert.equal((await b.put(`/api/staff/${id}/pin`, { pin: '7777' })).statusCode, 404);
    assert.equal((await b.del(`/api/staff/${id}`)).statusCode, 404);
    assert.equal((await b.get('/api/staff')).json().staff.length, 1);
  });

  it('Kopplungscode und Geräte', async () => {
    const c = await t.owner('geraete@example.org', 'Geräte Café');
    assert.deepEqual((await c.get('/api/devices')).json(), { devices: [] });
    const res = await c.post('/api/devices/pairing-code');
    assert.equal(res.statusCode, 201);
    const { code, expiresAt } = res.json();
    assert.match(code, /^[0-9]{8}$/);
    const minutes = (new Date(expiresAt).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 9 && minutes <= 10);
    // Nur der Hash steht in der Datenbank
    const rows = await t.conn.db.select().from(pairingCodes);
    assert.ok(rows.every((r) => r.codeHash !== code));

    const till = t.client();
    assert.equal((await till.post('/api/till/pair', { code, name: 'Tresen' })).statusCode, 200);
    const list = (await c.get('/api/devices')).json().devices;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Tresen');

    // Ohne Anmeldung nichts
    const anon = t.client();
    assert.equal((await anon.get('/api/devices')).statusCode, 401);
    assert.equal((await anon.post('/api/devices/pairing-code')).statusCode, 401);
    assert.equal((await anon.get('/api/staff')).statusCode, 401);

    // Fremder Betrieb kann das Gerät nicht sperren
    const other = await t.owner('fremd-geraete@example.org', 'Fremd');
    assert.equal((await other.del(`/api/devices/${list[0].id}`)).statusCode, 404);

    assert.equal((await c.del(`/api/devices/${list[0].id}`)).statusCode, 200);
    assert.deepEqual((await c.get('/api/devices')).json(), { devices: [] });
    assert.equal((await till.get('/api/till/state')).statusCode, 401);
  });
});

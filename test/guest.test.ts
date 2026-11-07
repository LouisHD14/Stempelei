import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { issueCard, qrSvg } from '../src/cards.js';
import { cards, events, users } from '../src/db/schema.js';
import { publishCardChange } from '../src/live.js';
import { CAFE_CARD, setupApp, skipWithoutDb, type TestApp } from './helpers.js';

describe('qrSvg', () => {
  it('liefert ein SVG mit Ruhezone', () => {
    const svg = qrSvg('https://stempelei.test/c/abc');
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
    assert.match(svg, /<path d="M\d/);
  });
});

describe('Gast-Karten', { skip: skipWithoutDb }, () => {
  let t: TestApp;
  let token = '';
  let cardId = '';
  before(async () => {
    t = await setupApp();
    const owner = await t.owner('gast@example.org', 'Trattoria Mia');
    const prog = (await owner.post('/api/programs', CAFE_CARD)).json().program;
    const [u] = await t.conn.db.select().from(users).where(eq(users.email, 'gast@example.org'));
    assert.ok(u);
    const card = await issueCard(t.conn.db, { businessId: u.businessId, programId: prog.id });
    token = card.publicToken;
    cardId = card.id;
    assert.match(card.shortCode, /^[23456789A-HJKMNP-Z]{6}$/);
    // Ausgabe steht im Protokoll
    const log = await t.conn.db.select().from(events).where(eq(events.cardId, card.id));
    assert.deepEqual(
      log.map((e) => e.type),
      ['issue'],
    );
  });
  after(() => t?.close());

  it('zeigt die Karte ohne interne IDs', async () => {
    const res = await t.client().get(`/api/public/cards/${token}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const { card, url } = res.json();
    assert.equal(url, `https://stempelei.test/c/${token}`);
    assert.equal(card.business, 'Trattoria Mia');
    assert.equal(card.stamps, 0);
    assert.deepEqual(card.rewards, [
      { threshold: 5, text: 'Espresso', claimed: false },
      { threshold: 10, text: 'Kuchen', claimed: false },
    ]);
    // Keine IDs von Karte, Betrieb, Kartenart oder Prämien
    assert.doesNotMatch(res.body, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it('unbekannte und ungültige Tokens', async () => {
    const c = t.client();
    assert.equal((await c.get(`/api/public/cards/${'A'.repeat(22)}`)).statusCode, 404);
    assert.equal((await c.get('/api/public/cards/zu-kurz')).statusCode, 400);
    assert.equal((await c.get(`/c/${'A'.repeat(21)}`)).statusCode, 400);
  });

  it('liefert QR-Code und Seite', async () => {
    const c = t.client();
    const qr = await c.get(`/api/public/cards/${token}/qr.svg`);
    assert.equal(qr.statusCode, 200);
    assert.match(String(qr.headers['content-type']), /image\/svg\+xml/);
    const page = await c.get(`/c/${token}`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /data-page="card"/);
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
  });

  it('meldet Änderungen live', async () => {
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(`${address}/api/public/cards/${token}/live`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    // Erst nach dem Verbindungsaufbau ändern, sonst geht die Meldung verloren
    while (!text.includes('retry:')) text += decoder.decode((await reader.read()).value);
    await t.conn.db.update(cards).set({ stamps: 3 }).where(eq(cards.id, cardId));
    publishCardChange(cardId);
    while (!text.includes('event: card')) text += decoder.decode((await reader.read()).value);
    while (!text.includes('\n\n', text.indexOf('event: card')))
      text += decoder.decode((await reader.read()).value);
    const data = /event: card\ndata: (.*)\n\n/.exec(text)?.[1];
    assert.ok(data);
    assert.equal(JSON.parse(data).stamps, 3);
    ctrl.abort();
  });

  it('begrenzt Abrufe pro IP', async () => {
    const c = t.client();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await c.get(`/api/public/cards/${token}`)).statusCode;
    assert.equal(last, 429);
  });
});

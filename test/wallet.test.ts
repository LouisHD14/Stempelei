import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import forge from 'node-forge';
import { PUBLIC_DIR } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { appleRegistrations } from '../src/db/schema.js';
import { type AppleConfig, type Pusher, type PushResult, passAuthToken } from '../src/wallet/apple.js';
import { type GoogleConfig, googleApi, objectId } from '../src/wallet/google.js';
import { loadAppleImages, startWalletSync, type Wallet } from '../src/wallet/index.js';
import { unzipStored } from '../src/wallet/zip.js';
import { CAFE_CARD, ORIGIN, setupApp, skipWithoutDb, type TestApp } from './helpers.js';

const PASS_TYPE = 'pass.test.stempelei';

/** Eigene kleine Zertifikatskette: „WWDR“ als Aussteller, darunter das Pass-Zertifikat. */
function testCertificates() {
  const make = (
    subject: string,
    issuer: forge.pki.Certificate | null,
    issuerKey: forge.pki.rsa.PrivateKey | null,
  ) => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `0${Math.floor(Math.random() * 1e9).toString(16)}`;
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    cert.setSubject([{ name: 'commonName', value: subject }]);
    cert.setIssuer((issuer ?? cert).subject.attributes);
    if (!issuer) cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
    cert.sign(issuerKey ?? keys.privateKey, forge.md.sha256.create());
    return { cert, key: keys.privateKey };
  };
  const ca = make('Test WWDR', null, null);
  const signer = make(`Pass Type ID: ${PASS_TYPE}`, ca.cert, ca.key);
  return {
    wwdrPem: forge.pki.certificateToPem(ca.cert),
    certPem: forge.pki.certificateToPem(signer.cert),
    keyPem: forge.pki.privateKeyToPem(signer.key),
  };
}

/** APNs-Ersatz: merkt sich die Pushes, Antwort pro Token einstellbar. */
function fakePusher() {
  const calls: string[] = [];
  const answers = new Map<string, PushResult>();
  const pusher: Pusher = {
    async push(token) {
      calls.push(token);
      return answers.get(token) ?? 'ok';
    },
    close() {},
  };
  return { pusher, calls, answers };
}

/** Google-API-Ersatz: Token-Abruf und PATCH-Aufrufe werden aufgezeichnet. */
function fakeGoogleFetch() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let missing = false;
  let tokenRequests = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? String(init.body) : undefined });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      tokenRequests++;
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{}', { status: missing ? 404 : 200 });
  }) as typeof fetch;
  return {
    fn,
    calls,
    get tokenRequests() {
      return tokenRequests;
    },
    setMissing(v: boolean) {
      missing = v;
    },
  };
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Wallet-Konfiguration', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db', PUBLIC_URL: 'https://stempelei.test' };
  const apple = {
    APPLE_PASS_TYPE_ID: 'pass.de.stempelei.karte',
    APPLE_TEAM_ID: 'ABCDE12345',
    APPLE_PASS_CERT: '/x/cert.pem',
    APPLE_PASS_KEY: '/x/key.pem',
    APPLE_WWDR_CERT: '/x/wwdr.pem',
    WALLET_SECRET: 'x'.repeat(32),
  };
  it('ohne Angaben ist Wallet aus', () => {
    assert.deepEqual(loadConfig(base).wallet, { apple: null, google: null });
  });
  it('Apple nur vollständig und mit HTTPS', () => {
    assert.equal(loadConfig({ ...base, ...apple }).wallet.apple?.apnsHost, 'api.push.apple.com');
    assert.throws(() => loadConfig({ ...base, APPLE_TEAM_ID: 'ABCDE12345' }), /Für Apple Wallet fehlen/);
    assert.throws(() => loadConfig({ ...base, ...apple, WALLET_SECRET: 'kurz' }), /mindestens 32/);
    assert.throws(() => loadConfig({ ...base, ...apple, PUBLIC_URL: 'http://localhost:3000' }), ConfigError);
  });
  it('Google braucht Issuer-ID und Schlüsseldatei', () => {
    assert.equal(
      loadConfig({
        ...base,
        GOOGLE_WALLET_ISSUER_ID: '3388000000012345',
        GOOGLE_WALLET_KEY_FILE: '/x/k.json',
      }).wallet.google?.issuerId,
      '3388000000012345',
    );
    assert.throws(() => loadConfig({ ...base, GOOGLE_WALLET_ISSUER_ID: '123' }), /GOOGLE_WALLET_KEY_FILE/);
    assert.throws(
      () => loadConfig({ ...base, GOOGLE_WALLET_ISSUER_ID: 'abc', GOOGLE_WALLET_KEY_FILE: '/k' }),
      /Ziffern/,
    );
  });
});

describe('Wallet', { skip: skipWithoutDb }, () => {
  let t: TestApp;
  let appleCfg: AppleConfig;
  let googleCfg: GoogleConfig;
  let googlePublicKey: string;
  const push = fakePusher();
  const gfetch = fakeGoogleFetch();
  let stopSync: () => void;

  before(async () => {
    const certs = testCertificates();
    appleCfg = {
      passTypeId: PASS_TYPE,
      teamId: 'TEAM123456',
      ...certs,
      secret: 'ein-langes-geheimnis-nur-fuer-tests-123456',
      webServiceUrl: `${ORIGIN}/wallet/apple`,
      images: loadAppleImages(PUBLIC_DIR),
    };
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    googlePublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    googleCfg = {
      issuerId: '3388000000012345',
      clientEmail: 'wallet@test.iam.gserviceaccount.com',
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicUrl: new URL(ORIGIN),
      fetch: gfetch.fn,
    };
    const wallet: Wallet = {
      apple: { cfg: appleCfg, pusher: push.pusher },
      google: { cfg: googleCfg, api: googleApi(googleCfg) },
    };
    t = await setupApp({ wallet });
    stopSync = startWalletSync(t.conn.db, wallet, new URL(ORIGIN), t.app.log);
  });
  after(async () => {
    stopSync?.();
    await t?.close();
  });

  /** Betrieb mit Karte, Team-Mitglied und angemeldeter Kasse, dazu eine ausgegebene Karte. */
  async function shopWithCard(email: string) {
    const owner = await t.owner(email, 'Wallet Café');
    const program = (await owner.post('/api/programs', CAFE_CARD)).json().program;
    await owner.post('/api/staff', { name: 'Anna', pin: '1234' });
    const { code } = (await owner.post('/api/devices/pairing-code')).json();
    const till = t.client();
    await till.post('/api/till/pair', { code, name: 'Tresen' });
    await till.post('/api/till/pin', { pin: '1234' });
    const issued = (await till.post('/api/till/cards', {})).json();
    const token = issued.url.split('/c/')[1] as string;
    return {
      owner,
      till,
      program,
      card: issued.card as { id: string; shortCode: string },
      token,
      url: issued.url as string,
    };
  }

  it('Knöpfe nur mit den offiziellen Grafiken', async () => {
    // Die Grafiken liegen nicht im Repo (Lizenz von Apple und Google), deshalb hier keine Knöpfe
    assert.deepEqual((await t.client().get('/api/public/wallet')).json(), { apple: false, google: false });
  });

  it('Apple: Pass mit QR-Code, Manifest und gültiger Signatur', async () => {
    const { card, token, url } = await shopWithCard('apple@example.org');
    const res = await t.client().get(`/api/public/cards/${token}/wallet/apple`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/vnd.apple.pkpass');
    const files = unzipStored(res.rawPayload);
    const pass = JSON.parse(String(files.get('pass.json')));
    assert.equal(pass.serialNumber, card.id);
    assert.equal(pass.passTypeIdentifier, PASS_TYPE);
    assert.equal(pass.webServiceURL, `${ORIGIN}/wallet/apple`);
    assert.equal(pass.authenticationToken, passAuthToken(appleCfg, card.id));
    assert.deepEqual(pass.barcodes[0], {
      format: 'PKBarcodeFormatQR',
      message: url,
      messageEncoding: 'iso-8859-1',
      altText: card.shortCode,
    });
    assert.equal(pass.storeCard.primaryFields[0].value, '0 / 10');
    assert.equal(pass.storeCard.secondaryFields[0].value, 'Espresso');
    assert.ok(
      files.has('icon.png') && files.has('de.lproj/pass.strings') && files.has('en.lproj/pass.strings'),
    );

    // Manifest: SHA-1 jeder Datei
    const manifest = JSON.parse(String(files.get('manifest.json')));
    for (const [name, hash] of Object.entries(manifest)) {
      assert.equal(
        createHash('sha1')
          .update(files.get(name) as Buffer)
          .digest('hex'),
        hash,
        name,
      );
    }
    assert.equal(Object.keys(manifest).length, files.size - 2);

    // Signatur mit OpenSSL prüfen, wie Wallet es tut (ohne OpenSSL nur die Struktur)
    const p7 = forge.pkcs7.messageFromAsn1(
      forge.asn1.fromDer((files.get('signature') as Buffer).toString('binary')),
    );
    assert.equal((p7 as { certificates: unknown[] }).certificates.length, 2);
    const dir = mkdtempSync(join(tmpdir(), 'pkpass-'));
    writeFileSync(join(dir, 'signature'), files.get('signature') as Buffer);
    writeFileSync(join(dir, 'manifest.json'), files.get('manifest.json') as Buffer);
    writeFileSync(join(dir, 'wwdr.pem'), appleCfg.wwdrPem);
    let openssl = true;
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      openssl = false;
    }
    if (openssl) {
      execFileSync(
        'openssl',
        [
          'smime',
          '-verify',
          '-binary',
          '-inform',
          'DER',
          '-in',
          join(dir, 'signature'),
          '-content',
          join(dir, 'manifest.json'),
          '-CAfile',
          join(dir, 'wwdr.pem'),
          '-purpose',
          'any',
          '-out',
          '/dev/null',
        ],
        { stdio: 'pipe' },
      );
    }
  });

  it('Apple: Web-Service für Anmeldung, Updates und Abmeldung', async () => {
    const { owner, till, card, program } = await shopWithCard('webservice@example.org');
    const base = `/wallet/apple/v1/devices/dev1/registrations/${PASS_TYPE}`;
    const auth = { authorization: `ApplePass ${passAuthToken(appleCfg, card.id)}` };
    const apple = (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: object,
      headers: Record<string, string> = auth,
    ) => t.app.inject({ method, url, ...(payload ? { payload } : {}), headers });
    const pushToken = 'ab'.repeat(32);

    // Ohne oder mit falschem Token: 401
    assert.equal((await apple('POST', `${base}/${card.id}`, { pushToken }, {})).statusCode, 401);
    assert.equal(
      (await apple('POST', `${base}/${card.id}`, { pushToken }, { authorization: 'ApplePass falsch' }))
        .statusCode,
      401,
    );
    assert.equal((await apple('POST', `${base}/${card.id}`, { pushToken })).statusCode, 201);
    assert.equal((await apple('POST', `${base}/${card.id}`, { pushToken })).statusCode, 200);
    // Fremde Pass-Type-ID passt nicht zur Route
    assert.equal(
      (
        await apple('POST', `/wallet/apple/v1/devices/dev1/registrations/pass.fremd/${card.id}`, {
          pushToken,
        })
      ).statusCode,
      400,
    );

    // Welche Pässe haben sich geändert?
    const list = await apple('GET', `${base}?passesUpdatedSince=0`, undefined, {});
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().serialNumbers, [card.id]);
    const since = list.json().lastUpdated;
    assert.equal((await apple('GET', `${base}?passesUpdatedSince=${since}`, undefined, {})).statusCode, 204);

    // Stempel an der Kasse: Push an das Gerät, danach ist die Karte wieder „geändert“
    push.calls.length = 0;
    await new Promise((r) => setTimeout(r, 1100)); // Zeitstempel in ganzen Millisekunden sicher größer
    await till.post(`/api/till/cards/${card.id}/stamps`, { amount: 2, idempotencyKey: randomUUID() });
    await until(() => push.calls.includes(pushToken));
    assert.deepEqual(
      (await apple('GET', `${base}?passesUpdatedSince=${since}`, undefined, {})).json().serialNumbers,
      [card.id],
    );

    // Neuer Pass mit neuem Stand, mit If-Modified-Since 304
    const passUrl = `/wallet/apple/v1/passes/${PASS_TYPE}/${card.id}`;
    const fresh = await apple('GET', passUrl);
    assert.equal(fresh.statusCode, 200);
    assert.equal(
      JSON.parse(String(unzipStored(fresh.rawPayload).get('pass.json'))).storeCard.primaryFields[0].value,
      '2 / 10',
    );
    assert.equal(
      (
        await apple('GET', passUrl, undefined, {
          ...auth,
          'if-modified-since': String(fresh.headers['last-modified']),
        })
      ).statusCode,
      304,
    );
    assert.equal((await apple('GET', passUrl, undefined, {})).statusCode, 401);

    // Der Inhaber ändert die Karte: Push an alle Geräte mit Karten dieser Art
    push.calls.length = 0;
    await owner.put(`/api/programs/${program.id}`, { ...CAFE_CARD, name: 'Neuer Name' });
    await until(() => push.calls.includes(pushToken));

    // Apple meldet das Token als ungültig: Anmeldung verschwindet
    push.answers.set(pushToken, 'gone');
    await till.post(`/api/till/cards/${card.id}/stamps`, { amount: 1, idempotencyKey: randomUUID() });
    await until(() => push.calls.filter((c) => c === pushToken).length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    const rows = await t.conn.db
      .select()
      .from(appleRegistrations)
      .where(eq(appleRegistrations.cardId, card.id));
    assert.equal(rows.length, 0);

    // Abmelden geht auch ausdrücklich
    push.answers.delete(pushToken);
    assert.equal((await apple('POST', `${base}/${card.id}`, { pushToken })).statusCode, 201);
    assert.equal((await apple('DELETE', `${base}/${card.id}`)).statusCode, 200);
    assert.equal((await apple('GET', `${base}?passesUpdatedSince=0`, undefined, {})).statusCode, 204);
    assert.equal((await apple('POST', '/wallet/apple/v1/log', { logs: ['Test'] }, {})).statusCode, 200);
  });

  it('Google: signierter Speicher-Link und Updates nach dem Stempeln', async () => {
    const { owner, till, card, token, url, program } = await shopWithCard('google@example.org');
    const res = await t.client().get(`/api/public/cards/${token}/wallet/google`);
    assert.equal(res.statusCode, 302);
    const location = String(res.headers.location);
    assert.match(location, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    const [head, body, sig] = location.split('/save/')[1]?.split('.') ?? [];
    assert.ok(head && body && sig);
    assert.ok(
      verify('RSA-SHA256', Buffer.from(`${head}.${body}`), googlePublicKey, Buffer.from(sig, 'base64url')),
    );
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    assert.equal(claims.iss, googleCfg.clientEmail);
    assert.equal(claims.typ, 'savetowallet');
    assert.deepEqual(claims.origins, [ORIGIN]);
    const obj = claims.payload.loyaltyObjects[0];
    assert.equal(obj.id, objectId(googleCfg, card.id));
    assert.equal(obj.barcode.value, url);
    assert.equal(obj.loyaltyPoints.balance.string, '0 / 10');
    assert.equal(claims.payload.loyaltyClasses[0].issuerName, 'Wallet Café');
    assert.equal(
      claims.payload.loyaltyClasses[0].programLogo.sourceUri.uri,
      `${ORIGIN}/assets/wallet/logo-google.png`,
    );

    // Stempel: PATCH auf das Objekt mit dem neuen Stand
    gfetch.calls.length = 0;
    await till.post(`/api/till/cards/${card.id}/stamps`, { amount: 3, idempotencyKey: randomUUID() });
    await until(() => gfetch.calls.some((c) => c.method === 'PATCH'));
    const patch = gfetch.calls.find((c) => c.method === 'PATCH');
    assert.ok(patch?.url.endsWith(`/loyaltyObject/${encodeURIComponent(objectId(googleCfg, card.id))}`));
    assert.equal(JSON.parse(String(patch?.body)).loyaltyPoints.balance.string, '3 / 10');
    // Ein Zugriffstoken für alle Aufrufe, es gilt eine Stunde
    assert.equal(gfetch.tokenRequests, 1);

    // Karte noch nicht gespeichert (404): kein Fehler
    gfetch.setMissing(true);
    gfetch.calls.length = 0;
    await till.post(`/api/till/cards/${card.id}/stamps`, { amount: 1, idempotencyKey: randomUUID() });
    await until(() => gfetch.calls.some((c) => c.method === 'PATCH'));
    gfetch.setMissing(false);

    // Kartenart geändert: PATCH auf die Klasse
    gfetch.calls.length = 0;
    await owner.put(`/api/programs/${program.id}`, { ...CAFE_CARD, name: 'Herbstkarte', ink: 'gruen' });
    await until(() => gfetch.calls.some((c) => c.method === 'PATCH' && c.url.includes('/loyaltyClass/')));
    const cls = JSON.parse(String(gfetch.calls.find((c) => c.url.includes('/loyaltyClass/'))?.body));
    assert.equal(cls.programName, 'Herbstkarte');
    assert.equal(cls.hexBackgroundColor, '#0e653f');
  });

  it('unbekannte Karten', async () => {
    const c = t.client();
    assert.equal((await c.get(`/api/public/cards/${'A'.repeat(22)}/wallet/apple`)).statusCode, 404);
    assert.equal((await c.get(`/api/public/cards/${'A'.repeat(22)}/wallet/google`)).statusCode, 404);
    const unknown = randomUUID();
    const res = await t.app.inject({
      url: `/wallet/apple/v1/passes/${PASS_TYPE}/${unknown}`,
      headers: { authorization: `ApplePass ${passAuthToken(appleCfg, unknown)}` },
    });
    assert.equal(res.statusCode, 401);
  });
});

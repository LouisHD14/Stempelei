import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http2 from 'node:http2';
import forge from 'node-forge';
import type { GuestCardView } from '../cards.js';
import { CARD_HEX, hexToRgb, inkHex, walletSummary } from './content.js';
import { zipStored } from './zip.js';

export interface AppleConfig {
  passTypeId: string;
  teamId: string;
  /** Pass-Type-ID-Zertifikat und Schlüssel (PEM), daraus auch die Verbindung zu APNs */
  certPem: string;
  keyPem: string;
  keyPassphrase?: string;
  /** Apple WWDR-Zwischenzertifikat (PEM), gehört in jede Signatur */
  wwdrPem: string;
  /** Geheimnis für die Auth-Tokens der Pässe (HMAC), mindestens 32 Zeichen */
  secret: string;
  /** https://<domain>/wallet/apple */
  webServiceUrl: string;
  /** PNG-Bilder im Pass: icon.png, icon@2x.png, … */
  images: Record<string, Buffer>;
}

/** Auth-Token eines Passes. Abgeleitet statt gespeichert: Apple fragt es bei jedem Abruf mit. */
export function passAuthToken(cfg: Pick<AppleConfig, 'secret'>, serial: string): string {
  return createHmac('sha256', cfg.secret).update(`apple-pass:${serial}`).digest('base64url');
}

export function checkPassAuth(cfg: Pick<AppleConfig, 'secret'>, serial: string, header: string | undefined) {
  const given = Buffer.from(/^ApplePass (\S+)$/.exec(header ?? '')?.[1] ?? '');
  const expected = Buffer.from(passAuthToken(cfg, serial));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Beschriftungen sind Schlüssel, Wallet zeigt sie in der Sprache des iPhones (de.lproj / en.lproj)
const STRINGS: Record<'de' | 'en', Record<string, string>> = {
  de: {
    STAMPS: 'Stempel',
    NEXT_REWARD: 'Nächste Prämie',
    STAMPS_LEFT: 'Noch',
    READY: 'Prämie bereit',
    EARN_RULE: 'Einen Stempel gibt es für',
    REWARDS: 'Prämien',
    SHORT_CODE: 'Kurzcode',
    CARD_LINK: 'Karte im Browser',
    CHANGE_STAMPS: 'Neuer Stand: %@ Stempel',
    CHANGE_READY: 'Prämie bereit: %@',
  },
  en: {
    STAMPS: 'Stamps',
    NEXT_REWARD: 'Next reward',
    STAMPS_LEFT: 'Left',
    READY: 'Reward ready',
    EARN_RULE: 'One stamp for',
    REWARDS: 'Rewards',
    SHORT_CODE: 'Short code',
    CARD_LINK: 'Card in the browser',
    CHANGE_STAMPS: 'Now %@ stamps',
    CHANGE_READY: 'Reward ready: %@',
  },
};

const stringsFile = (lang: 'de' | 'en') =>
  Buffer.from(
    Object.entries(STRINGS[lang])
      .map(([k, v]) => `"${k}" = "${v.replace(/"/g, '\\"')}";`)
      .join('\n'),
    'utf8',
  );

/** Inhalt von pass.json für eine Karte (Typ storeCard). */
export function passJson(cfg: AppleConfig, serial: string, card: GuestCardView, url: string) {
  const s = walletSummary(card);
  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    serialNumber: serial,
    organizationName: card.business,
    description: `${card.name} · ${card.business}`,
    logoText: card.name,
    backgroundColor: hexToRgb(inkHex(card.ink)),
    foregroundColor: hexToRgb(CARD_HEX),
    labelColor: hexToRgb(CARD_HEX),
    webServiceURL: cfg.webServiceUrl,
    authenticationToken: passAuthToken(cfg, serial),
    // Derselbe QR-Code wie auf der Gast-Ansicht: Die Kasse scannt ihn wie bisher
    barcodes: [
      { format: 'PKBarcodeFormatQR', message: url, messageEncoding: 'iso-8859-1', altText: card.shortCode },
    ],
    storeCard: {
      primaryFields: [
        { key: 'stamps', label: 'STAMPS', value: s.stampsText, changeMessage: 'CHANGE_STAMPS' },
      ],
      secondaryFields: s.ready.length
        ? [
            {
              key: 'ready',
              label: 'READY',
              value: s.ready.map((r) => r.text).join(', '),
              changeMessage: 'CHANGE_READY',
            },
          ]
        : s.next
          ? [{ key: 'next', label: 'NEXT_REWARD', value: s.next.text }]
          : [],
      auxiliaryFields:
        !s.ready.length && s.next ? [{ key: 'left', label: 'STAMPS_LEFT', value: s.nextIn }] : [],
      backFields: [
        ...(card.earnRule ? [{ key: 'rule', label: 'EARN_RULE', value: card.earnRule }] : []),
        {
          key: 'rewards',
          label: 'REWARDS',
          value: s.rewards.map((r) => `${r.threshold} – ${r.text}${r.claimed ? ' ✓' : ''}`).join('\n'),
        },
        { key: 'code', label: 'SHORT_CODE', value: card.shortCode },
        { key: 'link', label: 'CARD_LINK', value: url },
      ],
    },
  };
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/** Signiert das Manifest (PKCS#7, abgetrennt), wie Wallet es verlangt. */
function signManifest(cfg: AppleConfig, manifest: Buffer): Buffer {
  const cert = forge.pki.certificateFromPem(cfg.certPem);
  const key = cfg.keyPassphrase
    ? forge.pki.decryptRsaPrivateKey(cfg.keyPem, cfg.keyPassphrase)
    : forge.pki.privateKeyFromPem(cfg.keyPem);
  if (!key) throw new Error('Schlüssel des Pass-Zertifikats lässt sich nicht lesen');
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString('binary'));
  p7.addCertificate(cert);
  p7.addCertificate(forge.pki.certificateFromPem(cfg.wwdrPem));
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256 as string,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType as string, value: forge.pki.oids.data as string },
      { type: forge.pki.oids.messageDigest as string },
      { type: forge.pki.oids.signingTime as string, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

/** Die fertige .pkpass-Datei. */
export function buildPkpass(cfg: AppleConfig, serial: string, card: GuestCardView, url: string): Buffer {
  const files: Record<string, Buffer> = {
    'pass.json': Buffer.from(JSON.stringify(passJson(cfg, serial, card, url)), 'utf8'),
    'de.lproj/pass.strings': stringsFile('de'),
    'en.lproj/pass.strings': stringsFile('en'),
    ...cfg.images,
  };
  const manifest = Buffer.from(
    JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha1(data)]))),
    'utf8',
  );
  return zipStored([
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
    { name: 'manifest.json', data: manifest },
    { name: 'signature', data: signManifest(cfg, manifest) },
  ]);
}

export type PushResult = 'ok' | 'gone' | 'error';
export interface Pusher {
  push(pushToken: string): Promise<PushResult>;
  close(): void;
}

/**
 * Push über APNs mit dem Pass-Type-ID-Zertifikat. Der Inhalt ist leer: Wallet holt den neuen Pass selbst ab.
 * Eine HTTP/2-Verbindung für alle Pushes, sie wird nach einer Minute ohne Pushes geschlossen.
 */
export function apnsPusher(cfg: AppleConfig, host = 'api.push.apple.com'): Pusher {
  let session: http2.ClientHttp2Session | null = null;
  let idle: NodeJS.Timeout | undefined;
  const connect = () => {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(`https://${host}`, {
      cert: cfg.certPem,
      key: cfg.keyPem,
      ...(cfg.keyPassphrase ? { passphrase: cfg.keyPassphrase } : {}),
    });
    session.on('error', () => {
      session = null;
    });
    return session;
  };
  return {
    push(pushToken) {
      if (!/^[0-9a-fA-F]{32,200}$/.test(pushToken)) return Promise.resolve('gone');
      clearTimeout(idle);
      idle = setTimeout(() => session?.close(), 60_000);
      return new Promise((resolve) => {
        let req: http2.ClientHttp2Stream;
        try {
          req = connect().request({
            ':method': 'POST',
            ':path': `/3/device/${pushToken}`,
            'apns-topic': cfg.passTypeId,
            'content-type': 'application/json',
          });
        } catch {
          return resolve('error');
        }
        let status = 0;
        let body = '';
        req.setTimeout(10_000, () => req.close());
        req.on('response', (h) => {
          status = Number(h[':status']);
        });
        req.on('data', (d) => {
          body += d;
        });
        req.on('end', () => {
          if (status === 200) return resolve('ok');
          // 410: Gerät hat den Pass gelöscht. BadDeviceToken: Token ungültig. Beides: Anmeldung entfernen.
          resolve(status === 410 || /BadDeviceToken|Unregistered/.test(body) ? 'gone' : 'error');
        });
        req.on('error', () => resolve('error'));
        req.end('{}');
      });
    },
    close() {
      clearTimeout(idle);
      session?.close();
    },
  };
}

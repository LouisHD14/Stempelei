import { createSign } from 'node:crypto';
import type { GuestCardView } from '../cards.js';
import { inkHex, walletSummary } from './content.js';

export interface GoogleConfig {
  issuerId: string;
  /** Aus der JSON-Schlüsseldatei des Google-Cloud-Dienstkontos */
  clientEmail: string;
  privateKeyPem: string;
  publicUrl: URL;
  /** Für Tests austauschbar */
  fetch?: typeof fetch;
}

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** JWT mit RS256, signiert mit dem Schlüssel des Dienstkontos. */
export function signJwt(privateKeyPem: string, claims: object): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

// IDs bei Google: <Issuer-ID>.<eigener Teil>, nur Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich
export const classId = (cfg: GoogleConfig, programId: string) =>
  `${cfg.issuerId}.p${programId.replace(/-/g, '')}`;
export const objectId = (cfg: GoogleConfig, cardId: string) => `${cfg.issuerId}.c${cardId.replace(/-/g, '')}`;

const text = (de: string, en: string) => ({
  defaultValue: { language: 'de', value: de },
  translatedValues: [{ language: 'en', value: en }],
});

/** Kartenart eines Betriebs als Google-„Loyalty Class“. */
export function loyaltyClass(
  cfg: GoogleConfig,
  programId: string,
  card: Pick<GuestCardView, 'business' | 'name' | 'ink'>,
) {
  return {
    id: classId(cfg, programId),
    issuerName: card.business,
    programName: card.name,
    programLogo: {
      sourceUri: { uri: new URL('/assets/wallet/logo-google.png', cfg.publicUrl).href },
      contentDescription: text('Logo', 'Logo'),
    },
    hexBackgroundColor: inkHex(card.ink),
    countryCode: 'DE',
    reviewStatus: 'UNDER_REVIEW',
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
  };
}

/** Die Karte eines Gasts als „Loyalty Object“. */
export function loyaltyObject(
  cfg: GoogleConfig,
  programId: string,
  cardId: string,
  card: GuestCardView,
  url: string,
) {
  const s = walletSummary(card);
  const nextText = s.ready.length
    ? text(
        `Bereit: ${s.ready.map((r) => r.text).join(', ')}`,
        `Ready: ${s.ready.map((r) => r.text).join(', ')}`,
      )
    : s.next
      ? text(`Noch ${s.nextIn} bis ${s.next.text}`, `${s.nextIn} more until ${s.next.text}`)
      : text('Alle Prämien eingelöst', 'All rewards redeemed');
  return {
    id: objectId(cfg, cardId),
    classId: classId(cfg, programId),
    state: 'ACTIVE',
    loyaltyPoints: {
      label: 'Stempel',
      localizedLabel: text('Stempel', 'Stamps'),
      balance: { string: s.stampsText },
    },
    // Derselbe QR-Code wie auf der Gast-Ansicht: Die Kasse scannt ihn wie bisher
    barcode: { type: 'QR_CODE', value: url, alternateText: card.shortCode },
    textModulesData: [
      {
        id: 'next',
        header: 'Prämie',
        localizedHeader: text('Prämie', 'Reward'),
        body: nextText.defaultValue.value,
        localizedBody: nextText,
      },
    ],
    linksModuleData: {
      uris: [
        {
          id: 'card',
          uri: url,
          description: 'Karte im Browser',
          localizedDescription: text('Karte im Browser', 'Card in the browser'),
        },
      ],
    },
  };
}

/** Link für den Knopf „Zu Google Wallet hinzufügen“. Klasse und Objekt stecken im JWT, Google legt sie beim Speichern an. */
export function saveUrl(
  cfg: GoogleConfig,
  programId: string,
  cardId: string,
  card: GuestCardView,
  url: string,
): string {
  const jwt = signJwt(cfg.privateKeyPem, {
    iss: cfg.clientEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [cfg.publicUrl.origin],
    payload: {
      loyaltyClasses: [loyaltyClass(cfg, programId, card)],
      loyaltyObjects: [loyaltyObject(cfg, programId, cardId, card, url)],
    },
  });
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

/** Zugriff auf die Google-Wallet-API mit dem Dienstkonto. Das Token gilt eine Stunde und wird wiederverwendet. */
export function googleApi(cfg: GoogleConfig) {
  const doFetch = cfg.fetch ?? fetch;
  let token: { value: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.until > Date.now()) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt(cfg.privateKeyPem, {
      iss: cfg.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    });
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`Google-Token: HTTP ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: data.access_token, until: Date.now() + (data.expires_in - 60) * 1000 };
    return token.value;
  }

  /** PATCH auf Klasse oder Objekt. 404 heißt: Der Gast hat die Karte (noch) nicht gespeichert, dann ist nichts zu tun. */
  async function patch(
    kind: 'loyaltyClass' | 'loyaltyObject',
    id: string,
    body: object,
  ): Promise<'ok' | 'missing'> {
    const res = await doFetch(`${API}/${kind}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404) return 'missing';
    if (!res.ok) throw new Error(`Google Wallet ${kind}: HTTP ${res.status}`);
    return 'ok';
  }

  return {
    patchObject: (programId: string, cardId: string, card: GuestCardView, url: string) => {
      const { id, ...rest } = loyaltyObject(cfg, programId, cardId, card, url);
      return patch('loyaltyObject', id, rest);
    },
    patchClass: (programId: string, card: Pick<GuestCardView, 'business' | 'name' | 'ink'>) => {
      // reviewStatus UNDER_REVIEW auch beim Ändern: Google prüft geänderte Klassen erneut
      const { id, ...rest } = loyaltyClass(cfg, programId, card);
      return patch('loyaltyClass', id, rest);
    },
  };
}

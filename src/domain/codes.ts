import { randomBytes, randomInt } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_TOKEN_LENGTH = 22; // 62^22 ≈ 2^131 Möglichkeiten

/** Zufälliges Token für den Gast-Link. Rejection Sampling vermeidet eine ungleiche Verteilung. */
export function publicToken(): string {
  let out = '';
  while (out.length < PUBLIC_TOKEN_LENGTH) {
    for (const byte of randomBytes(32)) {
      if (byte < 248) out += BASE62[byte % 62]; // 248 = 4 × 62
      if (out.length === PUBLIC_TOKEN_LENGTH) break;
    }
  }
  return out;
}

export function isPublicToken(value: string): boolean {
  return new RegExp(`^[0-9A-Za-z]{${PUBLIC_TOKEN_LENGTH}}$`).test(value);
}

/** Ziffern und Großbuchstaben ohne die leicht verwechselbaren Zeichen 0, O, 1, I und L. */
export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SHORT_CODE_LENGTH = 6;

/** Kurzcode zum Abtippen an der Kasse, eindeutig pro Betrieb (wird in der Datenbank geprüft). */
export function shortCode(): string {
  let out = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++)
    out += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  return out;
}

/** Macht aus einer Eingabe wie "k7m-2qx" den gespeicherten Code "K7M2QX", oder null bei ungültiger Eingabe. */
export function normalizeShortCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== SHORT_CODE_LENGTH) return null;
  for (const ch of code) if (!SHORT_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

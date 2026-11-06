import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** Argon2id mit den Mindestwerten aus der OWASP-Empfehlung (19 MiB, 2 Durchläufe). */
// algorithm 2 = Algorithm.Argon2id (const enum, mit verbatimModuleSyntax nicht importierbar)
const ARGON2 = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Hash eines zufälligen Passworts. Wird geprüft, wenn es die E-Mail-Adresse nicht gibt,
 * damit die Antwortzeit nicht verrät, ob ein Konto existiert.
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

/** Zufälliges Token für Cookies und E-Mail-Links (256 Bit, base64url). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** In der Datenbank steht nur dieser Hash. Ein Datenbank-Leck verrät so keine gültigen Tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

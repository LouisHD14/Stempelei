import { EventEmitter } from 'node:events';

/**
 * Meldet Änderungen an Karten an offene Gast-Ansichten (Server-Sent Events).
 * shortcut: läuft im Speicher des Prozesses, gilt nur bei einer Instanz. Bei mehreren Instanzen
 * auf PostgreSQL LISTEN/NOTIFY umstellen.
 */
const bus = new EventEmitter();
// Jede offene Gast-Ansicht ist ein Listener, die Standardgrenze von 10 wäre zu klein
bus.setMaxListeners(0);
const ANY_CARD = Symbol('jede Karte');
const PROGRAM = Symbol('Kartenart');

export function publishCardChange(cardId: string): void {
  bus.emit(cardId);
  bus.emit(ANY_CARD, cardId);
}

/** Für Wallet: jede Änderung an irgendeiner Karte. */
export function onAnyCardChange(fn: (cardId: string) => void): () => void {
  bus.on(ANY_CARD, fn);
  return () => bus.off(ANY_CARD, fn);
}

/** Der Inhaber hat eine Kartenart geändert (Name, Farbe, Prämien). Betrifft alle Karten dieser Art. */
export function publishProgramChange(programId: string): void {
  bus.emit(PROGRAM, programId);
}

export function onProgramChange(fn: (programId: string) => void): () => void {
  bus.on(PROGRAM, fn);
  return () => bus.off(PROGRAM, fn);
}

/** Ruft fn bei jeder Änderung der Karte auf. Liefert eine Funktion zum Abmelden. */
export function onCardChange(cardId: string, fn: () => void): () => void {
  bus.on(cardId, fn);
  return () => bus.off(cardId, fn);
}

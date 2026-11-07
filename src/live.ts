import { EventEmitter } from 'node:events';

/**
 * Meldet Änderungen an Karten an offene Gast-Ansichten (Server-Sent Events).
 * shortcut: läuft im Speicher des Prozesses, gilt nur bei einer Instanz. Bei mehreren Instanzen
 * auf PostgreSQL LISTEN/NOTIFY umstellen.
 */
const bus = new EventEmitter();
// Jede offene Gast-Ansicht ist ein Listener, die Standardgrenze von 10 wäre zu klein
bus.setMaxListeners(0);

export function publishCardChange(cardId: string): void {
  bus.emit(cardId);
}

/** Ruft fn bei jeder Änderung der Karte auf. Liefert eine Funktion zum Abmelden. */
export function onCardChange(cardId: string, fn: () => void): () => void {
  bus.on(cardId, fn);
  return () => bus.off(cardId, fn);
}

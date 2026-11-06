/**
 * Stempel-Logik ohne Datenbank: geben, einlösen, Prämien prüfen.
 * Alle Funktionen sind rein. Sie verändern nichts und geben einen neuen Zustand zurück.
 */

export const MAX_STAMPS = 20;
export const MAX_REWARDS = 5;
export const MAX_REWARD_TEXT = 40;

export interface Reward {
  id: string;
  threshold: number;
  text: string;
}

export interface CardState {
  stamps: number;
  cycle: number;
  claimed: readonly string[];
}

/** Prämien aufsteigend nach Stempelzahl, bei Gleichstand in fester Reihenfolge. */
export function sortRewards(rewards: readonly Reward[]): Reward[] {
  return [...rewards].sort((a, b) => a.threshold - b.threshold || a.id.localeCompare(b.id));
}

/** Länge der Karte = höchste Stempelzahl einer Prämie. */
export function cardLength(rewards: readonly Reward[]): number {
  if (rewards.length === 0) throw new Error('Eine Karte braucht mindestens eine Prämie.');
  return Math.max(...rewards.map((r) => r.threshold));
}

export function availableRewards(card: CardState, rewards: readonly Reward[]): Reward[] {
  return sortRewards(rewards).filter((r) => r.threshold <= card.stamps && !card.claimed.includes(r.id));
}

export function nextReward(card: CardState, rewards: readonly Reward[]): Reward | undefined {
  return sortRewards(rewards).find((r) => r.threshold > card.stamps);
}

export type GiveResult =
  | { ok: true; card: CardState; added: number }
  | { ok: false; reason: 'invalid_amount' | 'card_full' };

/** Gibt Stempel, höchstens bis zur Kartenlänge. */
export function giveStamps(card: CardState, rewards: readonly Reward[], amount: number): GiveResult {
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_STAMPS) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const length = cardLength(rewards);
  if (card.stamps >= length) return { ok: false, reason: 'card_full' };
  const added = Math.min(amount, length - card.stamps);
  return { ok: true, added, card: { ...card, stamps: card.stamps + added } };
}

export type RedeemResult =
  | { ok: true; card: CardState; reward: Reward; restarted: boolean }
  | { ok: false; reason: 'reward_not_found' | 'reward_not_available' };

/**
 * Löst eine Prämie ein. Sind danach alle Prämien eingelöst, beginnt eine neue Runde.
 * Stempel über der Kartenlänge (möglich, wenn der Betrieb die Karte verkürzt hat) werden mitgenommen.
 */
export function redeemReward(card: CardState, rewards: readonly Reward[], rewardId: string): RedeemResult {
  const reward = rewards.find((r) => r.id === rewardId);
  if (!reward) return { ok: false, reason: 'reward_not_found' };
  if (reward.threshold > card.stamps || card.claimed.includes(reward.id)) {
    return { ok: false, reason: 'reward_not_available' };
  }
  const claimed = [...card.claimed, reward.id];
  const restarted = rewards.every((r) => claimed.includes(r.id));
  if (restarted) {
    const carry = Math.max(0, card.stamps - cardLength(rewards));
    return { ok: true, reward, restarted, card: { stamps: carry, cycle: card.cycle + 1, claimed: [] } };
  }
  return { ok: true, reward, restarted, card: { ...card, claimed } };
}

/** Prüft eine Prämienliste aus dem Formular „Karte einrichten“. Gibt verständliche Fehler zurück. */
export function validateRewards(rewards: readonly { threshold: unknown; text: unknown }[]): string[] {
  const problems: string[] = [];
  if (rewards.length < 1) problems.push('Lege mindestens eine Prämie an.');
  if (rewards.length > MAX_REWARDS) problems.push(`Eine Karte hat höchstens ${MAX_REWARDS} Prämien.`);
  rewards.forEach((r, i) => {
    const n = i + 1;
    if (
      typeof r.threshold !== 'number' ||
      !Number.isInteger(r.threshold) ||
      r.threshold < 1 ||
      r.threshold > MAX_STAMPS
    ) {
      problems.push(`Prämie ${n}: Die Stempelzahl muss zwischen 1 und ${MAX_STAMPS} liegen.`);
    }
    if (typeof r.text !== 'string' || r.text.trim() === '') {
      problems.push(`Prämie ${n}: Beschreibe, was es gibt.`);
    } else if (r.text.trim().length > MAX_REWARD_TEXT) {
      problems.push(`Prämie ${n}: Der Text darf höchstens ${MAX_REWARD_TEXT} Zeichen haben.`);
    }
  });
  return problems;
}

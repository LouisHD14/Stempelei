/**
 * Stempel-Logik ohne Datenbank: geben und einlösen.
 * Alle Funktionen sind rein. Sie verändern nichts und geben einen neuen Zustand zurück.
 */

export const MAX_STAMPS = 20;

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

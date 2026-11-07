import type { GuestCardView } from '../cards.js';

/** Stempelfarben als RGB, umgerechnet aus den oklch-Werten in tokens.css (Wallet kennt kein oklch). */
export const INK_HEX: Record<string, string> = {
  tinte: '#172e5b',
  blau: '#1a469d',
  gruen: '#0e653f',
  koralle: '#ba4a34',
};
export const CARD_HEX = '#fdfbf8';

export const inkHex = (ink: string) => INK_HEX[ink] ?? (INK_HEX.tinte as string);

export function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Was auf der Wallet-Karte steht. Gleiche Zahlen wie auf der Gast-Ansicht. */
export function walletSummary(card: GuestCardView) {
  const rewards = [...card.rewards].sort((a, b) => a.threshold - b.threshold);
  const length = rewards.length ? Math.max(...rewards.map((r) => r.threshold)) : 0;
  const ready = rewards.filter((r) => r.threshold <= card.stamps && !r.claimed);
  const next = rewards.find((r) => r.threshold > card.stamps && !r.claimed);
  return {
    length,
    stampsText: `${card.stamps} / ${length}`,
    ready,
    next,
    nextIn: next ? next.threshold - card.stamps : 0,
    rewards,
  };
}

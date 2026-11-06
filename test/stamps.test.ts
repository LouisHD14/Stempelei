import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  availableRewards,
  type CardState,
  cardLength,
  giveStamps,
  type Reward,
  redeemReward,
} from '../src/domain/stamps.js';

const espresso: Reward = { id: 'a', threshold: 5, text: 'Espresso' };
const dessert: Reward = { id: 'b', threshold: 10, text: 'Dessert' };
const rewards = [dessert, espresso]; // absichtlich unsortiert
const card = (stamps: number, claimed: string[] = [], cycle = 1): CardState => ({ stamps, claimed, cycle });

describe('cardLength', () => {
  it('ist die höchste Stempelzahl', () => assert.equal(cardLength(rewards), 10));
  it('wirft ohne Prämien', () => assert.throws(() => cardLength([])));
});

describe('giveStamps', () => {
  it('gibt Stempel', () => {
    const r = giveStamps(card(3), rewards, 2);
    assert.deepEqual(r, { ok: true, added: 2, card: card(5) });
  });
  it('begrenzt auf die Kartenlänge', () => {
    const r = giveStamps(card(9), rewards, 5);
    assert.ok(r.ok);
    assert.equal(r.added, 1);
    assert.equal(r.card.stamps, 10);
  });
  it('lehnt volle Karten ab', () => {
    assert.deepEqual(giveStamps(card(10), rewards, 1), { ok: false, reason: 'card_full' });
  });
  it('lehnt volle Karten auch über der Länge ab', () => {
    assert.deepEqual(giveStamps(card(12), rewards, 1), { ok: false, reason: 'card_full' });
  });
  for (const amount of [0, -1, 1.5, 21, Number.NaN]) {
    it(`lehnt die Menge ${amount} ab`, () => {
      assert.deepEqual(giveStamps(card(0), rewards, amount), { ok: false, reason: 'invalid_amount' });
    });
  }
  it('verändert den Eingabezustand nicht', () => {
    const before = card(1);
    giveStamps(before, rewards, 1);
    assert.equal(before.stamps, 1);
  });
});

describe('availableRewards', () => {
  it('zeigt nichts unter der ersten Schwelle', () => {
    assert.deepEqual(availableRewards(card(4), rewards), []);
  });
  it('zeigt mehrere freie Prämien sortiert', () => {
    assert.deepEqual(availableRewards(card(10), rewards), [espresso, dessert]);
  });
  it('blendet eingelöste Prämien aus', () => {
    assert.deepEqual(availableRewards(card(10, ['a']), rewards), [dessert]);
  });
});

describe('redeemReward', () => {
  it('löst eine freie Prämie ein', () => {
    const r = redeemReward(card(6), rewards, 'a');
    assert.deepEqual(r, { ok: true, reward: espresso, restarted: false, card: card(6, ['a']) });
  });
  it('lehnt unbekannte Prämien ab', () => {
    assert.deepEqual(redeemReward(card(6), rewards, 'x'), { ok: false, reason: 'reward_not_found' });
  });
  it('lehnt noch nicht erreichte Prämien ab', () => {
    assert.deepEqual(redeemReward(card(6), rewards, 'b'), { ok: false, reason: 'reward_not_available' });
  });
  it('lehnt doppeltes Einlösen ab', () => {
    assert.deepEqual(redeemReward(card(6, ['a']), rewards, 'a'), {
      ok: false,
      reason: 'reward_not_available',
    });
  });
  it('startet nach der letzten Prämie eine neue Runde', () => {
    const r = redeemReward(card(10, ['a'], 2), rewards, 'b');
    assert.deepEqual(r, { ok: true, reward: dessert, restarted: true, card: card(0, [], 3) });
  });
  it('startet auch neu, wenn die große Prämie zuerst eingelöst wird', () => {
    const first = redeemReward(card(10), rewards, 'b');
    assert.ok(first.ok && !first.restarted);
    const second = redeemReward(first.card, rewards, 'a');
    assert.ok(second.ok && second.restarted);
    assert.equal(second.card.stamps, 0);
  });
  it('nimmt Stempel über einer verkürzten Karte mit', () => {
    const r = redeemReward(card(12), [espresso], 'a');
    assert.ok(r.ok);
    assert.deepEqual(r.card, card(7, [], 2));
  });
});

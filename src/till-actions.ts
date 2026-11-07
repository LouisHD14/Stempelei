import { and, count, desc, eq, inArray, isNull, sql, sum } from 'drizzle-orm';
import { cardUrl, isUniqueViolation, TOKEN_PATTERN } from './cards.js';
import type { Db } from './db/client.js';
import { cards, events, rewards, staff } from './db/schema.js';
import { SHORT_CODE_ALPHABET } from './domain/codes.js';
import { type CardState, giveStamps, redeemReward } from './domain/stamps.js';
import { publishCardChange } from './live.js';
import { loadPrograms, type ProgramView } from './routes/programs.js';

/**
 * Aktionen der Kasse auf einer Karte: suchen, stempeln, einlösen, rückgängig, Tagesprotokoll.
 * Die Regeln selbst stehen rein in domain/stamps.ts, hier passieren nur Sperren, Protokoll und Live-Meldung.
 */

/** Wer an der Kasse handelt. Jede Abfrage filtert nach businessId. */
export interface TillActor {
  businessId: string;
  deviceId: string;
  staffId: string;
  locationId: string | null;
}

export interface TillCard {
  id: string;
  shortCode: string;
  url: string;
  stamps: number;
  cycle: number;
  program: {
    id: string;
    name: string;
    earnRule: string;
    ink: string;
    rewards: { id: string; threshold: number; text: string; claimed: boolean }[];
  };
  canUndo: boolean;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type PrevState = { stamps: number; cycle: number; claimedRewardIds: string[] };

export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = new RegExp(TOKEN_PATTERN);
const SHORT_CODE_RE = new RegExp(`^[${SHORT_CODE_ALPHABET}]{6}$`);

const cardCols = {
  id: cards.id,
  businessId: cards.businessId,
  programId: cards.programId,
  publicToken: cards.publicToken,
  shortCode: cards.shortCode,
  stamps: cards.stamps,
  cycle: cards.cycle,
  claimedRewardIds: cards.claimedRewardIds,
};
type CardRow = { id: string; programId: string; publicToken: string; shortCode: string } & PrevState & {
    businessId: string;
  };

const stateOf = (c: PrevState): CardState => ({
  stamps: c.stamps,
  cycle: c.cycle,
  claimed: c.claimedRewardIds,
});
const prevOf = (c: PrevState): PrevState => ({
  stamps: c.stamps,
  cycle: c.cycle,
  claimedRewardIds: [...c.claimedRewardIds],
});

/** Neuestes noch nicht zurückgenommenes Stempeln oder Einlösen. Nur das kann rückgängig gemacht werden. */
async function undoTarget(q: Db | Tx, cardId: string) {
  const [ev] = await q
    .select({
      id: events.id,
      deviceId: events.deviceId,
      createdAt: events.createdAt,
      prevState: events.prevState,
    })
    .from(events)
    .where(
      and(
        eq(events.cardId, cardId),
        inArray(events.type, ['give', 'redeem']),
        isNull(events.undoneByEventId),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(1);
  return ev ?? null;
}

const undoAllowed = (ev: { deviceId: string | null; createdAt: Date } | null, deviceId: string) =>
  !!ev && ev.deviceId === deviceId && Date.now() - ev.createdAt.getTime() < UNDO_WINDOW_MS;

/** Kartenart der Karte. Auch archivierte, damit alte Karten an der Kasse lesbar bleiben. */
async function programOf(db: Db, businessId: string, programId: string): Promise<ProgramView | null> {
  const [prog] = await loadPrograms(db, businessId, [programId], { includeArchived: true });
  return prog ?? null;
}

/** Karte so, wie die Kasse sie sieht. */
export async function tillCard(db: Db, publicUrl: URL, cardId: string, actor: TillActor): Promise<TillCard> {
  const [row] = await db
    .select(cardCols)
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.businessId, actor.businessId)));
  if (!row) throw new Error('Karte nicht gefunden');
  const prog = await programOf(db, actor.businessId, row.programId);
  if (!prog) throw new Error('Kartenart nicht gefunden');
  return {
    id: row.id,
    shortCode: row.shortCode,
    url: cardUrl(publicUrl, row.publicToken),
    stamps: row.stamps,
    cycle: row.cycle,
    program: {
      ...prog,
      rewards: prog.rewards.map((r) => ({ ...r, claimed: row.claimedRewardIds.includes(r.id) })),
    },
    canUndo: undoAllowed(await undoTarget(db, row.id), actor.deviceId),
  };
}

/**
 * Sucht eine Karte per Gast-Token (aus dem QR-Code) oder per Kurzcode.
 * Kurzcodes sind nur pro Betrieb eindeutig, deshalb wird nur im eigenen Betrieb gesucht.
 */
export async function findCard(
  db: Db,
  businessId: string,
  rawRef: string,
): Promise<{ cardId: string } | { error: 'not_found' | 'foreign_card' }> {
  const ref = rawRef.trim();
  if (TOKEN_RE.test(ref)) {
    const [row] = await db
      .select({ id: cards.id, businessId: cards.businessId })
      .from(cards)
      .where(eq(cards.publicToken, ref));
    if (!row) return { error: 'not_found' };
    return row.businessId === businessId ? { cardId: row.id } : { error: 'foreign_card' };
  }
  const code = ref.toUpperCase();
  if (!SHORT_CODE_RE.test(code)) return { error: 'not_found' };
  const [row] = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.businessId, businessId), eq(cards.shortCode, code)));
  return row ? { cardId: row.id } : { error: 'not_found' };
}

type Replayed = {
  cardId: string;
  type: string;
  amount: number | null;
  rewardId: string | null;
  prevState: PrevState | null;
};

/** Ereignis, das dieses Gerät schon mit diesem Schlüssel geschrieben hat. */
async function replayOf(db: Db, actor: TillActor, key: string): Promise<Replayed | null> {
  const [ev] = await db
    .select({
      cardId: events.cardId,
      type: events.type,
      amount: events.amount,
      rewardId: events.rewardId,
      prevState: events.prevState,
    })
    .from(events)
    .where(
      and(
        eq(events.businessId, actor.businessId),
        eq(events.deviceId, actor.deviceId),
        eq(events.idempotencyKey, key),
      ),
    );
  return ev ?? null;
}

/**
 * Führt eine Aktion genau einmal aus. Kommt derselbe Schlüssel noch einmal (Doppeltipp, Netzfehler),
 * gibt es das ursprüngliche Ergebnis statt einer zweiten Buchung.
 */
async function once<T>(
  db: Db,
  actor: TillActor,
  key: string,
  expected: { cardId: string; type: 'give' | 'redeem' | 'undo' },
  fresh: () => Promise<T>,
  replay: (ev: Replayed) => T,
): Promise<T | { error: 'idempotency_conflict' }> {
  const match = (ev: Replayed) =>
    ev.cardId === expected.cardId && ev.type === expected.type
      ? replay(ev)
      : ({ error: 'idempotency_conflict' } as const);
  const before = await replayOf(db, actor, key);
  if (before) return match(before);
  try {
    return await fresh();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  // Eine gleichzeitige Anfrage mit demselben Schlüssel war schneller, ihr Ergebnis gilt
  const winner = await replayOf(db, actor, key);
  if (!winner) throw new Error('Ereignis zum Schlüssel fehlt');
  return match(winner);
}

/** Sperrt die Karte für die Dauer der Transaktion, damit zwei Kassen nicht gleichzeitig schreiben. */
async function lockCard(tx: Tx, actor: TillActor, cardId: string): Promise<CardRow | null> {
  const [row] = await tx
    .select(cardCols)
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.businessId, actor.businessId)))
    .for('update');
  return row ?? null;
}

/** Kartenart einer Karte des eigenen Betriebs, vor der Transaktion geladen (ändert sich nicht pro Karte). */
async function programOfCard(db: Db, actor: TillActor, cardId: string): Promise<ProgramView | null> {
  const [row] = await db
    .select({ programId: cards.programId })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.businessId, actor.businessId)));
  return row ? programOf(db, actor.businessId, row.programId) : null;
}

export async function giveAction(
  db: Db,
  actor: TillActor,
  cardId: string,
  amount: number,
  key: string,
): Promise<{ added: number } | { error: 'not_found' | 'card_full' | 'idempotency_conflict' }> {
  const prog = await programOfCard(db, actor, cardId);
  if (!prog) return { error: 'not_found' };
  return once(
    db,
    actor,
    key,
    { cardId, type: 'give' },
    async () => {
      const res = await db.transaction(async (tx) => {
        const card = await lockCard(tx, actor, cardId);
        if (!card) return { error: 'not_found' } as const;
        const r = giveStamps(stateOf(card), prog.rewards, amount);
        if (!r.ok) return { error: 'card_full' } as const; // invalid_amount verhindert schon das Schema
        await tx
          .update(cards)
          .set({ stamps: r.card.stamps, lastActivityAt: sql`now()` })
          .where(eq(cards.id, cardId));
        await tx.insert(events).values({
          businessId: actor.businessId,
          cardId,
          type: 'give',
          amount: r.added,
          staffId: actor.staffId,
          deviceId: actor.deviceId,
          locationId: actor.locationId,
          prevState: prevOf(card),
          idempotencyKey: key,
          createdAt: appliedAt,
        });
        return { added: r.added };
      });
      if ('added' in res) publishCardChange(cardId);
      return res;
    },
    (ev) => ({ added: ev.amount ?? 0 }),
  );
}

export async function redeemAction(
  db: Db,
  actor: TillActor,
  cardId: string,
  rewardId: string,
  key: string,
): Promise<
  { restarted: boolean } | { error: 'not_found' | 'reward_not_available' | 'idempotency_conflict' }
> {
  const prog = await programOfCard(db, actor, cardId);
  if (!prog) return { error: 'not_found' };
  return once(
    db,
    actor,
    key,
    { cardId, type: 'redeem' },
    async () => {
      const res = await db.transaction(async (tx) => {
        const card = await lockCard(tx, actor, cardId);
        if (!card) return { error: 'not_found' } as const;
        // Unbekannte oder archivierte Prämie ist für die Kasse genauso „nicht verfügbar“
        const r = redeemReward(stateOf(card), prog.rewards, rewardId);
        if (!r.ok) return { error: 'reward_not_available' } as const;
        await tx
          .update(cards)
          .set({
            stamps: r.card.stamps,
            cycle: r.card.cycle,
            claimedRewardIds: [...r.card.claimed],
            lastActivityAt: sql`now()`,
          })
          .where(eq(cards.id, cardId));
        await tx.insert(events).values({
          businessId: actor.businessId,
          cardId,
          type: 'redeem',
          rewardId,
          staffId: actor.staffId,
          deviceId: actor.deviceId,
          locationId: actor.locationId,
          prevState: prevOf(card),
          idempotencyKey: key,
          createdAt: appliedAt,
        });
        return { restarted: r.restarted };
      });
      if ('restarted' in res) publishCardChange(cardId);
      return res;
    },
    // Ob die Runde neu begann, steht nicht im Protokoll, ergibt sich aber eindeutig aus dem Stand davor
    (ev) => {
      const r =
        ev.prevState && ev.rewardId ? redeemReward(stateOf(ev.prevState), prog.rewards, ev.rewardId) : null;
      return { restarted: r?.ok === true && r.restarted };
    },
  );
}

/**
 * Zeitpunkt einer Buchung: clock_timestamp() statt now(), weil now() der Beginn der Transaktion ist.
 * Eine früher begonnene Transaktion kann die Kartensperre später bekommen und würde sonst als ältere
 * Buchung gelten, dann nähme „Rückgängig“ die falsche zurück.
 */
const appliedAt = sql`clock_timestamp()`;

/**
 * Nimmt die letzte Aktion zurück, wenn sie auf diesem Gerät in den letzten 24 Stunden passiert ist.
 * Mit Idempotenz-Schlüssel, damit eine Wiederholung nach Netzfehler nicht noch eine Aktion zurücknimmt.
 */
export async function undoAction(
  db: Db,
  actor: TillActor,
  cardId: string,
  key: string,
): Promise<{ ok: true } | { error: 'not_found' | 'nothing_to_undo' | 'idempotency_conflict' }> {
  return once(
    db,
    actor,
    key,
    { cardId, type: 'undo' },
    () => undoFresh(db, actor, cardId, key),
    () => ({ ok: true }) as const,
  );
}

async function undoFresh(
  db: Db,
  actor: TillActor,
  cardId: string,
  key: string,
): Promise<{ ok: true } | { error: 'not_found' | 'nothing_to_undo' }> {
  const res = await db.transaction(async (tx) => {
    const card = await lockCard(tx, actor, cardId);
    if (!card) return { error: 'not_found' } as const;
    const target = await undoTarget(tx, cardId);
    if (!target?.prevState || !undoAllowed(target, actor.deviceId))
      return { error: 'nothing_to_undo' } as const;
    const prev = target.prevState;
    await tx
      .update(cards)
      .set({
        stamps: prev.stamps,
        cycle: prev.cycle,
        claimedRewardIds: prev.claimedRewardIds,
        lastActivityAt: sql`now()`,
      })
      .where(eq(cards.id, cardId));
    const [undo] = await tx
      .insert(events)
      .values({
        businessId: actor.businessId,
        cardId,
        type: 'undo',
        staffId: actor.staffId,
        deviceId: actor.deviceId,
        locationId: actor.locationId,
        prevState: prevOf(card),
        idempotencyKey: key,
        createdAt: appliedAt,
      })
      .returning({ id: events.id });
    if (!undo) throw new Error('Rückgängig wurde nicht protokolliert');
    await tx.update(events).set({ undoneByEventId: undo.id }).where(eq(events.id, target.id));
    return { ok: true } as const;
  });
  if ('ok' in res) publishCardChange(cardId);
  return res;
}

// shortcut: Der Geschäftstag ist der Kalendertag in Europe/Berlin. Wenn Betriebe in anderen Zeitzonen
// dazukommen, die Zeitzone am Betrieb speichern.
const todayStart = sql`(date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')`;
const LOG_LIMIT = 100;

/** Heutiges Protokoll des Betriebs, neueste zuerst. Zurückgenommene Aktionen zählen nicht in den Zahlen. */
export async function todayLog(db: Db, businessId: string) {
  const today = and(eq(events.businessId, businessId), sql`${events.createdAt} >= ${todayStart}`);
  const live = and(today, isNull(events.undoneByEventId));
  const [[issued], [given], [redeemed], rows] = await Promise.all([
    db
      .select({ n: count() })
      .from(events)
      .where(and(today, eq(events.type, 'issue'))),
    db
      .select({ n: sum(events.amount) })
      .from(events)
      .where(and(live, eq(events.type, 'give'))),
    db
      .select({ n: count() })
      .from(events)
      .where(and(live, eq(events.type, 'redeem'))),
    db
      .select({
        id: events.id,
        type: events.type,
        amount: events.amount,
        rewardText: rewards.text,
        staffName: staff.name,
        shortCode: cards.shortCode,
        createdAt: events.createdAt,
        undoneBy: events.undoneByEventId,
      })
      .from(events)
      .innerJoin(cards, eq(cards.id, events.cardId))
      .leftJoin(rewards, eq(rewards.id, events.rewardId))
      .leftJoin(staff, eq(staff.id, events.staffId))
      .where(today)
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(LOG_LIMIT),
  ]);
  return {
    stats: { issued: issued?.n ?? 0, stamps: Number(given?.n ?? 0), redeemed: redeemed?.n ?? 0 },
    events: rows.map(({ undoneBy, ...e }) => ({ ...e, undone: undoneBy !== null })),
  };
}

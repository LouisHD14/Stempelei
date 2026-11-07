import { and, eq, isNull } from 'drizzle-orm';
import qrcode from 'qrcode-generator';
import type { Db } from './db/client.js';
import { businesses, cards, events } from './db/schema.js';
import { publicToken, shortCode } from './domain/codes.js';
import { loadPrograms } from './routes/programs.js';

/** Gast-Token: 22 Zeichen Base62, siehe domain/codes.ts */
export const TOKEN_PATTERN = '^[0-9A-Za-z]{22}$';

export function cardUrl(publicUrl: URL, token: string): string {
  return new URL(`/c/${token}`, publicUrl).href;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Gibt eine neue Karte aus. Kurzcodes sind pro Betrieb eindeutig, bei einer Kollision wird neu gewürfelt.
 * Bei 31^6 ≈ 900 Mio. Codes reicht das selbst für sehr große Betriebe.
 */
export async function issueCard(
  db: Db,
  input: { businessId: string; programId: string; deviceId?: string; staffId?: string; locationId?: string },
): Promise<{ id: string; publicToken: string; shortCode: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [card] = await tx
          .insert(cards)
          .values({
            businessId: input.businessId,
            programId: input.programId,
            publicToken: publicToken(),
            shortCode: shortCode(),
          })
          .returning({ id: cards.id, publicToken: cards.publicToken, shortCode: cards.shortCode });
        if (!card) throw new Error('Karte wurde nicht angelegt');
        await tx.insert(events).values({
          businessId: input.businessId,
          cardId: card.id,
          type: 'issue',
          deviceId: input.deviceId,
          staffId: input.staffId,
          locationId: input.locationId,
        });
        return card;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('Kein freier Kurzcode gefunden');
}

export interface GuestCardView {
  business: string;
  name: string;
  earnRule: string;
  ink: string;
  stamps: number;
  cycle: number;
  shortCode: string;
  rewards: { threshold: number; text: string; claimed: boolean }[];
}

/** Karte so, wie der Gast sie sieht, plus die internen Angaben, die nur der Server braucht. */
export async function loadCard(
  db: Db,
  by: { token: string } | { id: string },
): Promise<{
  id: string;
  token: string;
  programId: string;
  businessId: string;
  updatedAt: Date;
  view: GuestCardView;
} | null> {
  const [row] = await db
    .select({
      id: cards.id,
      token: cards.publicToken,
      businessId: cards.businessId,
      programId: cards.programId,
      stamps: cards.stamps,
      cycle: cards.cycle,
      shortCode: cards.shortCode,
      claimed: cards.claimedRewardIds,
      business: businesses.name,
      lastActivityAt: cards.lastActivityAt,
    })
    .from(cards)
    .innerJoin(businesses, eq(businesses.id, cards.businessId))
    .where(
      and(
        'token' in by ? eq(cards.publicToken, by.token) : eq(cards.id, by.id),
        isNull(businesses.deletedAt),
      ),
    );
  if (!row) return null;
  // Auch eine archivierte Kartenart soll für Gäste lesbar bleiben, deshalb ohne Archiv-Filter laden
  const [prog] = await loadPrograms(db, row.businessId, [row.programId], { includeArchived: true });
  if (!prog) return null;
  return {
    id: row.id,
    token: row.token,
    programId: row.programId,
    businessId: row.businessId,
    // Wallet fragt „was hat sich seit … geändert“: Stempel oder Änderung der Kartenart zählen
    updatedAt: new Date(Math.max(row.lastActivityAt.getTime(), prog.updatedAt.getTime())),
    view: {
      business: row.business,
      name: prog.name,
      earnRule: prog.earnRule,
      ink: prog.ink,
      stamps: row.stamps,
      cycle: row.cycle,
      shortCode: row.shortCode,
      rewards: prog.rewards.map((r) => ({
        threshold: r.threshold,
        text: r.text,
        claimed: row.claimed.includes(r.id),
      })),
    },
  };
}

/** Karte so, wie der Gast sie sieht: ohne interne IDs, ohne Daten anderer Karten. */
export async function guestCardView(db: Db, token: string): Promise<(GuestCardView & { id: string }) | null> {
  const card = await loadCard(db, { token });
  return card ? { id: card.id, ...card.view } : null;
}

/** QR-Code als SVG, schwarz auf weiß mit Ruhezone, damit jede Kamera ihn liest. */
export function qrSvg(text: string): string {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const margin = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const size = n + 2 * margin;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

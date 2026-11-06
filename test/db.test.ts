import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { businesses, cards, events, programs, rewards } from '../src/db/schema.js';
import { publicToken, shortCode } from '../src/domain/codes.js';
import { trialEndsAt } from '../src/domain/plans.js';

// Diese Tests löschen den Inhalt der Datenbank. Sie laufen nur mit einer eigenen Test-Datenbank.
const url = process.env.TEST_DATABASE_URL;

describe('Datenbank', { skip: url ? false : 'TEST_DATABASE_URL ist nicht gesetzt' }, () => {
  let conn: ReturnType<typeof createDb>;

  before(async () => {
    const admin = createDb(url as string, { max: 1 });
    await admin.sql.unsafe(
      'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
    );
    await admin.close();
    await runMigrations(url as string);
    conn = createDb(url as string, { max: 2 });
  });
  after(() => conn?.close());

  it('Migrationen lassen sich mehrfach ausführen', async () => {
    await runMigrations(url as string);
    const rows = await conn.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    assert.deepEqual(
      rows.map((r) => r.table_name),
      [
        'businesses',
        'cards',
        'devices',
        'email_tokens',
        'events',
        'locations',
        'programs',
        'rewards',
        'sessions',
        'staff',
        'users',
      ],
    );
  });

  it('legt Betrieb, Karte und Ereignis an und löscht alles mit dem Betrieb', async () => {
    const { db } = conn;
    const [biz] = await db
      .insert(businesses)
      .values({ name: 'Trattoria Mia', slug: 'trattoria-mia', trialEndsAt: trialEndsAt(new Date()) })
      .returning();
    assert.ok(biz);
    assert.equal(biz.plan, 'klein');
    assert.equal(biz.subscriptionStatus, 'trialing');

    const [prog] = await db.insert(programs).values({ businessId: biz.id, name: 'Stammkarte' }).returning();
    assert.ok(prog);
    const [rew] = await db
      .insert(rewards)
      .values({ programId: prog.id, threshold: 5, text: 'Espresso' })
      .returning();
    assert.ok(rew);
    const [c] = await db
      .insert(cards)
      .values({ businessId: biz.id, programId: prog.id, publicToken: publicToken(), shortCode: shortCode() })
      .returning();
    assert.ok(c);
    assert.deepEqual(c.claimedRewardIds, []);
    assert.equal(c.cycle, 1);

    await db.insert(events).values({
      businessId: biz.id,
      cardId: c.id,
      type: 'give',
      amount: 1,
      prevState: { stamps: 0, cycle: 1, claimedRewardIds: [] },
    });
    await db
      .update(cards)
      .set({ stamps: 1, claimedRewardIds: [rew.id] })
      .where(eq(cards.id, c.id));
    const [updated] = await db.select().from(cards).where(eq(cards.id, c.id));
    assert.deepEqual(updated?.claimedRewardIds, [rew.id]);

    await db.delete(businesses).where(eq(businesses.id, biz.id));
    const [{ n }] = (await conn.sql`select
      (select count(*) from cards) + (select count(*) from events) + (select count(*) from programs) + (select count(*) from rewards) as n`) as unknown as [
      { n: string },
    ];
    assert.equal(Number(n), 0);
  });

  it('prüft Grenzen in der Datenbank', async () => {
    const { db } = conn;
    const [biz] = await db
      .insert(businesses)
      .values({ name: 'Café', slug: 'cafe', trialEndsAt: new Date() })
      .returning();
    assert.ok(biz);
    const [prog] = await db.insert(programs).values({ businessId: biz.id, name: 'Kaffee' }).returning();
    assert.ok(prog);
    await assert.rejects(db.insert(rewards).values({ programId: prog.id, threshold: 21, text: 'x' }));
    await assert.rejects(
      db.insert(cards).values({
        businessId: biz.id,
        programId: prog.id,
        publicToken: publicToken(),
        shortCode: 'AAAAAA',
        stamps: -1,
      }),
    );
    await db
      .insert(cards)
      .values({ businessId: biz.id, programId: prog.id, publicToken: publicToken(), shortCode: 'BBBBBB' });
    await assert.rejects(
      db
        .insert(cards)
        .values({ businessId: biz.id, programId: prog.id, publicToken: publicToken(), shortCode: 'BBBBBB' }),
      'Kurzcode muss pro Betrieb eindeutig sein',
    );
  });

  it('verhindert doppelte Aktionen mit demselben Idempotenz-Schlüssel', async () => {
    const { db } = conn;
    const [biz] = await db
      .insert(businesses)
      .values({ name: 'Eis', slug: 'eis', trialEndsAt: new Date() })
      .returning();
    assert.ok(biz);
    const [prog] = await db.insert(programs).values({ businessId: biz.id, name: 'Kugeln' }).returning();
    assert.ok(prog);
    const [c] = await db
      .insert(cards)
      .values({ businessId: biz.id, programId: prog.id, publicToken: publicToken(), shortCode: 'CCCCCC' })
      .returning();
    assert.ok(c);
    const [dev] = (await conn.sql`
      insert into devices (business_id, name, token_hash) values (${biz.id}, 'Tresen', 'hash-1') returning id`) as unknown as [
      { id: string },
    ];
    const ev = {
      businessId: biz.id,
      cardId: c.id,
      type: 'give' as const,
      amount: 1,
      deviceId: dev.id,
      idempotencyKey: 'k1',
    };
    await db.insert(events).values(ev);
    await assert.rejects(db.insert(events).values(ev));
    // Ohne Schlüssel sind beliebig viele Einträge erlaubt
    await db.insert(events).values({ ...ev, idempotencyKey: null });
    await db.insert(events).values({ ...ev, idempotencyKey: null });
  });

  it('E-Mail-Adressen sind ohne Groß- und Kleinschreibung eindeutig', async () => {
    const [biz] = await conn.db
      .insert(businesses)
      .values({ name: 'Bäckerei', slug: 'baeckerei', trialEndsAt: new Date() })
      .returning();
    assert.ok(biz);
    await conn.sql`insert into users (business_id, email, password_hash) values (${biz.id}, 'Anna@Example.de', 'x')`;
    await assert.rejects(
      conn.sql`insert into users (business_id, email, password_hash) values (${biz.id}, 'anna@example.de', 'x')`,
    );
  });
});

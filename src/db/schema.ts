import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const tz = (name: string) => timestamp(name, { withTimezone: true });

export const planEnum = pgEnum('plan', ['klein', 'mittel', 'gross']);
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
]);
export const localeEnum = pgEnum('locale', ['de', 'en']);
export const eventTypeEnum = pgEnum('event_type', ['issue', 'give', 'redeem', 'undo']);

/** Ein Betrieb mit Abo. Alle anderen Betriebsdaten hängen daran und werden mit ihm gelöscht. */
export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: planEnum('plan').notNull().default('klein'),
  subscriptionStatus: subscriptionStatusEnum('subscription_status').notNull().default('trialing'),
  trialEndsAt: tz('trial_ends_at').notNull(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  createdAt: createdAt(),
  deletedAt: tz('deleted_at'),
});

/** Inhaber und spätere Verwaltungskonten. Anmeldung mit E-Mail und Passwort. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: tz('email_verified_at'),
    /** Sprache für E-Mails, gewählt bei der Registrierung */
    locale: localeEnum('locale').notNull().default('de'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    index('users_business_idx').on(t.businessId),
  ],
);

/** Login-Sitzungen. Gespeichert wird nur der Hash des Tokens aus dem Cookie. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: tz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const emailTokenPurposeEnum = pgEnum('email_token_purpose', ['verify', 'reset']);

/** Einmal-Links aus E-Mails (Adresse bestätigen, Passwort zurücksetzen). Gespeichert wird nur der Hash. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: emailTokenPurposeEnum('purpose').notNull(),
    expiresAt: tz('expires_at').notNull(),
    usedAt: tz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId)],
);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: text('address').notNull().default(''),
    archivedAt: tz('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [index('locations_business_idx').on(t.businessId)],
);

/** Eine Kartenart („Stempelkarte“ im Paket) mit eigener Regel und eigenen Prämien. */
export const programs = pgTable(
  'programs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    earnRule: text('earn_rule').notNull().default(''),
    ink: text('ink').notNull().default('blau'),
    archivedAt: tz('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [index('programs_business_idx').on(t.businessId)],
);

/** Prämien werden nur archiviert, nie gelöscht, damit alte Einlösungen lesbar bleiben. */
export const rewards = pgTable(
  'rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    threshold: smallint('threshold').notNull(),
    text: text('text').notNull(),
    archivedAt: tz('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('rewards_program_idx').on(t.programId),
    check('rewards_threshold_range', sql`${t.threshold} between 1 and 20`),
  ],
);

/** Team-Mitglieder, die an der Kasse mit persönlicher PIN stempeln. */
export const staff = pgTable(
  'staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    pinHash: text('pin_hash').notNull(),
    archivedAt: tz('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [index('staff_business_idx').on(t.businessId)],
);

/** Freigeschaltete Kassengeräte. Die PIN-Sperre zählt pro Gerät. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    failedPinAttempts: integer('failed_pin_attempts').notNull().default(0),
    pinLockedUntil: tz('pin_locked_until'),
    lastSeenAt: tz('last_seen_at'),
    revokedAt: tz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('devices_business_idx').on(t.businessId)],
);

/** Die Karte eines Gasts. Kein Name, keine E-Mail: nur Token, Stempel und Zeitpunkte. */
export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    publicToken: text('public_token').notNull().unique(),
    shortCode: text('short_code').notNull(),
    stamps: smallint('stamps').notNull().default(0),
    cycle: integer('cycle').notNull().default(1),
    claimedRewardIds: uuid('claimed_reward_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    lastActivityAt: tz('last_activity_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cards_business_short_code_idx').on(t.businessId, t.shortCode),
    index('cards_program_idx').on(t.programId),
    check('cards_stamps_non_negative', sql`${t.stamps} >= 0`),
    check('cards_cycle_positive', sql`${t.cycle} >= 1`),
  ],
);

/** Protokoll aller Aktionen auf einer Karte. Wird nur ergänzt, nie geändert (außer undone_by_event_id). */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    type: eventTypeEnum('type').notNull(),
    amount: smallint('amount'),
    rewardId: uuid('reward_id').references(() => rewards.id, { onDelete: 'set null' }),
    staffId: uuid('staff_id').references(() => staff.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    prevState: jsonb('prev_state').$type<{ stamps: number; cycle: number; claimedRewardIds: string[] }>(),
    undoneByEventId: uuid('undone_by_event_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
  },
  (t) => [
    index('events_card_created_idx').on(t.cardId, t.createdAt.desc()),
    index('events_business_created_idx').on(t.businessId, t.createdAt.desc()),
    uniqueIndex('events_device_idempotency_idx')
      .on(t.deviceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

/**
 * Einmal-Codes zum Freischalten eines Kassengeräts (8 Ziffern, 10 Minuten gültig).
 * Gespeichert wird nur der Hash. Beim Einlösen wird die Zeile gelöscht, so gilt jeder Code einmal.
 */
export const pairingCodes = pgTable(
  'pairing_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    expiresAt: tz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('pairing_codes_business_idx').on(t.businessId)],
);

/** PIN-Sitzungen an der Kasse: ein Team-Mitglied auf einem Gerät, 15 Minuten ab der letzten Aktion. */
export const tillSessions = pgTable(
  'till_sessions',
  {
    idHash: text('id_hash').primaryKey(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    expiresAt: tz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('till_sessions_staff_idx').on(t.staffId), index('till_sessions_device_idx').on(t.deviceId)],
);

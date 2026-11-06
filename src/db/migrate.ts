import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

/** Ordner mit den SQL-Migrationen. Gilt für src/db (Entwicklung) und build/db (Betrieb). */
export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, '../../drizzle');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const conn = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(conn.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await conn.close();
  }
}

// Direkt aufgerufen: npm run db:migrate bzw. node build/db/migrate.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL fehlt.');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migrationen ausgeführt.'))
    .catch((err: unknown) => {
      console.error('Migration fehlgeschlagen:', err);
      process.exit(1);
    });
}

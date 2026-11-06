import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './db/client.js';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const conn = createDb(config.databaseUrl);
  const app = await buildApp({ config, pingDb: conn.ping });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} empfangen, fahre herunter`);
    try {
      await app.close();
      await conn.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Fehler beim Herunterfahren');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});

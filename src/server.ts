import { readFileSync } from 'node:fs';
import { buildApp, PUBLIC_DIR } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { logMailer, type Mailer, smtpMailer } from './mail.js';
import { apnsPusher } from './wallet/apple.js';
import { googleApi } from './wallet/google.js';
import { loadAppleImages, startWalletSync, type Wallet } from './wallet/index.js';

/** Liest die Wallet-Zugangsdaten aus den Dateien, die in der Konfiguration stehen. */
function loadWallet(config: ReturnType<typeof loadConfig>): Wallet {
  const wallet: Wallet = {};
  const a = config.wallet.apple;
  if (a) {
    const cfg = {
      passTypeId: a.passTypeId,
      teamId: a.teamId,
      certPem: readFileSync(a.certFile, 'utf8'),
      keyPem: readFileSync(a.keyFile, 'utf8'),
      ...(a.keyPassphrase ? { keyPassphrase: a.keyPassphrase } : {}),
      wwdrPem: readFileSync(a.wwdrFile, 'utf8'),
      secret: a.secret,
      webServiceUrl: new URL('/wallet/apple', config.publicUrl).href,
      images: loadAppleImages(PUBLIC_DIR),
    };
    wallet.apple = { cfg, pusher: apnsPusher(cfg, a.apnsHost) };
  }
  const g = config.wallet.google;
  if (g) {
    const key = JSON.parse(readFileSync(g.keyFile, 'utf8')) as { client_email: string; private_key: string };
    const cfg = {
      issuerId: g.issuerId,
      clientEmail: key.client_email,
      privateKeyPem: key.private_key,
      publicUrl: config.publicUrl,
    };
    wallet.google = { cfg, api: googleApi(cfg) };
  }
  return wallet;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const conn = createDb(config.databaseUrl);
  // Ohne SMTP_URL (nur Entwicklung, im Betrieb Pflicht) stehen die Mails im Log
  const mailer: Mailer = config.smtpUrl
    ? smtpMailer(config.smtpUrl, config.mailFrom)
    : { send: (mail) => logMailer(app.log).send(mail) };
  const wallet = loadWallet(config);
  const app = await buildApp({ config, pingDb: conn.ping, db: conn.db, mailer, wallet });
  const stopWallet = startWalletSync(conn.db, wallet, config.publicUrl, app.log);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} empfangen, fahre herunter`);
    try {
      stopWallet();
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
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});

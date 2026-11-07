export type NodeEnv = 'development' | 'production' | 'test';

export interface Config {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  publicUrl: URL;
  databaseUrl: string;
  trustProxy: boolean;
  logLevel: string;
  /** SMTP-Zugang, z. B. smtp://login:schluessel@smtp-relay.brevo.com:587. Fehlt er, landen Mails im Log. */
  smtpUrl: string | null;
  /** Absender, z. B. "Stempelei <hallo@deine-domain.de>" */
  mailFrom: string;
  /** Apple und Google Wallet. Jeweils null, solange die Zugangsdaten fehlen: Dann gibt es keinen Knopf. */
  wallet: {
    apple: {
      passTypeId: string;
      teamId: string;
      certFile: string;
      keyFile: string;
      keyPassphrase?: string;
      wwdrFile: string;
      secret: string;
      apnsHost: string;
    } | null;
    google: { issuerId: string; keyFile: string } | null;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Ungültige Konfiguration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** Liest die Konfiguration aus Umgebungsvariablen und meldet alle Fehler auf einmal. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const nodeEnvRaw = env.NODE_ENV ?? 'development';
  let nodeEnv: NodeEnv = 'development';
  if (nodeEnvRaw === 'development' || nodeEnvRaw === 'production' || nodeEnvRaw === 'test') {
    nodeEnv = nodeEnvRaw;
  } else {
    problems.push(`NODE_ENV muss development, production oder test sein, ist aber "${nodeEnvRaw}".`);
  }

  const portRaw = env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) {
    problems.push(`PORT muss eine Zahl zwischen 1 und 65535 sein, ist aber "${portRaw}".`);
  }

  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) {
    problems.push('DATABASE_URL fehlt, z. B. postgres://user:passwort@localhost:5432/stempelei.');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL muss mit postgres:// oder postgresql:// beginnen.');
  }

  let publicUrl = new URL('http://localhost:3000');
  if (env.PUBLIC_URL) {
    try {
      publicUrl = new URL(env.PUBLIC_URL);
      if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') {
        problems.push('PUBLIC_URL muss mit https:// oder http:// beginnen.');
      } else if (nodeEnv === 'production' && publicUrl.protocol !== 'https:') {
        problems.push('PUBLIC_URL muss im Betrieb mit https:// beginnen.');
      }
    } catch {
      problems.push(`PUBLIC_URL ist keine gültige Adresse: "${env.PUBLIC_URL}".`);
    }
  } else if (nodeEnv === 'production') {
    problems.push('PUBLIC_URL fehlt, z. B. https://deine-domain.de.');
  }

  const trustRaw = (env.TRUST_PROXY ?? 'false').toLowerCase();
  if (trustRaw !== 'true' && trustRaw !== 'false') {
    problems.push(`TRUST_PROXY muss true oder false sein, ist aber "${env.TRUST_PROXY}".`);
  }

  const logLevel = env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info');
  if (!LOG_LEVELS.includes(logLevel)) {
    problems.push(`LOG_LEVEL muss einer dieser Werte sein: ${LOG_LEVELS.join(', ')}.`);
  }

  const smtpUrl = env.SMTP_URL || null;
  if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl)) {
    problems.push('SMTP_URL muss mit smtp:// oder smtps:// beginnen.');
  } else if (!smtpUrl && nodeEnv === 'production') {
    problems.push('SMTP_URL fehlt, z. B. smtp://login:schluessel@smtp-relay.brevo.com:587.');
  }
  const mailFrom = env.MAIL_FROM || 'Stempelei <hallo@localhost>';
  if (!env.MAIL_FROM && nodeEnv === 'production') {
    problems.push('MAIL_FROM fehlt, z. B. "Stempelei <hallo@deine-domain.de>".');
  }

  // Apple Wallet: alles oder nichts
  const appleVars = [
    'APPLE_PASS_TYPE_ID',
    'APPLE_TEAM_ID',
    'APPLE_PASS_CERT',
    'APPLE_PASS_KEY',
    'APPLE_WWDR_CERT',
    'WALLET_SECRET',
  ];
  const appleSet = appleVars.filter((k) => env[k]);
  let apple: Config['wallet']['apple'] = null;
  if (appleSet.length && appleSet.length < appleVars.length) {
    problems.push(`Für Apple Wallet fehlen: ${appleVars.filter((k) => !env[k]).join(', ')}.`);
  } else if (appleSet.length) {
    if ((env.WALLET_SECRET ?? '').length < 32) problems.push('WALLET_SECRET braucht mindestens 32 Zeichen.');
    if (!/^pass\.[A-Za-z0-9.-]+$/.test(env.APPLE_PASS_TYPE_ID ?? '')) {
      problems.push('APPLE_PASS_TYPE_ID muss mit pass. beginnen, z. B. pass.de.deine-domain.stempelkarte.');
    }
    if (publicUrl.protocol !== 'https:') problems.push('Apple Wallet braucht eine PUBLIC_URL mit https://.');
    apple = {
      passTypeId: env.APPLE_PASS_TYPE_ID as string,
      teamId: env.APPLE_TEAM_ID as string,
      certFile: env.APPLE_PASS_CERT as string,
      keyFile: env.APPLE_PASS_KEY as string,
      ...(env.APPLE_PASS_KEY_PASSPHRASE ? { keyPassphrase: env.APPLE_PASS_KEY_PASSPHRASE } : {}),
      wwdrFile: env.APPLE_WWDR_CERT as string,
      secret: env.WALLET_SECRET as string,
      apnsHost: env.APNS_HOST || 'api.push.apple.com',
    };
  }
  // Google Wallet: Issuer-ID und Schlüsseldatei des Dienstkontos
  let google: Config['wallet']['google'] = null;
  if (Boolean(env.GOOGLE_WALLET_ISSUER_ID) !== Boolean(env.GOOGLE_WALLET_KEY_FILE)) {
    problems.push('Für Google Wallet braucht es GOOGLE_WALLET_ISSUER_ID und GOOGLE_WALLET_KEY_FILE.');
  } else if (env.GOOGLE_WALLET_ISSUER_ID) {
    if (!/^[0-9]+$/.test(env.GOOGLE_WALLET_ISSUER_ID))
      problems.push('GOOGLE_WALLET_ISSUER_ID besteht nur aus Ziffern.');
    google = { issuerId: env.GOOGLE_WALLET_ISSUER_ID, keyFile: env.GOOGLE_WALLET_KEY_FILE as string };
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    nodeEnv,
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl,
    databaseUrl,
    trustProxy: trustRaw === 'true',
    logLevel,
    smtpUrl,
    mailFrom,
    wallet: { apple, google },
  };
}

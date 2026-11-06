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
  };
}

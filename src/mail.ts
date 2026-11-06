import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Versand über SMTP, im Betrieb über Brevo (smtp-relay.brevo.com). */
export function smtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}

/** Ohne SMTP_URL in der Entwicklung: Die Mail steht im Log, damit man die Links anklicken kann. */
export function logMailer(log: FastifyBaseLogger): Mailer {
  return {
    async send(mail) {
      log.info({ to: mail.to, subject: mail.subject }, `E-Mail (nicht versendet):\n${mail.text}`);
    },
  };
}

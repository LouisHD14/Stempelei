export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

interface MailText {
  subject: string;
  text: string;
}

/** Texte der E-Mails in beiden Sprachen. Die Links stehen jeweils auf einer eigenen Zeile. */
export const mailTexts = {
  verify(locale: Locale, link: string, hours: number): MailText {
    return locale === 'en'
      ? {
          subject: 'Please confirm your email address',
          text: [
            'Hello,',
            '',
            'thanks for signing up for Stempelei. Please confirm your email address with this link:',
            '',
            link,
            '',
            `The link is valid for ${hours} hours. If you did not sign up, you can ignore this email.`,
          ].join('\n'),
        }
      : {
          subject: 'Bitte bestätige deine E-Mail-Adresse',
          text: [
            'Hallo,',
            '',
            'danke für deine Anmeldung bei Stempelei. Bitte bestätige deine E-Mail-Adresse mit diesem Link:',
            '',
            link,
            '',
            `Der Link gilt ${hours} Stunden. Wenn du dich nicht angemeldet hast, kannst du diese E-Mail ignorieren.`,
          ].join('\n'),
        };
  },

  alreadyRegistered(locale: Locale, forgotLink: string): MailText {
    return locale === 'en'
      ? {
          subject: 'You already have a Stempelei account',
          text: [
            'Hello,',
            '',
            'someone tried to create a new account with this email address. There already is one.',
            'Forgot your password? You can set a new one here:',
            '',
            forgotLink,
            '',
            'If this was not you, you do not need to do anything.',
          ].join('\n'),
        }
      : {
          subject: 'Du hast schon ein Konto bei Stempelei',
          text: [
            'Hallo,',
            '',
            'jemand wollte mit dieser E-Mail-Adresse ein neues Konto anlegen. Es gibt schon eins.',
            'Hast du dein Passwort vergessen? Hier kannst du ein neues setzen:',
            '',
            forgotLink,
            '',
            'Warst du das nicht, musst du nichts tun.',
          ].join('\n'),
        };
  },

  reset(locale: Locale, link: string, hours: number): MailText {
    return locale === 'en'
      ? {
          subject: 'New password for Stempelei',
          text: [
            'Hello,',
            '',
            'use this link to set a new password:',
            '',
            link,
            '',
            `The link is valid for ${hours} hour. If you did not ask for a new password, you do not need to do anything.`,
          ].join('\n'),
        }
      : {
          subject: 'Neues Passwort für Stempelei',
          text: [
            'Hallo,',
            '',
            'mit diesem Link setzt du ein neues Passwort:',
            '',
            link,
            '',
            `Der Link gilt ${hours} Stunde. Hast du kein neues Passwort angefordert, musst du nichts tun.`,
          ].join('\n'),
        };
  },
};

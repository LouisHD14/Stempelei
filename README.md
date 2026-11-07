# Stempelei

Digitale Stempelkarten für Restaurants, Cafés und Läden. Gäste sammeln Stempel auf dem Handy, Betriebe stempeln an der Kasse per QR-Scan.

Die Website richtet sich an Betriebe: Sie legen ein Konto an und verwalten dort ihre Stempelkarten. Gäste sehen später nur ihre eigene Karte. Alle Seiten gibt es auf Deutsch und Englisch.

Stand: Phase 1 des Backends ist fertig. Betriebe können sich registrieren, ihre E-Mail bestätigen, sich anmelden und ihr Passwort zurücksetzen. Nach der Anmeldung zeigt `/dashboard` die nächsten Schritte. Den Plan findest du in [`docs/BACKEND-PLAN.md`](docs/BACKEND-PLAN.md).

## Schnellstart mit Docker

```sh
docker compose up --build
```

Danach ist die Website unter http://localhost:3000 erreichbar. Beim Start laufen die Datenbank-Migrationen automatisch.

Ohne Mail-Zugang lege eine `.env` mit `NODE_ENV=development` und `PUBLIC_URL=http://localhost:3000` an. Dann stehen die E-Mails mit ihren Links im Log (`docker compose logs app`).

## Entwicklung ohne Docker

Voraussetzungen: Node.js 22 und PostgreSQL ab Version 16.

```sh
cp .env.example .env          # Werte anpassen
npm install
npm run db:migrate            # Tabellen anlegen
npm run dev                   # Server mit automatischem Neustart
```

Der Server liest `.env` nicht selbst. Lade die Datei mit `node --env-file=.env` oder exportiere die Variablen in deiner Shell.

| Befehl | Was er tut |
| --- | --- |
| `npm run dev` | Startet den Server aus `src/` und startet bei Änderungen neu |
| `npm run build` / `npm start` | Baut nach `build/` und startet die gebaute Version |
| `npm test` | Alle Tests. Datenbanktests laufen nur mit `TEST_DATABASE_URL` und **löschen den Inhalt dieser Datenbank** |
| `npm run check` | Lint und Formatprüfung mit Biome (`npm run format` behebt Formatfehler) |
| `npm run typecheck` | TypeScript-Prüfung |
| `npm run db:generate` | Erzeugt nach einer Änderung an `src/db/schema.ts` eine neue Migration in `drizzle/` |
| `npm run db:migrate` | Führt offene Migrationen aus |

## Konfiguration

Alle Einstellungen kommen aus Umgebungsvariablen, siehe `.env.example`. Fehlt etwas oder ist ein Wert ungültig, bricht der Server mit einer Liste aller Fehler ab.

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `DATABASE_URL` | ja | PostgreSQL-Verbindung |
| `PUBLIC_URL` | im Betrieb | Öffentliche Adresse, im Betrieb mit `https://` |
| `PORT`, `HOST` | nein | Standard `3000` und `0.0.0.0` |
| `TRUST_PROXY` | nein | `true`, wenn ein Proxy wie Caddy davor läuft |
| `LOG_LEVEL` | nein | Standard `info` |
| `SMTP_URL` | im Betrieb | Mail-Versand, bei Brevo `smtp://LOGIN:SCHLUESSEL@smtp-relay.brevo.com:587` (`@` im Login als `%40` schreiben). Fehlt er, stehen die Mails im Log |
| `MAIL_FROM` | im Betrieb | Absender, z. B. `Stempelei <hallo@deine-domain.de>`. Die Domain muss in Brevo bestätigt sein (SPF, DKIM, DMARC) |

## Aufbau

```
public/                Website: Startseite, Preise, Konto-Seiten, Dashboard, Rechtstexte, CSS, JS, Schriften
src/
  server.ts            Start und sauberes Herunterfahren
  app.ts               Fastify: Sicherheits-Header, /api/health, statische Dateien
  config.ts            Umgebungsvariablen prüfen
  routes/auth.ts       Konten: registrieren, bestätigen, anmelden, Passwort zurücksetzen
  auth/crypto.ts       Argon2id für Passwörter, Tokens und ihre Hashes
  mail.ts              Mail-Versand über SMTP (Brevo) oder ins Log
  mail-texts.ts        Texte der E-Mails auf Deutsch und Englisch
  db/schema.ts         Datenmodell (Drizzle)
  db/client.ts         Datenbankverbindung
  db/migrate.ts        Migrationen ausführen
  domain/stamps.ts     Stempel-Logik: geben, einlösen, neue Runde
  domain/codes.ts      Gast-Token und Kurzcodes
  domain/plans.ts      14 Tage Testphase
drizzle/               SQL-Migrationen
test/                  Tests mit node:test
```

## Seiten

| Adresse | Inhalt |
| --- | --- |
| `/` | Startseite für Betriebe |
| `/pricing` | Pakete und Preise |
| `/register`, `/login` | Konto anlegen, anmelden |
| `/verify`, `/forgot-password`, `/reset-password` | Links aus den E-Mails |
| `/dashboard` | Übersicht mit Checkliste der nächsten Schritte |
| `/dashboard/card`, `/dashboard/till`, `/dashboard/stats` | Karte gestalten, Team und Geräte, Statistik |
| `/till` | Kasse für das Team |
| `/c/<token>` | Karte des Gasts |
| `/imprint`, `/privacy` | Impressum und Datenschutz, nur auf Deutsch |

## Sprachen

Der deutsche Text steht direkt im HTML. Elemente mit `data-i18n="schlüssel"` bekommen auf Englisch ihren Text aus dem Wörterbuch in `public/assets/js/i18n.js`, `data-i18n-attr="aria-label:schlüssel"` übersetzt Attribute. Texte aus Skripten stehen als `I18N.t({ de, en })` direkt im Code. Die Wahl merkt sich der Browser, ohne Wahl gilt die Sprache des Browsers. E-Mails gehen in der Sprache der Seite raus, von der die Anfrage kommt, sonst in der bei der Registrierung gespeicherten.

Neue Seite oder neuer Text: deutschen Text ins HTML, Schlüssel per `data-i18n` dran, englischen Text unter demselben Schlüssel in `EN` eintragen.

## Apple und Google Wallet

Gäste können ihre Karte in Apple Wallet oder Google Wallet legen. Der Pass zeigt denselben QR-Code wie die Gast-Ansicht, die Kasse scannt ihn wie bisher. Nach jedem Stempel aktualisiert sich der Pass von selbst: Apple bekommt einen Push, Google ein PATCH.

Ohne Zugangsdaten ist Wallet aus und die Gast-Ansicht zeigt keine Knöpfe. Einrichten:

**Apple Wallet** (braucht das Apple Developer Program, 99 $ im Jahr)
1. Im Apple-Entwicklerportal unter Identifiers eine Pass Type ID anlegen, z. B. `pass.de.deine-domain.stempelkarte`.
2. Dazu ein Pass-Type-ID-Zertifikat erstellen, als `.p12` exportieren und in PEM umwandeln:
   `openssl pkcs12 -in pass.p12 -clcerts -nokeys -out secrets/pass-cert.pem` und
   `openssl pkcs12 -in pass.p12 -nocerts -out secrets/pass-key.pem`
3. Das Apple-WWDR-Zwischenzertifikat (G4) laden und als `secrets/wwdr.pem` ablegen.
4. `APPLE_*` und `WALLET_SECRET` in `.env` eintragen. Dasselbe Zertifikat dient auch für die Pushes an APNs.
5. Die Updates laufen über `<PUBLIC_URL>/wallet/apple`. Das iPhone muss diese Adresse erreichen, also HTTPS und öffentlich (im Tailnet nur für Geräte mit Tailscale).

**Google Wallet** (kostenlos)
1. In der Google Pay & Wallet Console ein Issuer-Konto anlegen, Issuer-ID notieren.
2. In der Google Cloud ein Projekt mit der Google Wallet API anlegen, ein Dienstkonto erstellen, JSON-Schlüssel als `secrets/google-wallet.json` ablegen und das Dienstkonto in der Wallet Console als Nutzer hinzufügen.
3. `GOOGLE_WALLET_ISSUER_ID` und `GOOGLE_WALLET_KEY_FILE` in `.env` eintragen.
4. Neue Konten sind im Demo-Modus: Nur Testkonten können Karten speichern („[TEST ONLY]“). Für alle Gäste in der Console „Publishing access“ beantragen.
5. Google lädt das Logo von `<PUBLIC_URL>/assets/wallet/logo-google.png`, die Adresse muss öffentlich sein.

**Offizielle Knöpfe:** Apple und Google erlauben nur ihre eigenen Grafiken, unverändert. Sie liegen nicht im Repo, sondern werden einmal geladen und abgelegt:
- `public/assets/wallet/badges/de/apple.svg` und `.../en/apple.svg` von https://developer.apple.com/wallet/add-to-apple-wallet-guidelines/
- `public/assets/wallet/badges/de/google.svg` und `.../en/google.svg` von https://developers.google.com/wallet/retail/loyalty-cards/resources/brand-guidelines

Ein Knopf erscheint nur, wenn Zugangsdaten und Grafiken da sind. Die Bilder im Pass (Stern-Logo) erzeugt `node tools/wallet-images.mjs`.

## Gestaltung

Die Website folgt dem Design-Skill [Hallmark](https://github.com/Nutlope/hallmark), Theme Coral: warmes Papier, Bedienelemente als Prägekarten, Koralle nur für eingelöste Prämien. Die Entscheidungen stehen als Kommentar oben in `public/assets/css/style.css`, das Log in `.hallmark/log.json`. Farben, Abstände und Schriftgrößen kommen ausschließlich aus `tokens.css`.

## Lizenzen der eingebundenen Dateien

- Schriften Hanken Grotesk und Geist Mono: SIL Open Font License (`public/assets/fonts/`)

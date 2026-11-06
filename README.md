# Stempelei

Digitale Stempelkarten für Restaurants, Cafés und Läden. Gäste sammeln Stempel auf dem Handy, Betriebe stempeln an der Kasse per QR-Scan.

Stand: Phase 1 des Backends ist fertig. Betriebe können sich registrieren, ihre E-Mail bestätigen, sich anmelden und ihr Passwort zurücksetzen. Die Kasse auf der Startseite ist noch die Demo mit Speicherung im Browser. Den Plan findest du in [`docs/BACKEND-PLAN.md`](docs/BACKEND-PLAN.md).

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
| `npm run build:single` | Baut die Demo als einzelne HTML-Datei nach `dist/` |

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
public/                Website: index.html (Demo), Konto-Seiten (registrieren.html, anmelden.html, …), CSS, JS, Schriften, QR-Bibliotheken
src/
  server.ts            Start und sauberes Herunterfahren
  app.ts               Fastify: Sicherheits-Header, /api/health, statische Dateien
  config.ts            Umgebungsvariablen prüfen
  routes/auth.ts       Konten: registrieren, bestätigen, anmelden, Passwort zurücksetzen
  auth/crypto.ts       Argon2id für Passwörter, Tokens und ihre Hashes
  mail.ts              Mail-Versand über SMTP (Brevo) oder ins Log
  db/schema.ts         Datenmodell (Drizzle)
  db/client.ts         Datenbankverbindung
  db/migrate.ts        Migrationen ausführen
  domain/stamps.ts     Stempel-Logik: geben, einlösen, neue Runde
  domain/codes.ts      Gast-Token und Kurzcodes
  domain/plans.ts      14 Tage Testphase
drizzle/               SQL-Migrationen
test/                  Tests mit node:test
tools/build-single.mjs Ein-Datei-Version der Demo
```

## Gestaltung

Die Website folgt dem Design-Skill [Hallmark](https://github.com/Nutlope/hallmark), Theme Coral: warmes Papier, Bedienelemente als Prägekarten, Koralle nur für eingelöste Prämien. Die Entscheidungen stehen als Kommentar oben in `public/assets/css/style.css`, das Log in `.hallmark/log.json`. Farben, Abstände und Schriftgrößen kommen ausschließlich aus `tokens.css`.

## Lizenzen der eingebundenen Dateien

- Schriften Hanken Grotesk und Geist Mono: SIL Open Font License (`public/assets/fonts/`)
- qrcode-generator: MIT, jsQR: Apache-2.0 (`public/assets/vendor/`)

# Stempelei – Plan für das Backend

Stand: 6. November 2026. Baut auf der Demo-Website v4 auf (PR #1).

## Ziel

Aus der Demo wird ein Produkt, das ein echter Betrieb nutzen kann:

- Ein Betrieb registriert sich, bezahlt sein Paket und richtet seine Karte ein.
- Das Team stempelt an der Kasse auf einem eigenen Gerät mit persönlicher PIN.
- Jeder Gast hat eine eigene Karte unter einem eigenen Link, auf jedem Gerät gleich.
- Alles läuft in der EU, Gäste geben keine personenbezogenen Daten an.

Nicht Teil der ersten Version: Apple/Google Wallet, Wochenauswertung (Groß), Kassensystem-Anbindung.

## Entscheidungen

| Thema | Vorschlag | Warum |
| --- | --- | --- |
| Sprache | TypeScript auf Node.js 22 | Eine Sprache für Server und Browser, die Stempel-Logik aus `app.js` wird geteilt |
| Server | Fastify | Schnell, eingebaute Schema-Validierung, wenig Magie |
| Datenbank | PostgreSQL 17 | Transaktionen und Zeilensperren für sicheres Stempeln |
| Datenbankzugriff | Drizzle ORM mit SQL-Migrationen | Typsicher, SQL bleibt lesbar |
| Frontend | Die jetzige Oberfläche, ohne Framework | Funktioniert schon, nur `localStorage` wird durch API-Aufrufe ersetzt |
| Hosting | Server in Deutschland (z. B. Hetzner), Docker Compose, Caddy für HTTPS | Günstig, DSGVO-freundlich, einfach zu betreiben |
| Bezahlung | **Stripe Billing** (entschieden) | Abos, Rechnungen, SEPA und Kundenportal fertig vorhanden |
| Testphase | **14 Tage kostenlos** (entschieden) | `TRIAL_DAYS` in `src/domain/plans.ts` |
| E-Mail | **Brevo** über SMTP (entschieden) | EU-Firma mit AVV, kostenlos bis 300 Mails am Tag, reicht lange für Bestätigung und Passwort-Reset. SMTP hält den Wechsel zu einem anderen Anbieter einfach |

Domain: vorhanden, wird über `PUBLIC_URL` eingetragen.
Noch offen: Hosting-Anbieter.

Abweichungen bei der Umsetzung von Phase 0:

- Tests laufen mit dem eingebauten Test-Runner von Node (`node:test`) statt vitest. Die sicheren vitest-Versionen ließen sich mit npm 10 nicht installieren, und `node:test` braucht keine zusätzliche Abhängigkeit.
- Lint und Format mit Biome.

Umsetzung von Phase 1:

- Konten-Routen in `src/routes/auth.ts`, Seiten `/registrieren`, `/anmelden`, `/bestaetigen`, `/passwort-vergessen`, `/passwort-neu`, `/konto` mit `public/assets/js/konto.js`.
- Links aus E-Mails tragen das Token hinter `#`, damit es nicht in Server- oder Proxy-Logs landet. Die Tabelle `email_tokens` speichert nur den Hash, jeder Link gilt einmal (Bestätigung 48 Stunden, Passwort 1 Stunde).
- Login erst nach bestätigter E-Mail. Registrieren, Login und Passwort-Reset verraten nicht, ob es eine Adresse schon gibt.
- Ein neues Passwort beendet alle Sitzungen des Kontos.
- Ratenbegrenzung mit `@fastify/rate-limit` im Speicher des Prozesses. Reicht für eine Instanz, bei mehreren auf Redis umstellen.
- Ohne `SMTP_URL` (nur Entwicklung) stehen die Mails mit ihren Links im Log.

## Rollen und Anmeldung

| Wer | Wie meldet er sich an | Was darf er |
| --- | --- | --- |
| Inhaber | E-Mail und Passwort, E-Mail bestätigt | Alles: Karte, Team, Standorte, Geräte, Abo |
| Kassengerät | Wird vom Inhaber einmal freigeschaltet, bekommt ein langes Geräte-Token im Cookie | Nur die Kasse öffnen |
| Team-Mitglied | Persönliche PIN (4–6 Ziffern) auf einem freigeschalteten Gerät | Stempeln, einlösen, rückgängig |
| Gast | Kein Konto. Wer den Link kennt, sieht die Karte | Nur die eigene Karte ansehen |

Warum Geräte-Freischaltung: Eine vierstellige PIN allein wäre aus dem Internet zu erraten. Nur in Kombination mit einem freigeschalteten Gerät reicht sie. Pro Gerät gibt es nach 5 falschen PINs eine Sperre von 5 Minuten.

## Datenmodell

```
businesses      id, name, slug, plan, subscription_status, trial_ends_at,
                stripe_customer_id, created_at, deleted_at
users           id, business_id, email, password_hash, email_verified_at, created_at
sessions        id_hash, user_id, expires_at, created_at
locations       id, business_id, name, address, archived_at
programs        id, business_id, name, earn_rule, ink, archived_at        -- „Stempelkarte“ im Paket
rewards         id, program_id, threshold, text, archived_at
staff           id, business_id, name, pin_hash, failed_attempts, locked_until, archived_at
devices         id, business_id, location_id, name, token_hash, last_seen_at, revoked_at
cards           id, program_id, public_token, short_code, stamps, cycle,
                claimed_reward_ids, created_at, last_activity_at
events          id, card_id, type, amount, reward_id, staff_id, device_id, location_id,
                prev_state, undone_by_event_id, idempotency_key, created_at
```

Regeln:

- **`events` ist das Protokoll und wird nie geändert,** nur ergänzt. `cards.stamps` und `cards.claimed_reward_ids` sind der aktuelle Stand und werden in derselben Transaktion mitgeschrieben.
- **`public_token`** ist zufällig (128 Bit, Base62, 22 Zeichen) und steht im Gast-Link. Erraten ist praktisch unmöglich.
- **`short_code`** ist ein Code mit 6 Zeichen ohne verwechselbare Zeichen (z. B. `K7M2QX`), eindeutig pro Betrieb. Er dient zum Abtippen an der Kasse.
- **Tokens für Sessions und Geräte** werden nur gehasht gespeichert.
- **Prämien werden nicht gelöscht, sondern archiviert,** damit alte Einlösungen lesbar bleiben.
- Jede Tabelle mit Betriebsdaten hängt an `business_id`. Jede Abfrage filtert danach, damit ein Betrieb nie Karten eines anderen sieht.

## Abläufe

### Neue Karte für einen Gast

1. Kasse: „Neue Karte ausgeben“ legt eine Karte an und zeigt einen QR-Code mit `https://<domain>/k/<public_token>`.
2. Der Gast scannt ihn mit seiner Handykamera, die Karte öffnet sich im Browser.
3. Die Seite bietet „Zum Startbildschirm hinzufügen“ an.

Später als Ergänzung: Ein QR-Aufsteller am Tresen erstellt per Scan selbst eine Karte. Dafür braucht es eine Begrenzung pro IP-Adresse, außerdem werden leere Karten nach 30 Tagen ohne Stempel gelöscht.

### Stempeln

1. Die Kasse scannt den QR-Code und liest das Token aus der URL. Alternativ tippt das Team den `short_code` ein.
2. `GET /api/kasse/cards/:token` prüft, ob die Karte zu diesem Betrieb gehört. Gehört sie zu einem anderen: „Diese Karte gehört zu einem anderen Betrieb.“
3. `POST /api/kasse/cards/:id/stamps` mit `{ amount, idempotencyKey }`
   - Transaktion mit `SELECT … FOR UPDATE` auf die Karte, damit zwei Kassen nicht gleichzeitig schreiben
   - Der `idempotencyKey` (UUID aus dem Browser) verhindert doppelte Stempel bei Doppeltipp oder Netzfehler
   - Höchstens bis zur Kartenlänge. Mehr als 3 Stempel in 10 Minuten auf derselben Karte zeigen eine Warnung, die das Team bestätigen muss.
4. Die Gast-Ansicht bekommt die Änderung live per Server-Sent Events.

### Einlösen und Rückgängig

- Einlösen: wie in der Demo, nur serverseitig. Sind alle Prämien eingelöst, steigt `cycle` um 1 und die Karte startet von vorn.
- Rückgängig: stellt `prev_state` des letzten nicht rückgängig gemachten Ereignisses wieder her und schreibt ein `undo`-Ereignis. Erlaubt nur innerhalb von 24 Stunden und nur auf dem Gerät, auf dem die Aktion passiert ist. Der Inhaber darf immer.

### Karte ändern

Ändert der Betrieb Prämien, bleiben die Stempelstände erhalten. Stempel über der neuen Kartenlänge bleiben stehen, bis der Gast einlöst. So verliert niemand etwas.

## API

Alle Antworten sind JSON, alle Eingaben werden per Schema geprüft.

```
Öffentlich
  POST /api/auth/register            Betrieb und Inhaber anlegen
  POST /api/auth/verify              E-Mail bestätigen
  POST /api/auth/verify/resend       Bestätigungslink neu senden
  POST /api/auth/login | logout
  POST /api/auth/password-reset/request | confirm   Link anfordern / neues Passwort setzen
  GET  /api/auth/me                  Angemeldetes Konto mit Betrieb
  GET  /api/public/cards/:token      Karte für die Gast-Ansicht (ohne interne IDs)
  GET  /api/public/cards/:token/live Server-Sent Events

Inhaber (Session-Cookie)
  GET/PATCH  /api/business
  CRUD       /api/programs, /api/programs/:id/rewards
  CRUD       /api/locations, /api/staff
  POST       /api/devices/pair        Gerät freischalten
  DELETE     /api/devices/:id         Gerät sperren
  POST       /api/billing/checkout    Stripe Checkout starten
  POST       /api/billing/portal      Stripe Kundenportal öffnen
  GET        /api/stats               Tageszahlen, später Wochenauswertung

Kasse (Geräte-Cookie + PIN-Session für 15 Minuten)
  POST /api/kasse/pin
  GET  /api/kasse/cards/:tokenOrCode
  POST /api/kasse/cards                     neue Karte
  POST /api/kasse/cards/:id/stamps
  POST /api/kasse/cards/:id/redeem          { rewardId }
  POST /api/kasse/cards/:id/undo
  GET  /api/kasse/log?date=heute

Stripe
  POST /api/webhooks/stripe          Signatur wird geprüft
```

## Seiten im Frontend

| Pfad | Inhalt | Herkunft |
| --- | --- | --- |
| `/`, `/preise`, `/impressum`, `/datenschutz` | Statische Seiten | aus der Demo übernommen |
| `/demo` | Die jetzige Demo mit `localStorage` | unverändert |
| `/registrieren`, `/anmelden` | Konto anlegen, anmelden | neu |
| `/konto` | Karte einrichten, Team, Standorte, Geräte, Abo | „Karte einrichten“ aus der Demo plus neue Bereiche |
| `/kasse` | PIN, Scannen, Stempeln, Verlauf | Kasse aus der Demo |
| `/k/:token` | Gast-Ansicht | Gast-Ansicht aus der Demo |

## Pakete durchsetzen

| Grenze | Klein | Mittel | Groß |
| --- | --- | --- | --- |
| Standorte | 1 | 3 | 10 |
| Stempelkarten (`programs`) | 1 | 3 | unbegrenzt |
| Team-Mitglieder (`staff`) | 3 | 10 | unbegrenzt |

- Die Grenzen werden beim Anlegen geprüft. Die Meldung nennt das passende größere Paket.
- Abo-Status kommt nur aus Stripe-Webhooks: `trialing` und `active` dürfen alles.
- Bei `past_due` gibt es 7 Tage Kulanz mit Hinweis im Konto. Danach ist die Kasse gesperrt, Gäste sehen ihre Karten aber weiter.
- Bei `canceled` wird die Kasse gesperrt, die Daten werden nach 30 Tagen gelöscht.

## Sicherheit

- HTTPS überall. Cookies sind `HttpOnly`, `Secure` und `SameSite=Lax`.
- Bei jeder schreibenden Anfrage wird der `Origin`-Header geprüft (Schutz gegen CSRF).
- Passwörter und PINs werden mit Argon2id gehasht.
- Ratenbegrenzung: Login 10/15 min pro IP und E-Mail, PIN 5/5 min pro Gerät, Gast-Abruf 60/min pro IP.
- Content-Security-Policy nur `self`, keine fremden Skripte. Die Seite ist darauf schon vorbereitet.
- Gast-API liefert keine internen IDs und keine Daten anderer Karten.
- Abhängigkeiten werden automatisch auf Sicherheitslücken geprüft (`npm audit` in CI, Dependabot).

## Datenschutz und Betrieb

- Gäste: Gespeichert werden nur Token, Stempel und Zeitpunkte, keine Namen, keine E-Mail-Adressen, keine IP-Adressen an der Karte.
- Logfiles: IP-Adressen werden nach 7 Tagen gelöscht.
- Löschfristen als nächtlicher Job:
  - leere Karten nach 30 Tagen
  - Karten ohne Aktivität nach 24 Monaten
  - Betriebe 30 Tage nach Kündigung
- Dokumente:
  - Vertrag zur Auftragsverarbeitung (AVV) wird beim Abschluss bestätigt
  - TOM-Beschreibung
  - Verzeichnis der Verarbeitungstätigkeiten
  - Datenschutzerklärung mit den echten Anbietern aktualisieren
- Backups: nächtlich verschlüsselt auf einen zweiten Speicher in der EU, 14 Tage aufbewahrt, Wiederherstellung einmal im Monat testen.
- Monitoring: Erreichbarkeits-Check von außen, Fehler-Logging ohne personenbezogene Daten.

## Projektstruktur

```
public/              Statische Seiten und Assets (aus der Demo)
drizzle/             SQL-Migrationen (erzeugt mit npm run db:generate)
src/
  server.ts          Fastify-Start
  routes/            auth, business, programs, kasse, public, billing, webhooks
  domain/stamps.ts   Stempel-Logik (geben, einlösen, rückgängig), ohne Datenbank, gut testbar
  db/schema.ts       Drizzle-Schema
  db/migrations/
  jobs/              Löschfristen, Backups
test/                Unit- und Integrationstests
e2e/                 Playwright: Registrierung → Karte → Stempeln → Einlösen
docker-compose.yml   app, postgres, caddy
```

## Reihenfolge

Jede Phase endet mit etwas, das man ausprobieren kann.

| Phase | Inhalt | Fertig, wenn |
| --- | --- | --- |
| 0. Grundgerüst ✓ | Projektstruktur, Docker Compose, Migrationen, CI (Typen, Lint, Tests) | `docker compose up` startet App und Datenbank, CI ist grün |
| 1. Konten ✓ | Registrieren, E-Mail bestätigen, Login, Passwort-Reset | Ein Betrieb kann sich anlegen und anmelden |
| 2. Karte einrichten | Programme und Prämien, Seite `/konto` | Die Einstellungen landen in der Datenbank |
| 3. Gast-Karten | Karte ausgeben, `/k/:token`, QR mit Link, Live-Updates | Ein Gast öffnet seine Karte auf dem eigenen Handy |
| 4. Kasse | Geräte freischalten, Team-PINs, Scannen, Stempeln, Einlösen, Rückgängig, Verlauf | Zwei Geräte stempeln gleichzeitig ohne Fehler |
| 5. Bezahlung | Stripe Checkout, Webhooks, Kundenportal, Paketgrenzen | Testzahlung schaltet das Paket frei, Kündigung sperrt die Kasse |
| 6. Start vorbereiten | Backups, Monitoring, Löschjobs, Rechtstexte, AVV, Lasttest | Wiederherstellung aus Backup klappt, Rechtstexte geprüft |
| 7. Testphase | 2–3 echte Betriebe, Rückmeldungen einarbeiten | Eine Woche ohne kritische Fehler im Echtbetrieb |

Danach: Wochenauswertung für Groß, QR-Aufsteller zur Selbstanmeldung, Karte als PWA mit Symbol, Apple/Google Wallet.

## Tests

- **Unit:** `domain/stamps.ts` mit allen Randfällen
  - volle Karte
  - mehrere freie Prämien
  - Neustart nach der letzten Prämie
  - Rückgängig nach Neustart
  - geänderte Prämien
- **Integration:** jede Route gegen eine echte PostgreSQL-Datenbank im Test-Container
  - inklusive „Betrieb A sieht keine Karten von Betrieb B“
  - inklusive gleichzeitiger Stempel auf dieselbe Karte
- **E2E:** Playwright für den ganzen Weg vom Registrieren bis zum Einlösen
- **Stripe:** Webhooks lokal mit der Stripe CLI testen

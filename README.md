# Stempelei

Demo-Website für digitale Stempelkarten. Gäste sammeln Stempel auf dem Handy, Betriebe stempeln an der Kasse per QR-Scan.

## Seiten

| Adresse | Inhalt |
| --- | --- |
| `#start` | Startseite mit Probier-Karte, Ablauf, Branchen, Pakete, Fragen |
| `#preise` | Pakete Klein (29 €), Mittel (59 €), Groß (99 €) mit Vergleich |
| `#kasse` | Bereich für Betriebe (Demo-Code `1234`): Stempeln, Karte einrichten, Verlauf |
| `#karte-0427` | Gast-Ansicht einer Karte |
| `#impressum`, `#datenschutz` | Rechtstexte (Entwurf, markierte Stellen ausfüllen) |

## Starten

Die Seite braucht keinen Build. Für die Kamera braucht der Browser HTTPS oder `localhost`:

```sh
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Eine einzelne Datei bauen

```sh
node tools/build-single.mjs              # dist/stempelei.html, alles eingebettet
node tools/build-single.mjs --fragment   # ohne <html>/<head>/<body>, für Claude-Artefakte
```

## Aufbau

```
index.html             Markup aller Ansichten
assets/css/style.css   Gestaltung, Schriften per @font-face
assets/js/app.js       Logik der Demo
assets/fonts/          Bricolage Grotesque, DM Sans, DM Mono (SIL OFL)
assets/vendor/         qrcode-generator 1.4.4 (MIT), jsQR 1.4.0 (Apache-2.0)
tools/build-single.mjs Build der Ein-Datei-Version
```

Die Seite lädt nichts von fremden Servern.

## Grenzen der Demo

Alle Daten liegen im `localStorage` des Browsers. Für den echten Betrieb fehlen:

- Server und Datenbank, damit jede Karte auf jedem Gerät gleich aussieht
- Konten für Betriebe mit Bezahlung und eigenen Codes pro Teammitglied
- echte Gast-Links statt `stempelei:XXXX` im QR-Code
- Vertrag zur Auftragsverarbeitung mit jedem Betrieb

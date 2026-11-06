# Stempelei – Plan für Version 4

## Ziel

Eine übersichtliche Demo-Website für digitale Stempelkarten. Betriebe sehen in
wenigen Sekunden, was sie bekommen, was es kostet und wie die Kasse funktioniert.
Gäste sehen nur ihre Karte.

## Probleme der Version 3

| Problem | Lösung |
| --- | --- |
| Stempeln gab es doppelt: „Tresen“ auf der Startseite und „Kasse“ | Startseite hat nur noch eine kleine Probier-Karte. Stempeln und Einrichten passiert in der Kasse. |
| Karte einrichten lag auf der Startseite | Eigener Tab „Karte einrichten“ in der Kasse, mit Live-Vorschau |
| Datenschutzerklärung sagt „Schriften vom eigenen Server“, die Seite lud aber Google Fonts und jsDelivr | Schriften und Bibliotheken liegen jetzt im Projekt unter `assets/` |
| Kasse konnte nur Fotos lesen | Live-Scan mit der Kamera, Foto und Nummer bleiben als Ausweg |
| „Zurücknehmen“ zog nur einen Stempel ab, nach einer Einlösung entstand ein falscher Stand | Echtes Rückgängig: Jede Aktion speichert den Stand davor |
| Gäste-Ansicht gab es nicht als eigene Seite | `#karte-0427` zeigt die Karte so, wie der Gast sie sieht, und aktualisiert sich live |
| Neue Gäste konnten keine Karte bekommen | „Neue Karte ausgeben“ in der Kasse |
| Mehrere freie Prämien: nur die erste war einlösbar | Jede freie Prämie hat einen eigenen Knopf |

## Seiten

1. **Start** (`#start`): Nutzen, Probier-Karte, Ablauf in drei Schritten, was der Betrieb einstellt, Branchen, Pakete kurz, Fragen.
2. **Preise** (`#preise`): Klein 29 €, Mittel 59 €, Groß 99 €, Vergleichstabelle, Rechnung pro Tag, Begriffe erklärt.
3. **Kasse** (`#kasse`): Anmeldung mit Zugangscode (Demo: 1234), dann drei Tabs:
   - Stempeln: Kamera, Foto, Nummer; Stempel vergeben, Prämie einlösen, Rückgängig, neue Karte
   - Karte einrichten: Vorlage, Name, Stempelregel, bis zu 5 Prämien, Farbe
   - Verlauf: Zahlen von heute, Protokoll, Demo-Codes, Demo zurücksetzen
4. **Gast-Ansicht** (`#karte-XXXX`)
5. **Impressum** (`#impressum`) und **Datenschutz** (`#datenschutz`), passend zur Technik

## Technik

- `index.html`, `assets/css/style.css`, `assets/js/app.js`: die Website, ohne Build lauffähig
- `assets/vendor/`: qrcode-generator 1.4.4 (MIT), jsQR 1.4.0 (Apache-2.0)
- `assets/fonts/`: Bricolage Grotesque, DM Sans, DM Mono (SIL OFL)
- `tools/build-single.mjs`: baut `dist/stempelei.html`, eine einzelne Datei mit allem eingebettet
- Daten liegen in der Demo nur im `localStorage` des Browsers

## Prüfung

- Alle Seiten auf Desktop und Handy, hell und dunkel
- Ablauf: anmelden, Karte öffnen, stempeln bis zur Prämie, einlösen, rückgängig, neue Karte, Einstellungen ändern
- QR-Code einer Karte aus einem Foto lesen
- Keine Anfragen an fremde Server

// Sprachwahl Deutsch/Englisch. Der deutsche Text steht im HTML, hier liegt nur das Englische.
// Elemente mit data-i18n bekommen ihren Text aus EN, data-i18n-attr="name:key" setzt Attribute.
// Elemente mit data-lang-only="en" sind nur auf Englisch sichtbar.
(() => {
  'use strict';

  const EN = {
    "auth.anmelden": "Log in",
    "auth.bestaetigungslink-neu-senden": "Send confirmation link again",
    "auth.e-mail-adresse": "Email address",
    "auth.e-mail-bestaetigen": "Confirm email",
    "auth.einen-moment-wir-pruefen-deinen-link": "One moment, we are checking your link …",
    "auth.gib-deine-e-mail-adresse-ein-wir-schicke": "Enter your email address. We will send you a link to set a new password.",
    "auth.konto-anlegen": "Create account",
    "auth.leg-deinen-betrieb-an-die-ersten-14-tage": "Set up your business. The first 14 days are free, then you choose a package.",
    "auth.link-senden": "Send link",
    "auth.mindestens-10-zeichen": "At least 10 characters.",
    "auth.name-des-betriebs": "Business name",
    "auth.neues-passwort": "New password",
    "auth.noch-kein-konto": "No account yet?",
    "auth.passwort": "Password",
    "auth.passwort-speichern": "Save password",
    "auth.passwort-vergessen": "Forgot your password?",
    "auth.passwort-vergessen-2": "Forgot password",
    "auth.schon-ein-konto": "Already have an account?",
    "auth.zur-anmeldung": "Go to login",
    "auth.zur-uebersicht": "Go to overview",
    "auth.zurueck-zur-anmeldung": "Back to login",
    "cardedit.aria-label-deine-stempelkarten": "Your stamp cards",
    "cardedit.bis-zu-5-praemien-hoechstens-20-stempel": "Up to 5 rewards, at most 20 stamps. The highest number sets the length of the card.",
    "cardedit.einen-stempel-gibt-es-fuer": "One stamp for …",
    "cardedit.karte-speichern": "Save card",
    "cardedit.name-auf-der-karte": "Name on the card",
    "cardedit.placeholder-jeden-besuch-ab-10": "every visit over €10",
    "cardedit.praemie": "Reward",
    "cardedit.praemie-2": "+ Reward",
    "cardedit.praemien": "Rewards",
    "cardedit.so-sehen-deine-gaeste-ihre-karte-aenderu": "This is how your guests see their card. Changes apply to all cards right away, collected stamps are kept.",
    "cardedit.stempel": "Stamps",
    "cardedit.stempelfarbe": "Stamp colour",
    "cardedit.stempelkarte-gestalten": "Design your stamp card",
    "cardedit.vorlage-als-startpunkt": "Start from a template",
    "cardedit.vorschau-mit-3-stempeln": "Preview with 3 stamps",
    "cardedit.weiter-kasse-einrichten": "Next: set up your till",
    "cardedit.weitere-karte": "+ Another card",
    "cardedit.zur-uebersicht": "← Back to overview",
    "common.abmelden": "Log out",
    "common.anmelden": "Log in",
    "common.anmelden-stempelei": "Log in · Stempelei",
    "common.aria-label-hauptmenue": "Main menu",
    "common.aria-label-konto-menue": "Account menu",
    "common.aria-label-stempelei-zur-startseite": "Stempelei, to the home page",
    "common.aria-label-stempelei-zur-uebersicht": "Stempelei, to the overview",
    "common.datenschutz": "Privacy policy",
    "common.datenschutzerklaerung-stempelei": "Privacy policy · Stempelei",
    "common.deine-stempelkarte-stempelei": "Your stamp card · Stempelei",
    "common.desc-digitale-stempelkarten-fuer-restaur": "Digital stamp cards for restaurants, cafés and shops. Design your card, stamp with a QR code at the till.",
    "common.desc-pakete-ab-29-im-monat-14-tage-koste": "Packages from €29 a month, free 14-day trial.",
    "common.digitale-stempelkarte-von": "Digital stamp card by",
    "common.digitale-stempelkarten-fuer-betriebe-ste": "Digital stamp cards for businesses · Stempelei",
    "common.digitale-stempelkarten-fuer-restaurants": "Digital stamp cards for restaurants, cafés and shops.",
    "common.e-mail-bestaetigen-stempelei": "Confirm email · Stempelei",
    "common.impressum": "Imprint",
    "common.impressum-stempelei": "Imprint · Stempelei",
    "common.jedes-paket-14-tage-kostenlos-testen": "Try any package free for 14 days",
    "common.kasse": "Till",
    "common.kasse-einrichten-stempelei": "Set up your till · Stempelei",
    "common.konto-anlegen-stempelei": "Create account · Stempelei",
    "common.kostenlos-testen": "Start free trial",
    "common.neues-passwort-stempelei": "New password · Stempelei",
    "common.passwort-vergessen-stempelei": "Forgot password · Stempelei",
    "common.preise": "Pricing",
    "common.preise-stempelei": "Pricing · Stempelei",
    "common.start": "Home",
    "common.statistik": "Statistics",
    "common.statistik-stempelei": "Statistics · Stempelei",
    "common.stempelkarte": "Stamp card",
    "common.stempelkarte-gestalten-stempelei": "Design your stamp card · Stempelei",
    "common.uebersicht": "Overview",
    "common.uebersicht-stempelei": "Overview · Stempelei",
    "dash.betrieb": "Business",
    "dash.dein-gast-scannt-den-qr-code-an-der-kass": "Your guest scans the QR code at the till and has their card.",
    "dash.dein-konto": "Your account",
    "dash.deine-e-mail-adresse-ist-bestaetigt": "Your email address is confirmed.",
    "dash.deine-naechsten-schritte": "Your next steps",
    "dash.e-mail": "Email",
    "dash.erste-karte-ausgeben": "Hand out your first card",
    "dash.handy-oder-tablet-freischalten-und-deine": "Approve a phone or tablet and give your team PINs.",
    "dash.jetzt-einrichten": "Set up now",
    "dash.jetzt-gestalten": "Design now",
    "dash.kasse-einrichten": "Set up your till",
    "dash.kasse-oeffnen": "Open the till",
    "dash.konto-bestaetigen": "Confirm your account",
    "dash.name-stempelregel-praemien-und-stempelfa": "Set the name, stamp rule, rewards and stamp colour.",
    "dash.paket": "Package",
    "dash.paket-waehlen": "Choose a package",
    "dash.pakete-ansehen": "See packages",
    "dash.spaetestens-am-ende-der-testphase-damit": "At the latest by the end of the trial, so the till keeps working.",
    "dash.stempelkarte-gestalten": "Design your stamp card",
    "dash.willkommen": "Welcome,",
    "guest.alt-qr-code-deiner-karte": "QR code of your card",
    "guest.alt-zu-apple-wallet-hinzufuegen": "Add to Apple Wallet",
    "guest.alt-zu-google-wallet-hinzufuegen": "Add to Google Wallet",
    "guest.an-der-kasse-zeigen": "Show at the till",
    "guest.aria-label-code-fuer-die-kasse": "Code for the till",
    "guest.aria-label-karte-in-der-wallet-speichern": "Save the card to your wallet",
    "guest.die-karte-aktualisiert-sich-von-selbst-s": "The card updates by itself as soon as you get a stamp.",
    "guest.iphone-teilen-symbol-dann-zum-home-bilds": "iPhone: share icon, then “Add to Home Screen”. Android: three-dot menu, then “Add to Home screen”. The card belongs only to you, do not share the link.",
    "guest.karte-immer-dabeihaben": "Always have your card with you",
    "guest.klappt-das-scannen-nicht-nenn-diesen-cod": "If scanning does not work, tell them this code:",
    "home.10-besuche": "10 visits",
    "home.10-einkaeufe": "10 purchases",
    "home.10-stempel": "10 stamps",
    "home.12-kugeln": "12 scoops",
    "home.14-tage-kostenlos-keine-zahlungsdaten-no": "Free for 14 days. No payment details needed.",
    "home.5-stempel": "5 stamps",
    "home.6-termine": "6 appointments",
    "home.8-getraenke": "8 drinks",
    "home.aria-label-beispiel-einer-stempelkarte-m": "Example stamp card with 4 of 10 stamps",
    "home.baeckerei": "Bakery",
    "home.bald-in-apple-wallet-und-google-wallet": "Soon in Apple Wallet and Google Wallet",
    "home.becher-gratis": "Free sundae",
    "home.bereit-fuer-deine-erste-karte": "Ready for your first card?",
    "home.bis-espresso-aufs-haus": "until a free espresso.",
    "home.branche": "Business",
    "home.brotlaib-gratis": "Free loaf of bread",
    "home.caf": "Café",
    "home.dein-gast-scannt-einmal-einen-qr-code-an": "Your guest scans a QR code at the till once and has their card on their phone.",
    "home.deine-gaeste-sammeln-stempel-auf-dem-han": "Your guests collect stamps on their phone, your team stamps with a QR code. Set up in minutes, no technical skills needed.",
    "home.dessert-aufs-haus": "Free dessert",
    "home.die-karte-oeffnet-sich-im-browser-und-la": "The card opens in the browser and can be added to the home screen. Guests give neither a name nor an email.",
    "home.digitale-stempelkarten-fuer-deinen-betri": "Digital stamp cards for your business.",
    "home.du-verwaltest-alles-hier-deine-gaeste-se": "You manage everything here. Your guests only see their own card.",
    "home.du-waehlst-ein-paket-ab-29-im-monat-ohne": "You choose a package from €29 a month. Without one the till is locked, but your guests still see their cards.",
    "home.ein-handy-oder-tablet-mit-kamera-reicht": "A phone or tablet with a camera is enough. Every team member gets their own PIN.",
    "home.ein-handy-oder-tablet-mit-kamera-und-bro": "A phone or tablet with a camera and a browser. Nothing else.",
    "home.ein-paar-beispiele-als-startpunkt": "A few examples to start from.",
    "home.einen-stempel-gibt-es-fuer-jeden-besuch": "One stamp for every visit over €10.",
    "home.eisdiele": "Ice cream parlour",
    "home.espresso-aufs-haus": "Free espresso",
    "home.fragen-vor-dem-start": "Questions before you start",
    "home.friseur": "Hairdresser",
    "home.fuer-jeden-betrieb-mit-stammkundschaft": "For every business with regulars",
    "home.haarwaesche-gratis": "Free hair wash",
    "home.in-vier-schritten-startklar": "Ready in four steps",
    "home.jetzt-konto-anlegen": "Create your account now",
    "home.kaffee-gratis": "Free coffee",
    "home.karte": "Card",
    "home.karten-ausgeben": "Hand out cards",
    "home.kasse-einrichten": "Set up your till",
    "home.keine-app-kein-konto": "No app, no account",
    "home.koennen-gaeste-sich-selbst-stempeln": "Can guests stamp their own card?",
    "home.konto-anlegen": "Create an account",
    "home.kostenlos-testen": "Start free trial",
    "home.leg-dein-konto-an-und-richte-deine-stemp": "Create your account and set up your stamp card. The first 14 days are free.",
    "home.lege-fest-wofuer-es-stempel-gibt-welche": "Decide what earns a stamp, which rewards there are and the colour of the stamps.",
    "home.name-deines-betriebs-e-mail-adresse-und": "Your business name, email address and password. The trial starts right away.",
    "home.nein-stempel-vergibt-nur-dein-team-auf-f": "No. Only your team gives stamps, on approved devices with a personal PIN.",
    "home.noch-1-stempel": "1 more stamp",
    "home.preise-ansehen": "See pricing",
    "home.restaurant": "Restaurant",
    "home.so-sieht-eine-karte-bei-deinen-gaesten-a": "This is what a card looks like for your guests. You choose the name, rewards and colour.",
    "home.sobald-dein-team-stempelt-erscheint-der": "As soon as your team stamps, the stamp appears on the guest’s phone.",
    "home.spaeter-koennen-gaeste-ihre-karte-mit-ei": "Later, guests can add their card to their wallet with one tap.",
    "home.stempel-in-echtzeit": "Stamps in real time",
    "home.stempelkarte-gestalten": "Design your stamp card",
    "home.stempelstand-und-eingeloeste-praemien-ke": "Stamp count and redeemed rewards. No names, no email addresses.",
    "home.typische-praemie": "Typical reward",
    "home.was-brauche-ich-an-der-kasse": "What do I need at the till?",
    "home.was-deine-gaeste-bekommen": "What your guests get",
    "home.was-passiert-nach-der-testphase": "What happens after the trial?",
    "home.welche-daten-speichert-eine-karte": "What data does a card store?",
    "legal.x": "This page is only available in German, as German law requires.",
    "pricing.0-97-pro-tag": "€0.97 per day",
    "pricing.1-97-pro-tag": "€1.97 per day",
    "pricing.1-standort": "1 location",
    "pricing.1-stempelkarte": "1 stamp card",
    "pricing.10-team-zugaenge": "10 team members",
    "pricing.29": "€29",
    "pricing.3-30-pro-tag": "€3.30 per day",
    "pricing.3-team-zugaenge": "3 team members",
    "pricing.59": "€59",
    "pricing.99": "€99",
    "pricing.alle-preise-pro-monat-und-betrieb": "All prices per month and business,",
    "pricing.aria-label-pakete": "Packages",
    "pricing.auswertung-pro-standort-und-woche": "Weekly report per location",
    "pricing.bis-zu-10-standorte": "Up to 10 locations",
    "pricing.bis-zu-3-standorte": "Up to 3 locations",
    "pricing.bis-zu-3-stempelkarten-etwa-mittag-und-a": "Up to 3 stamp cards, e.g. lunch and dinner",
    "pricing.die-ersten-14-tage-sind-kostenlos-danach": "The first 14 days are free, then monthly by card or SEPA via Stripe. Minimum term and notice period:",
    "pricing.die-laufzeit": "The term",
    "pricing.eigene-praemien-und-stempelregel": "Your own rewards and stamp rule",
    "pricing.ein-paket-fuer-jede-groesse": "A package for every size.",
    "pricing.ein-standort": "A location",
    "pricing.ein-team-zugang": "A team member",
    "pricing.eine-filiale-mit-eigener-adresse-stempel": "A branch with its own address. Stamps count in all locations.",
    "pricing.eine-kartenart-mit-eigener-regel-und-eig": "A card type with its own rule and rewards, e.g. a lunch card and a coffee card.",
    "pricing.eine-person-die-stempeln-darf-jede-bekom": "A person who may give stamps. Each gets their own PIN, so the log shows who stamped.",
    "pricing.eine-stempelkarte": "A stamp card",
    "pricing.fuer-betriebe-mit-mehreren-filialen-oder": "For businesses with several branches or offers.",
    "pricing.fuer-einen-laden-ein-caf-oder-ein-restau": "For one shop, café or restaurant.",
    "pricing.fuer-ketten-und-grosse-haeuser": "For chains and large venues.",
    "pricing.gaeste": "Guests",
    "pricing.gesetzlicher-umsatzsteuer-pro-tag-gerech": "statutory VAT. Per day calculated with 30 days.",
    "pricing.gross": "Large",
    "pricing.im-monat": "per month",
    "pricing.ja": "yes",
    "pricing.jedes-paket-14-tage-kostenlos-testen-dan": "Try any package free for 14 days, then pay monthly. You only choose a package at the end of the trial.",
    "pricing.kasse-mit-kamera-scanner": "Till with camera scanner",
    "pricing.klein": "Small",
    "pricing.kostenlos-testen": "Start free trial",
    "pricing.leistung": "Feature",
    "pricing.mittel": "Medium",
    "pricing.nein": "no",
    "pricing.standorte": "Locations",
    "pricing.stempelkarten": "Stamp cards",
    "pricing.team-zugaenge": "Team members",
    "pricing.unbegrenzt": "unlimited",
    "pricing.unbegrenzt-viele-gaeste": "Unlimited guests",
    "pricing.unbegrenzt-viele-stempelkarten": "Unlimited stamp cards",
    "pricing.unbegrenzt-viele-team-zugaenge": "Unlimited team members",
    "pricing.unter-1-am-tag": "under €1 a day",
    "pricing.was-die-pakete-zaehlen": "What the packages count",
    "pricing.was-jedes-paket-enthaelt": "What each package includes",
    "stats.12-monate": "12 months",
    "stats.30-tage": "30 days",
    "stats.90-tage": "90 days",
    "stats.90-tage-12-monate-und-csv-export-gibt-es": "90 days, 12 months and CSV export are included in the Large package.",
    "stats.aktiv-ist-eine-karte-mit-mindestens-eine": "A card is active with at least one stamp in the period. A visit is a day with a stamp, “came back” means on at least two days.",
    "stats.aktive-karten": "Active cards",
    "stats.als-csv-herunterladen": "Download as CSV",
    "stats.als-tabelle-anzeigen": "Show as table",
    "stats.aria-label-kennzahl": "Measure",
    "stats.aria-label-zeitraum": "Period",
    "stats.auf-einen-blick": "At a glance",
    "stats.besuche-pro-karte": "Visits per card",
    "stats.einloesungen": "Redemptions",
    "stats.kamen-wieder": "Came back",
    "stats.karten-kurz-vor-einer-praemie-ihnen-fehl": "Cards close to a reward: they need 2 stamps or fewer. Counted are cards with activity in the last 90 days.",
    "stats.kasse-oeffnen": "Open the till",
    "stats.neue-karten": "New cards",
    "stats.noch-keine-zahlen": "No numbers yet",
    "stats.praemien": "Rewards",
    "stats.praemien-eingeloest": "Rewards redeemed",
    "stats.sobald-an-deiner-kasse-gestempelt-wird-e": "As soon as your till gives stamps, the reports appear here.",
    "stats.stammgaeste": "Regulars",
    "stats.statistik": "Statistics",
    "stats.stempel": "Stamps",
    "stats.stempel-vergeben": "Stamps given",
    "stats.verlauf": "Over time",
    "stats.wie-oft-deine-gaeste-wiederkommen-und-wa": "How often your guests come back and what they redeem. Undone actions are not counted.",
    "stats.zur-uebersicht": "← Back to overview",
    "till.aktualisieren": "Refresh",
    "till.alt-qr-code-der-neuen-karte": "QR code of the new card",
    "till.anzahl-stempel": "Number of stamps",
    "till.aria-einen-mehr": "One stamp more",
    "till.aria-einen-weniger": "One stamp less",
    "till.aria-kamerabild": "Camera view",
    "till.aria-letzte-ziffer-loeschen": "Delete last digit",
    "till.aria-ziffernblock": "Keypad",
    "till.brand": "Stempelei · Till",
    "till.einen-moment": "One moment …",
    "till.gast-scannt-diesen-code": "The guest scans this code with their phone",
    "till.geraet-freischalten": "Pair device",
    "till.geraet-noch-nicht-freigeschaltet": "This device is not paired as a till yet. Ask the owner for a pairing code in Dashboard → Till.",
    "till.gib-deine-persoenliche-pin-ein": "Enter your personal PIN (4 to 6 digits).",
    "till.halte-den-qr-code-in-den-rahmen": "Hold the QR code of the guest card inside the frame. The card opens by itself.",
    "till.heute": "Today",
    "till.heute-im-betrieb": "Today at the business",
    "till.kamera-braucht-https": "The camera does not work here: it needs a secure connection (HTTPS) and a browser with camera access. Enter the short code instead.",
    "till.karte": "Card",
    "till.karte-finden": "Find a card",
    "till.karten-ausgegeben": "Cards issued",
    "till.kasse": "Till",
    "till.kasse-einrichten": "Set up the till",
    "till.kasse-gesperrt-testphase-vorbei": "The till is locked: the trial is over. The owner has to choose a package in the dashboard, then it works again.",
    "till.kopplungscode": "Pairing code (8 digits)",
    "till.kurzcode-der-karte": "Short code of the card",
    "till.name-des-geraets": "Device name",
    "till.neue-karte-ausgeben": "Issue new card",
    "till.oder": "or",
    "till.oeffnen": "Open",
    "till.ok": "OK",
    "till.pin": "PIN",
    "till.pin-eingeben": "Enter PIN",
    "till.placeholder-z-b-tresen": "e.g. Counter",
    "till.praemien-eingeloest": "Rewards redeemed",
    "till.rueckgaengig": "Undo",
    "till.scanne-eine-karte": "Scan the guest's card or enter its short code. New guests get a new card.",
    "till.scannen": "Scan",
    "till.schliessen": "Close",
    "till.so-hat-er-die-karte": "That way they always have the card with them. Short code:",
    "till.sperren": "Lock",
    "till.stempel-vergeben": "Stamps given",
    "till.stempelkarte": "Stamp card",
    "till.stopp": "Stop",
    "till.title": "Till · Stempelei",
    "till.verwaltung": "Admin",
    "tillset.dieses-geraet-als-kasse-nutzen": "Use this device as the till",
    "tillset.freischalt-code": "Approval code",
    "tillset.geraet-freischalten": "Approve a device",
    "tillset.geraete": "2. Devices",
    "tillset.geraete-help": "The till only runs on devices you approve here, for example a tablet at the counter. You block a lost device with one click.",
    "tillset.hinzufuegen": "Add",
    "tillset.kasse-einrichten": "Set up your till",
    "tillset.kasse-oeffnen": "3. Open the till",
    "tillset.kasse-oeffnen-help": "On an approved device your team logs in with their PIN and starts stamping.",
    "tillset.kasse-oeffnen-link": "Open the till",
    "tillset.lead": "Three steps to your till: add your team with PINs, approve a device and open the till on it.",
    "tillset.name": "Name",
    "tillset.person-hinzufuegen": "Add a person",
    "tillset.pin": "PIN (4 to 6 digits)",
    "tillset.team": "1. Team",
    "tillset.team-help": "Everyone gets their own PIN. They use it to log in at the till, and the till log shows who stamped.",
    "tillset.zur-uebersicht": "← Back to overview"
  };

  const STORE = 'stempelei.lang';
  const listeners = [];
  const original = new Map();
  const originalAttr = new Map();

  function initial() {
    try {
      const saved = localStorage.getItem(STORE);
      if (saved === 'de' || saved === 'en') return saved;
    } catch {}
    return /^de\b/i.test(navigator.language || 'de') ? 'de' : 'en';
  }

  let lang = initial();

  function apply() {
    document.documentElement.lang = lang;
    for (const node of document.querySelectorAll('[data-i18n]')) {
      if (!original.has(node)) original.set(node, node.innerHTML);
      const en = EN[node.dataset.i18n];
      node.innerHTML = lang === 'en' && en !== undefined ? en : original.get(node);
    }
    for (const node of document.querySelectorAll('[data-i18n-attr]')) {
      if (!originalAttr.has(node)) originalAttr.set(node, new Map());
      const saved = originalAttr.get(node);
      for (const pair of node.dataset.i18nAttr.split(',')) {
        const [name, key] = pair.split(':');
        if (!saved.has(name)) saved.set(name, node.getAttribute(name) ?? '');
        const en = EN[key];
        node.setAttribute(name, lang === 'en' && en !== undefined ? en : saved.get(name));
      }
    }
    for (const node of document.querySelectorAll('[data-lang-only]')) node.hidden = node.dataset.langOnly !== lang;
    for (const btn of document.querySelectorAll('[data-lang-switch]')) {
      const other = lang === 'de' ? 'en' : 'de';
      btn.textContent = other.toUpperCase();
      btn.lang = other;
      btn.setAttribute('aria-label', other === 'en' ? 'Switch to English' : 'Auf Deutsch umschalten');
    }
    for (const fn of listeners) fn(lang);
  }

  function set(next) {
    lang = next;
    try {
      localStorage.setItem(STORE, next);
    } catch {}
    apply();
  }

  // Menüpunkt der aktuellen Seite markieren
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === location.pathname) a.setAttribute('aria-current', 'page');
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-lang-switch]')) set(lang === 'de' ? 'en' : 'de');
  });

  window.I18N = {
    get lang() {
      return lang;
    },
    /** Text in der aktuellen Sprache: t({ de: '…', en: '…' }) */
    t: (texts) => texts[lang] ?? texts.de,
    onChange(fn) {
      listeners.push(fn);
    },
  };

  apply();
})();

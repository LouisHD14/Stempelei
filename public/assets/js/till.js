// Kasse unter /till: Gerät koppeln, PIN, Karte scannen oder ausgeben, stempeln, einlösen, Verlauf von heute.
// Der Server entscheidet alles (Gerät, Sitzung, Paket); diese Seite zeigt nur an und fragt nach.
// Texte des Betriebs und der Gäste werden nur als textContent gesetzt, nie als HTML.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (texts) => window.I18N.t(texts);
  const IDLE_MS = 15 * 60 * 1000; // wie die Sitzung auf dem Server
  const SCAN_MS = 150;
  const TOKEN = /^[0-9A-Za-z]{22}$/;
  const SHORT = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/; // SHORT_CODE_ALPHABET aus src/domain/codes.ts

  let state = null; // Antwort von GET /api/till/state
  let view = 'loading';
  let card = null; // TillCard, die gerade offen ist
  let freshFrom; // ab diesem Feld sind Stempel neu (Animation)
  let issued = null; // {url, qrUrl, shortCode} der gerade ausgegebenen Karte
  let log = null;
  let message = null; // {texts, kind}, damit die Meldung beim Sprachwechsel mitwechselt
  let busy = false;
  let retry = null; // {sig, key}: nach Netzfehler denselben idempotencyKey noch einmal senden
  let lastActivity = Date.now();
  let stream = null;
  let scanTimer = null;
  let lastBadScan = '';
  let pinUnlockTimer = null;

  const MSG = {
    offline: { de: 'Keine Verbindung. Prüf das Internet und versuch es noch einmal.', en: 'No connection. Check the internet and try again.' },
    failed: { de: 'Das hat nicht geklappt. Versuch es gleich noch einmal.', en: 'That did not work. Try again in a moment.' },
    rate_limited: { de: 'Zu viele Versuche. Warte ein paar Minuten.', en: 'Too many attempts. Wait a few minutes.' },
    invalid: { de: 'Bitte prüf die Eingabe.', en: 'Please check your input.' },
    invalid_code: { de: 'Der Kopplungscode stimmt nicht oder ist abgelaufen. Lass dir einen neuen geben.', en: 'The pairing code is wrong or has expired. Ask for a new one.' },
    device_required: { de: 'Dieses Gerät ist nicht (mehr) als Kasse freigeschaltet.', en: 'This device is not (or no longer) paired as a till.' },
    pin_required: { de: 'Die Kasse wurde gesperrt. Bitte PIN eingeben.', en: 'The till was locked. Please enter your PIN.' },
    subscription_required: { de: 'Die Kasse ist gesperrt, bis der Inhaber ein Paket wählt.', en: 'The till is locked until the owner chooses a package.' },
    not_found: { de: 'Keine Karte mit diesem Code gefunden.', en: 'No card found with this code.' },
    foreign_card: { de: 'Diese Karte gehört zu einem anderen Betrieb.', en: 'This card belongs to another business.' },
    card_full: { de: 'Die Karte ist voll. Erst die Prämie einlösen, dann weiter stempeln.', en: 'The card is full. Redeem the reward first, then add stamps.' },
    reward_not_available: { de: 'Diese Prämie ist auf der Karte nicht (mehr) frei.', en: 'This reward is not (or no longer) ready on this card.' },
    idempotency_conflict: { de: 'Diese Aktion wurde schon anders gebucht. Öffne die Karte neu.', en: 'This action was already booked differently. Open the card again.' },
    nothing_to_undo: { de: 'Nichts rückgängig zu machen. Das geht nur für Aktionen dieses Geräts aus den letzten 24 Stunden.', en: 'Nothing to undo. That only works for actions on this device from the last 24 hours.' },
    no_program: { de: 'Es gibt noch keine Stempelkarte. Der Inhaber legt sie im Dashboard an.', en: 'There is no stamp card yet. The owner sets it up in the dashboard.' },
    bad_scan: { de: 'Das ist kein Stempelei-Code. Scanne den QR-Code der Gast-Karte.', en: 'That is not a Stempelei code. Scan the QR code of the guest card.' },
    bad_code: { de: 'Der Kurzcode hat 6 Zeichen, zum Beispiel K7X2QP.', en: 'The short code has 6 characters, for example K7X2QP.' },
  };

  // ---------- Meldungen ----------

  function say(texts, kind) {
    message = texts ? { texts, kind } : null;
    renderMessage();
  }

  function renderMessage() {
    const flash = $('flash');
    flash.textContent = message ? t(message.texts) : '';
    flash.classList.toggle('err', message?.kind === 'err');
    flash.classList.toggle('ok', message?.kind === 'ok');
  }

  function time(iso) {
    // shortcut: Uhrzeit immer in Europe/Berlin wie der Tag in /api/till/log, bei Betrieben in anderen Zeitzonen die Zone vom Server liefern lassen
    return new Date(iso).toLocaleTimeString(window.I18N.lang === 'en' ? 'en-GB' : 'de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Berlin',
    });
  }

  // ---------- Server ----------

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch {
      return { ok: false, status: 0, data: {} };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  /** Fehler, die auf jeder Kassen-Anfrage kommen können. true, wenn erledigt. */
  function common(res) {
    const code = res.data.error;
    if (res.status === 0) {
      say(MSG.offline, 'err');
      return true;
    }
    if (code === 'device_required') {
      state = null;
      say(MSG.device_required, 'err');
      show('pair');
      return true;
    }
    if (code === 'pin_required') {
      if (state) state.session = null;
      say(MSG.pin_required, 'err');
      show('pin');
      return true;
    }
    if (code === 'subscription_required') {
      if (state) state.tillAllowed = false;
      renderLocked();
      say(MSG.subscription_required, 'err');
      return true;
    }
    if (res.status === 429) {
      say(MSG.rate_limited, 'err');
      return true;
    }
    return false;
  }

  /** Meldung zu einem Fehler aus dem Vertrag, sonst eine allgemeine. */
  function fail(res) {
    if (common(res)) return;
    const code = res.data.error;
    if (MSG[code]) return say(MSG[code], 'err');
    if (res.status === 400) return say(MSG.invalid, 'err');
    say(MSG.failed, 'err');
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // randomUUID gibt es nur über HTTPS; getRandomValues überall
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /** Schreibende Kartenaktion mit idempotencyKey. Nach einem Netzfehler nutzt derselbe Klick denselben Key. */
  async function mutate(path, payload) {
    const sig = path + JSON.stringify(payload);
    const key = retry && retry.sig === sig ? retry.key : uuid();
    const res = await api('POST', path, { ...payload, idempotencyKey: key });
    // Bei Netzfehler oder Serverfehler (z. B. 504 vom Proxy) kann die Aktion schon gebucht sein:
    // derselbe Klick schickt dann denselben Schlüssel, der Server antwortet mit dem ersten Ergebnis
    retry = res.status === 0 || res.status >= 500 ? { sig, key } : null;
    return res;
  }

  /** Sperrt Knöpfe, solange eine Anfrage läuft (gegen Doppeltipps). */
  async function work(fn) {
    if (busy) return;
    busy = true;
    renderCard();
    try {
      await fn();
    } finally {
      busy = false;
      renderCard();
    }
  }

  async function loadState() {
    const res = await api('GET', '/api/till/state');
    if (res.status === 401 && res.data.error === 'device_required') {
      state = null;
      return show('pair');
    }
    if (!res.ok) {
      fail(res);
      // Ohne Zustand gibt es nichts zu zeigen: beim Start von selbst noch einmal versuchen (z. B. WLAN noch nicht da)
      if (view === 'loading') setTimeout(loadState, 5000);
      return;
    }
    state = res.data;
    renderHeader();
    renderLocked();
    renderPrograms();
    show(state.session ? 'main' : 'pin');
  }

  // ---------- Ansichten ----------

  function show(next) {
    const before = view;
    view = next;
    if (next !== 'main') {
      stopScan();
      closeCard();
    }
    $('vLoading').hidden = next !== 'loading';
    $('vPair').hidden = next !== 'pair';
    $('vPin').hidden = next !== 'pin';
    $('vMain').hidden = next !== 'main';
    $('lock').hidden = next !== 'main';
    renderHeader();
    renderLocked();
    if (before === next) return;
    // Fokus auf den Anfang der neuen Ansicht, damit Tastatur und Screenreader mitkommen
    if (next === 'pair') ($('pairCode').value ? $('pairName') : $('pairCode')).focus();
    if (next === 'pin') {
      $('pin').value = '';
      $('pin').focus();
    }
    if (next === 'main') {
      lastActivity = Date.now();
      selectTab('card', false);
      $('h-main').focus();
    }
  }

  function renderHeader() {
    $('bizName').textContent = state?.business?.name ?? '';
    const s = state?.session;
    $('staffLine').textContent = s
      ? t({ de: `Angemeldet: ${s.staff.name} · Gerät: ${state.device.name}`, en: `Signed in: ${s.staff.name} · Device: ${state.device.name}` })
      : '';
  }

  function renderLocked() {
    $('tillLocked').hidden = !(state && state.tillAllowed === false && (view === 'pin' || view === 'main'));
  }

  function renderPrograms() {
    const programs = state?.programs ?? [];
    const select = $('program');
    const keep = select.value;
    select.replaceChildren(
      ...programs.map((p) => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        return o;
      }),
    );
    if (programs.some((p) => p.id === keep)) select.value = keep;
    $('programField').hidden = programs.length < 2;
  }

  // ---------- 1. Koppeln ----------

  function codeFromFragment() {
    const m = location.hash.match(/(?:^#|&)code=([0-9]{8})(?:&|$)/);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (m) $('pairCode').value = m[1];
  }

  $('pairForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('pairCode').value.replace(/\s+/g, '');
    const name = $('pairName').value.trim();
    $('pairCode').removeAttribute('aria-invalid');
    $('pairName').removeAttribute('aria-invalid');
    if (!/^[0-9]{8}$/.test(code)) {
      $('pairCode').setAttribute('aria-invalid', 'true');
      $('pairCode').focus();
      return say({ de: 'Der Kopplungscode hat 8 Ziffern.', en: 'The pairing code has 8 digits.' }, 'err');
    }
    if (!name || name.length > 40) {
      $('pairName').setAttribute('aria-invalid', 'true');
      $('pairName').focus();
      return say({ de: 'Gib dem Gerät einen Namen (bis 40 Zeichen), z. B. Tresen.', en: 'Give the device a name (up to 40 characters), e.g. Counter.' }, 'err');
    }
    $('pairBtn').disabled = true;
    const res = await api('POST', '/api/till/pair', { code, name });
    $('pairBtn').disabled = false;
    if (!res.ok) {
      if (res.data.error === 'invalid_code') $('pairCode').setAttribute('aria-invalid', 'true');
      return fail(res);
    }
    $('pairForm').reset();
    say({ de: `Gerät „${res.data.device.name}“ ist jetzt Kasse von ${res.data.business.name}.`, en: `Device “${res.data.device.name}” is now a till of ${res.data.business.name}.` }, 'ok');
    await loadState();
  });

  // ---------- 2. PIN ----------

  const pin = $('pin');

  function pinPad(disabled) {
    for (const b of document.querySelectorAll('.pinpad button')) b.disabled = disabled;
    pin.disabled = disabled;
  }

  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/[^0-9]/g, '').slice(0, 6);
  });

  document.querySelector('.pinpad').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.type === 'submit') return;
    if (btn.id === 'pinDel') pin.value = pin.value.slice(0, -1);
    else if (pin.value.length < 6) pin.value += btn.dataset.digit;
  });

  // Ziffern von einer echten Tastatur, auch wenn der Fokus auf einem Knopf des Ziffernblocks liegt
  document.addEventListener('keydown', (e) => {
    if (view !== 'pin' || pin.disabled || e.target === pin || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key) && pin.value.length < 6) {
      pin.value += e.key;
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      pin.value = pin.value.slice(0, -1);
      e.preventDefault();
    }
  });

  $('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = pin.value;
    if (!/^[0-9]{4,6}$/.test(value)) {
      pin.focus();
      return say({ de: 'Die PIN hat 4 bis 6 Ziffern.', en: 'The PIN has 4 to 6 digits.' }, 'err');
    }
    pinPad(true);
    const res = await api('POST', '/api/till/pin', { pin: value });
    pinPad(false);
    pin.value = '';
    if (res.ok) {
      say({ de: `Hallo ${res.data.staff.name}!`, en: `Hello ${res.data.staff.name}!` }, 'ok');
      return loadState();
    }
    const d = res.data;
    if (d.error === 'invalid_pin') {
      const left = d.attemptsLeft;
      say(
        typeof left === 'number'
          ? { de: `PIN falsch. Noch ${left} ${left === 1 ? 'Versuch' : 'Versuche'}.`, en: `Wrong PIN. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.` }
          : { de: 'PIN falsch.', en: 'Wrong PIN.' },
        'err',
      );
    } else if (d.error === 'pin_locked') {
      lockPinPad(d.lockedUntil);
    } else {
      fail(res);
    }
    if (view === 'pin' && !pin.disabled) pin.focus();
  });

  function lockPinPad(until) {
    const end = new Date(until);
    const wait = Number.isNaN(end.getTime()) ? 5 * 60 * 1000 : end.getTime() - Date.now();
    const at = Number.isNaN(end.getTime()) ? '' : time(end.toISOString());
    say(
      at
        ? { de: `Zu viele falsche PINs. Die Kasse ist bis ${at} Uhr gesperrt.`, en: `Too many wrong PINs. The till is locked until ${at}.` }
        : { de: 'Zu viele falsche PINs. Die Kasse ist 5 Minuten gesperrt.', en: 'Too many wrong PINs. The till is locked for 5 minutes.' },
      'err',
    );
    pinPad(true);
    clearTimeout(pinUnlockTimer);
    pinUnlockTimer = setTimeout(() => {
      pinPad(false);
      if (view === 'pin') {
        say({ de: 'Du kannst die PIN wieder eingeben.', en: 'You can enter the PIN again.' }, 'ok');
        pin.focus();
      }
    }, Math.max(0, wait) + 500);
  }

  // ---------- Sperren ----------

  async function lock(texts) {
    stopScan();
    const res = await api('POST', '/api/till/logout', {});
    if (state) state.session = null;
    // Auch bei Netzfehler lokal sperren; die Sitzung läuft auf dem Server nach 15 Minuten ab
    if (res.status === 0) say(MSG.offline, 'err');
    else say(texts, 'ok');
    if (view !== 'pair') show('pin');
  }

  $('lock').addEventListener('click', () => lock({ de: 'Kasse gesperrt.', en: 'Till locked.' }));

  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(type, () => (lastActivity = Date.now()), { capture: true, passive: true });
  }
  setInterval(() => {
    if (view === 'main' && Date.now() - lastActivity > IDLE_MS) {
      lock({ de: '15 Minuten nichts passiert, die Kasse wurde gesperrt.', en: 'Nothing happened for 15 minutes, the till was locked.' });
    }
  }, 20 * 1000);

  // ---------- Tabs ----------

  function selectTab(name, focus) {
    const isCard = name === 'card';
    $('tabCard').setAttribute('aria-selected', String(isCard));
    $('tabLog').setAttribute('aria-selected', String(!isCard));
    $('tabCard').tabIndex = isCard ? 0 : -1;
    $('tabLog').tabIndex = isCard ? -1 : 0;
    $('pCard').hidden = !isCard;
    $('pLog').hidden = isCard;
    if (focus) (isCard ? $('tabCard') : $('tabLog')).focus();
    if (!isCard) {
      stopScan();
      loadLog();
    }
  }

  $('tabCard').addEventListener('click', () => selectTab('card', false));
  $('tabLog').addEventListener('click', () => selectTab('log', false));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const toLog = e.key === 'End' || ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && $('tabCard').getAttribute('aria-selected') === 'true');
      selectTab(toLog ? 'log' : 'card', true);
    }
  });

  // ---------- Karte finden: Kamera ----------

  /** Token aus einem gescannten Link https://host/c/<token> oder ein nacktes Token, sonst null. */
  function tokenFrom(text) {
    const s = String(text).trim();
    if (TOKEN.test(s)) return s;
    try {
      const m = new URL(s).pathname.match(/^\/c\/([0-9A-Za-z]{22})\/?$/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function camSupported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.jsQR);
  }

  let starting = false;

  async function startScan() {
    // Doppeltipp, während der Browser noch nach der Kamera fragt: kein zweiter Stream
    if (stream || starting) return;
    if (!camSupported()) {
      $('camNote').hidden = false;
      $('code').focus();
      return;
    }
    say(null);
    starting = true;
    $('scanBtn').disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (err) {
      stream = null;
      starting = false;
      $('scanBtn').disabled = false;
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      say(
        denied
          ? { de: 'Kein Zugriff auf die Kamera. Erlaube ihn in den Browser-Einstellungen oder gib den Kurzcode ein.', en: 'No access to the camera. Allow it in the browser settings or enter the short code.' }
          : { de: 'Keine Kamera gefunden. Gib den Kurzcode ein.', en: 'No camera found. Enter the short code.' },
        'err',
      );
      $('code').focus();
      return;
    }
    starting = false;
    $('scanBtn').disabled = false;
    // Ansicht gewechselt oder Tab versteckt, während der Browser nach der Kamera gefragt hat
    if (view !== 'main' || $('pCard').hidden || document.hidden) return stopScan();
    const video = $('video');
    video.srcObject = stream;
    $('cam').hidden = false;
    $('camHelp').hidden = false;
    $('scanBtn').hidden = true;
    $('stopBtn').hidden = false;
    $('stopBtn').focus();
    lastBadScan = '';
    try {
      await video.play();
    } catch {
      // Autoplay-Sperre: muted + playsinline reicht fast überall, sonst bleibt der Kurzcode
    }
    clearInterval(scanTimer);
    scanTimer = setInterval(scanFrame, SCAN_MS);
  }

  function stopScan() {
    clearInterval(scanTimer);
    scanTimer = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    const hadStream = Boolean(stream);
    stream = null;
    const video = $('video');
    video.srcObject = null;
    $('cam').hidden = true;
    $('camHelp').hidden = true;
    $('stopBtn').hidden = true;
    $('scanBtn').hidden = false;
    if (hadStream && document.activeElement === document.body) $('scanBtn').focus();
  }

  function scanFrame() {
    const video = $('video');
    if (!stream || video.readyState < 2 || !video.videoWidth) return;
    // Verkleinert reicht für einen QR-Code auf dem Handy und spart Rechenzeit
    const scale = Math.min(1, 640 / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = $('canvas');
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const found = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (!found || !found.data) return;
    const token = tokenFrom(found.data);
    if (!token) {
      if (found.data !== lastBadScan) say(MSG.bad_scan, 'err');
      lastBadScan = found.data;
      return;
    }
    stopScan();
    if (navigator.vibrate) navigator.vibrate(60);
    openCard(token);
  }

  $('scanBtn').addEventListener('click', startScan);
  $('stopBtn').addEventListener('click', () => {
    stopScan();
    $('scanBtn').focus();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScan();
  });
  window.addEventListener('pagehide', stopScan);

  // ---------- Karte finden: Kurzcode ----------

  $('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('code');
    const raw = input.value.trim();
    // Ein eingefügter Link oder ein Token geht auch, sonst der Kurzcode
    const ref = tokenFrom(raw) ?? raw.replace(/[\s-]+/g, '').toUpperCase();
    input.removeAttribute('aria-invalid');
    if (!TOKEN.test(ref) && !SHORT.test(ref)) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return say(MSG.bad_code, 'err');
    }
    openCard(ref);
  });

  async function openCard(ref) {
    await work(async () => {
      const res = await api('GET', `/api/till/cards/${encodeURIComponent(ref)}`);
      if (!res.ok) return fail(res);
      $('code').value = '';
      issued = null;
      say(null);
      setCard(res.data.card);
      $('h-card').focus();
    });
  }

  // ---------- Neue Karte ----------

  $('newCardBtn').addEventListener('click', () =>
    work(async () => {
      stopScan();
      const programs = state?.programs ?? [];
      const body = programs.length > 1 && $('program').value ? { programId: $('program').value } : {};
      const res = await api('POST', '/api/till/cards', body);
      if (!res.ok) return fail(res);
      issued = { url: res.data.url, qrUrl: res.data.qrUrl, shortCode: res.data.card.shortCode };
      say({ de: 'Neue Karte ausgegeben. Der Gast scannt jetzt den QR-Code.', en: 'New card issued. The guest now scans the QR code.' }, 'ok');
      setCard(res.data.card);
      $('h-issued').focus();
    }),
  );

  // ---------- Karte ----------

  function setCard(next, from) {
    card = next;
    freshFrom = from;
    renderCard();
  }

  function closeCard() {
    card = null;
    issued = null;
    retry = null;
    renderCard();
  }

  function amount() {
    const n = Number.parseInt($('amount').value, 10);
    return Number.isInteger(n) ? Math.min(20, Math.max(1, n)) : 1;
  }

  function readyRewards() {
    return card ? card.program.rewards.filter((r) => r.threshold <= card.stamps && !r.claimed) : [];
  }

  function renderCard() {
    $('issued').hidden = !issued;
    if (issued) {
      $('issuedQr').src = issued.qrUrl;
      $('issuedCode').textContent = issued.shortCode;
      $('issuedLink').href = issued.url;
      $('issuedLink').textContent = issued.url;
    }
    $('cardBox').hidden = !card;
    $('emptyCard').hidden = Boolean(card || issued);
    const n = amount();
    $('stampBtn').textContent = t({ de: `${n} Stempel vergeben`, en: n === 1 ? 'Give 1 stamp' : `Give ${n} stamps` });
    $('minus').disabled = busy || n <= 1;
    $('plus').disabled = busy || n >= 20;
    $('stampBtn').disabled = busy || !card;
    $('newCardBtn').disabled = busy;
    if (!card) {
      $('cardView').replaceChildren();
      $('redeemList').replaceChildren();
      $('undoBtn').hidden = true;
      return;
    }
    const p = card.program;
    $('h-card').textContent = t({ de: `Karte ${card.shortCode}`, en: `Card ${card.shortCode}` });
    $('cardView').replaceChildren(
      window.StampCard.render({ name: p.name, earnRule: p.earnRule, ink: p.ink, rewards: p.rewards, stamps: card.stamps, freshFrom }, { status: true }),
    );
    $('redeemList').replaceChildren(
      ...readyRewards().map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn--ink';
        b.dataset.reward = r.id;
        b.disabled = busy;
        b.textContent = t({ de: `Einlösen: ${r.text}`, en: `Redeem: ${r.text}` });
        return b;
      }),
    );
    $('undoBtn').hidden = !card.canUndo;
    $('undoBtn').disabled = busy;
  }

  $('amount').addEventListener('input', renderCard);
  $('amount').addEventListener('change', () => {
    $('amount').value = String(amount());
    renderCard();
  });
  $('minus').addEventListener('click', () => {
    $('amount').value = String(Math.max(1, amount() - 1));
    renderCard();
  });
  $('plus').addEventListener('click', () => {
    $('amount').value = String(Math.min(20, amount() + 1));
    renderCard();
  });

  $('closeBtn').addEventListener('click', () => {
    closeCard();
    say(null);
    $('amount').value = '1';
    renderCard();
    $('scanBtn').focus();
  });

  $('stampBtn').addEventListener('click', () =>
    work(async () => {
      if (!card) return;
      const before = card;
      const wanted = amount();
      const res = await mutate(`/api/till/cards/${before.id}/stamps`, { amount: wanted });
      if (!res.ok) return fail(res);
      const added = res.data.added ?? res.data.card.stamps - before.stamps;
      setCard(res.data.card, res.data.card.cycle === before.cycle ? before.stamps : undefined);
      $('amount').value = '1';
      // Der Server stempelt höchstens bis zur Kartenlänge
      say(
        added < wanted
          ? { de: `Nur ${added} Stempel vergeben, die Karte ist jetzt voll.`, en: `Only ${added} ${added === 1 ? 'stamp' : 'stamps'} given, the card is now full.` }
          : { de: `${added} Stempel vergeben.`, en: added === 1 ? '1 stamp given.' : `${added} stamps given.` },
        'ok',
      );
    }),
  );

  $('redeemList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-reward]');
    if (!btn) return;
    work(async () => {
      if (!card) return;
      const reward = card.program.rewards.find((r) => r.id === btn.dataset.reward);
      const res = await mutate(`/api/till/cards/${card.id}/redeem`, { rewardId: btn.dataset.reward });
      if (!res.ok) {
        fail(res);
        // Stand neu holen, falls eine andere Kasse schneller war
        if (res.data.error === 'reward_not_available') refreshCard();
        return;
      }
      setCard(res.data.card);
      const text = reward ? reward.text : '';
      say(
        res.data.restarted
          ? { de: `Eingelöst: ${text}. Alle Prämien sind weg, die Karte beginnt von vorn.`, en: `Redeemed: ${text}. All rewards are used, the card starts again.` }
          : { de: `Eingelöst: ${text}.`, en: `Redeemed: ${text}.` },
        'ok',
      );
      $('h-card').focus();
    });
  });

  $('undoBtn').addEventListener('click', () =>
    work(async () => {
      if (!card) return;
      const res = await mutate(`/api/till/cards/${card.id}/undo`, {});
      if (!res.ok) {
        fail(res);
        if (res.data.error === 'nothing_to_undo') refreshCard();
        return;
      }
      setCard(res.data.card);
      say({ de: 'Rückgängig gemacht.', en: 'Undone.' }, 'ok');
      $('h-card').focus();
    }),
  );

  /** Lädt die offene Karte neu, ohne Meldung (die Fehlermeldung bleibt stehen). */
  async function refreshCard() {
    if (!card) return;
    const res = await api('GET', `/api/till/cards/${encodeURIComponent(card.shortCode)}`);
    if (res.ok && card && res.data.card.id === card.id) setCard(res.data.card);
  }

  // ---------- Heute ----------

  async function loadLog() {
    $('logRefresh').disabled = true;
    const res = await api('GET', '/api/till/log');
    $('logRefresh').disabled = false;
    if (!res.ok) return fail(res);
    log = res.data;
    renderLog();
  }

  function describe(ev) {
    if (ev.type === 'issue') return t({ de: 'Karte ausgegeben', en: 'Card issued' });
    if (ev.type === 'give') {
      const n = ev.amount ?? 1;
      return t({ de: `${n} Stempel`, en: n === 1 ? '1 stamp' : `${n} stamps` });
    }
    if (ev.type === 'redeem') return t({ de: `Eingelöst: ${ev.rewardText ?? 'Prämie'}`, en: `Redeemed: ${ev.rewardText ?? 'reward'}` });
    if (ev.type === 'undo') return t({ de: 'Rückgängig gemacht', en: 'Undone' });
    return ev.type;
  }

  function renderLog() {
    if (!log) return;
    $('statIssued').textContent = String(log.stats?.issued ?? 0);
    $('statStamps').textContent = String(log.stats?.stamps ?? 0);
    $('statRedeemed').textContent = String(log.stats?.redeemed ?? 0);
    const list = $('log');
    if (!log.events?.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t({ de: 'Heute ist noch nichts passiert.', en: 'Nothing has happened today yet.' });
      return list.replaceChildren(li);
    }
    list.replaceChildren(
      ...log.events.map((ev) => {
        const li = document.createElement('li');
        if (ev.undone) li.className = 'undone';
        const when = document.createElement('time');
        when.dateTime = ev.createdAt;
        when.textContent = time(ev.createdAt);
        const what = document.createElement('span');
        what.textContent = [describe(ev), ev.staffName, ev.shortCode].filter(Boolean).join(' · ');
        li.append(when, what);
        if (ev.undone) {
          // Durchgestrichen sieht man, ein Screenreader braucht es als Text
          const note = document.createElement('em');
          note.className = 'visually-hidden';
          note.textContent = t({ de: ' (rückgängig gemacht)', en: ' (undone)' });
          li.append(note);
        }
        return li;
      }),
    );
  }

  $('logRefresh').addEventListener('click', loadLog);

  // ---------- Start ----------

  window.I18N.onChange(() => {
    renderMessage();
    renderHeader();
    renderCard();
    renderLog();
  });

  codeFromFragment();
  renderCard();
  loadState();
})();

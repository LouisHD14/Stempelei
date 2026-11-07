// Gast-Ansicht einer Stempelkarte unter /c/<token>. Aktualisiert sich live per Server-Sent Events.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (texts) => window.I18N.t(texts);
  const flash = $('flash');
  const token = (location.pathname.match(/^\/c\/([0-9A-Za-z]{22})$/) || [])[1];
  let card = null;

  function say(text, kind) {
    flash.textContent = text;
    flash.classList.toggle('err', kind === 'err');
    flash.classList.toggle('ok', kind === 'ok');
  }

  function show(next, freshFrom) {
    card = next;
    $('bizName').textContent = next.business;
    document.title = `${next.name} · ${next.business}`;
    $('card').replaceChildren(window.StampCard.render({ ...next, freshFrom }, { status: true }));
    $('code').textContent = next.shortCode;
  }

  /** Erklärt dem Gast, was sich geändert hat. */
  function describe(before, after) {
    if (after.cycle > before.cycle) {
      return t({ de: 'Prämie eingelöst. Deine Karte beginnt von vorn.', en: 'Reward redeemed. Your card starts again.' });
    }
    const claimedBefore = before.rewards.filter((r) => r.claimed).length;
    const claimedAfter = after.rewards.filter((r) => r.claimed).length;
    if (claimedAfter > claimedBefore) return t({ de: 'Prämie eingelöst. Lass es dir schmecken!', en: 'Reward redeemed. Enjoy!' });
    const added = after.stamps - before.stamps;
    if (added > 0) {
      return t({ de: added === 1 ? 'Neuer Stempel!' : `${added} neue Stempel!`, en: added === 1 ? 'New stamp!' : `${added} new stamps!` });
    }
    return '';
  }

  function listen() {
    if (!window.EventSource) return;
    const source = new EventSource(`/api/public/cards/${token}/live`);
    source.addEventListener('card', (e) => {
      const next = JSON.parse(e.data);
      const before = card;
      const sameRound = before && next.cycle === before.cycle;
      show(next, sameRound && next.stamps > before.stamps ? before.stamps : undefined);
      const msg = before ? describe(before, next) : '';
      if (msg) say(msg, 'ok');
    });
    source.addEventListener('open', () => {
      $('liveNote').hidden = false;
    });
  }

  async function start() {
    if (!token) return say(t({ de: 'Diese Karte gibt es nicht.', en: 'This card does not exist.' }), 'err');
    let res;
    try {
      res = await fetch(`/api/public/cards/${token}`);
    } catch {
      return say(t({ de: 'Keine Verbindung. Prüf dein Internet.', en: 'No connection. Check your internet.' }), 'err');
    }
    if (res.status === 404) return say(t({ de: 'Diese Karte gibt es nicht.', en: 'This card does not exist.' }), 'err');
    if (!res.ok) return say(t({ de: 'Die Karte ließ sich nicht laden. Versuch es gleich noch einmal.', en: 'The card could not be loaded. Try again in a moment.' }), 'err');
    const data = await res.json();
    show(data.card);
    $('qr').src = `/api/public/cards/${token}/qr.svg`;
    $('qrbox').hidden = false;
    listen();
    walletButtons();
  }

  // ---------- Apple und Google Wallet ----------
  let wallet = null;

  /** Die offiziellen Knöpfe, passend zum Gerät: iPhone/Mac Apple, Android Google, sonst beide. */
  async function walletButtons() {
    try {
      const res = await fetch('/api/public/wallet');
      if (res.ok) wallet = await res.json();
    } catch {
      return; // ohne Wallet-Knöpfe geht es auch
    }
    if (!wallet) return;
    const ua = navigator.userAgent;
    const apple = /iPhone|iPad|iPod|Macintosh/.test(ua);
    const android = /Android/.test(ua);
    const showApple = wallet.apple && !android;
    const showGoogle = wallet.google && !apple;
    $('appleWallet').hidden = !showApple;
    $('googleWallet').hidden = !showGoogle;
    $('appleWallet').href = `/api/public/cards/${token}/wallet/apple`;
    $('googleWallet').href = `/api/public/cards/${token}/wallet/google`;
    $('wallet').hidden = !showApple && !showGoogle;
    badges();
  }

  /** Knopf-Grafiken in der Sprache der Seite (Apple und Google verlangen ihre eigenen Übersetzungen). */
  function badges() {
    const lang = window.I18N.lang === 'en' ? 'en' : 'de';
    $('appleWallet').querySelector('img').src = `/assets/wallet/badges/${lang}/apple.svg`;
    $('googleWallet').querySelector('img').src = `/assets/wallet/badges/${lang}/google.svg`;
  }

  window.I18N.onChange(() => {
    if (card) show(card);
    if (wallet) badges();
  });
  start();
})();

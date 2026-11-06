/* Stempelei – Demo-Logik.
   Alle Daten liegen im localStorage dieses Browsers. Mehrere Tabs bleiben über das storage-Event synchron. */
(function () {
  'use strict';

  // Erst mit Skript werden die Ablauf-Bilder einzeln eingeblendet; ohne Skript bleiben alle sichtbar
  document.documentElement.classList.add('js');

  // ---------- Konstanten ----------
  var KEY = 'stempelei-v4';
  var AUTH_KEY = 'stempelei-auth';
  var ACCESS_CODE = '1234';
  var MAX_STAMPS = 20;
  var MAX_REWARDS = 5;
  var MAX_LOG = 60;
  var MAX_CARDS = 60;

  // Die Farbwerte stehen als Tokens im Stylesheet (--ink-*)
  var INKS = {
    tinte: { label: 'Tinte' },
    blau: { label: 'Blau' },
    gruen: { label: 'Grün' },
    koralle: { label: 'Koralle' }
  };
  function inkVar(k) { return 'var(--ink-' + (INKS[k] ? k : 'tinte') + ')'; }

  var PRESETS = {
    restaurant: { label: 'Restaurant', name: 'Trattoria Mia', earn: 'jeden Besuch', rewards: [[5, 'Espresso aufs Haus'], [10, 'Dessert aufs Haus']] },
    cafe: { label: 'Café', name: 'Café Lindenhof', earn: 'jedes Heißgetränk', rewards: [[4, 'Keks gratis'], [8, 'Kaffee gratis']] },
    baeckerei: { label: 'Bäckerei', name: 'Bäckerei Hoffmann', earn: 'jeden Einkauf ab 5 €', rewards: [[10, 'Brotlaib gratis']] },
    friseur: { label: 'Friseur', name: 'Salon Kamm & Schere', earn: 'jeden Termin', rewards: [[6, 'Haarwäsche gratis']] },
    eisdiele: { label: 'Eisdiele', name: 'Eiscafé Venezia', earn: 'jede Kugel', rewards: [[6, 'Waffel gratis'], [12, 'Becher gratis']] },
    eigen: { label: 'Leer', name: '', earn: '', rewards: [[5, '']] }
  };

  // ---------- Zustand ----------
  function makeRewards(list, startId) {
    return list.map(function (r, i) { return { id: startId + i, at: r[0], text: r[1] }; });
  }
  function blankCard(stamps) { return { stamps: stamps || 0, claimed: [], redeemed: 0 }; }

  function defaults() {
    var p = PRESETS.restaurant;
    return {
      v: 4,
      biz: { type: 'restaurant', name: p.name, earn: p.earn, ink: 'tinte', rewards: makeRewards(p.rewards, 1), nextId: 1 + p.rewards.length },
      cards: { '0427': blankCard(4), '0388': blankCard(9), '0512': blankCard(1) },
      me: '0427',
      log: [],
      nextLog: 1
    };
  }

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  function validPrev(p) {
    return !!p && isInt(p.stamps) && Array.isArray(p.claimed) && p.claimed.every(isInt) && isInt(p.redeemed);
  }
  function validLog(e) {
    if (!e || !isInt(e.id) || typeof e.t !== 'string' || typeof e.card !== 'string') return false;
    if (e.type === 'give') return isInt(e.n) && validPrev(e.prev);
    if (e.type === 'redeem') return typeof e.reward === 'string' && validPrev(e.prev);
    if (e.type === 'undo') return typeof e.what === 'string';
    return e.type === 'new';
  }

  // Prüft gespeicherte Daten. Alles, was nicht passt, fällt auf die Vorgabe zurück.
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || raw.v !== 4) return null;
    var d = defaults();
    var b = raw.biz;
    if (!b || !Array.isArray(b.rewards) || !b.rewards.length) return null;
    var rewards = b.rewards.filter(function (r) {
      return r && isInt(r.id) && isInt(r.at) && r.at >= 1 && r.at <= MAX_STAMPS && typeof r.text === 'string';
    }).slice(0, MAX_REWARDS);
    if (!rewards.length) return null;
    var maxId = Math.max.apply(null, rewards.map(function (r) { return r.id; }));
    var cards = {};
    if (raw.cards && typeof raw.cards === 'object') {
      Object.keys(raw.cards).forEach(function (id) {
        var c = raw.cards[id];
        if (!/^\d{4}$/.test(id) || !c || !isInt(c.stamps)) return;
        cards[id] = {
          stamps: c.stamps,
          claimed: Array.isArray(c.claimed) ? c.claimed.filter(isInt) : [],
          redeemed: isInt(c.redeemed) && c.redeemed >= 0 ? c.redeemed : 0
        };
      });
    }
    if (!Object.keys(cards).length) cards = d.cards;
    return {
      v: 4,
      biz: {
        type: PRESETS[b.type] ? b.type : 'eigen',
        name: typeof b.name === 'string' ? b.name.slice(0, 32) : d.biz.name,
        earn: typeof b.earn === 'string' ? b.earn.slice(0, 50) : d.biz.earn,
        ink: INKS[b.ink] ? b.ink : 'tinte',
        rewards: rewards.map(function (r) { return { id: r.id, at: r.at, text: r.text.slice(0, 40) }; }),
        nextId: isInt(b.nextId) && b.nextId > maxId ? b.nextId : maxId + 1
      },
      cards: cards,
      me: cards[raw.me] ? raw.me : Object.keys(cards).sort()[0],
      log: Array.isArray(raw.log) ? raw.log.filter(validLog).slice(0, MAX_LOG) : [],
      nextLog: isInt(raw.nextLog) ? raw.nextLog : 1
    };
  }

  function load() {
    try {
      var s = sanitize(JSON.parse(localStorage.getItem(KEY)));
      if (s) return s;
    } catch (e) { /* kein Speicher oder kaputte Daten */ }
    return defaults();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* Speicher nicht verfügbar */ }
  }

  var S = load();
  var ui = {
    authed: false,
    tab: 'stempeln',
    openId: null,       // Karte, die in der Kasse offen ist
    newId: null,        // gerade ausgegebene Karte
    amount: 1,
    fresh: null,        // { id, from } für die Stempel-Animation
    guestId: null,
    resetArmed: false
  };
  try { ui.authed = sessionStorage.getItem(AUTH_KEY) === '1'; } catch (e) { /* ohne sessionStorage */ }

  // ---------- Hilfsfunktionen ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function cardIds() { return Object.keys(S.cards).sort(); }
  function goal() { return Math.max.apply(null, S.biz.rewards.map(function (r) { return r.at; })); }
  function sortedRewards() {
    return S.biz.rewards.slice().sort(function (a, b) { return a.at - b.at || a.id - b.id; });
  }
  function rewardText(r) { return r.text && r.text.trim() ? r.text.trim() : 'Prämie'; }
  function bizName() { return S.biz.name && S.biz.name.trim() ? S.biz.name.trim() : 'Dein Betrieb'; }
  function isClaimed(c, r) { return c.claimed.indexOf(r.id) !== -1; }
  function available(c) { return sortedRewards().filter(function (r) { return r.at <= c.stamps && !isClaimed(c, r); }); }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // Stempelstände an die aktuelle Kartenlänge und Prämien anpassen.
  function normalize() {
    var g = goal();
    var ids = S.biz.rewards.map(function (r) { return r.id; });
    cardIds().forEach(function (id) {
      var c = S.cards[id];
      c.stamps = Math.max(0, Math.min(g, c.stamps));
      c.claimed = c.claimed.filter(function (rid) {
        var i = ids.indexOf(rid);
        return i !== -1 && S.biz.rewards[i].at <= c.stamps;
      });
    });
  }

  // Spaltenzahl so wählen, dass die letzte Reihe möglichst voll ist.
  function colsFor(g) {
    if (g <= 5) return Math.max(g, 1);
    var best = 5, bestGap = Infinity;
    [5, 4, 6, 3].forEach(function (c) {
      var gap = g % c === 0 ? 0 : c - (g % c);
      if (gap < bestGap) { best = c; bestGap = gap; }
    });
    return best;
  }

  // ---------- Grafiken ----------
  var GIFT = '<svg class="gift" viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"><rect x="8" y="19" width="32" height="21" rx="2"/><rect x="6" y="13" width="36" height="7" rx="2"/><path d="M24 13v27"/><path d="M24 13c-2-6-9-7-9-3s6 3 9 3zm0 0c2-6 9-7 9-3s-6 3-9 3z"/></svg>';

  function stampSVG(i, isNew) {
    var rot = ((i * 47) % 30) - 15;
    return '<svg class="stamp' + (isNew ? ' new' : '') + '" viewBox="0 0 48 48" style="--rot:' + rot + 'deg" aria-hidden="true">' +
      '<circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
      '<circle cx="24" cy="24" r="16.5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2.4"/>' +
      '<path d="M24 12l3.6 7.4 8.1 1.1-5.9 5.7 1.4 8.1L24 30.4l-7.2 3.9 1.4-8.1-5.9-5.7 8.1-1.1z" fill="currentColor"/></svg>';
  }

  // QR-Code als SVG. Ohne Bibliothek bleibt das Feld leer, die Nummer steht daneben.
  function qrSVG(text) {
    if (typeof qrcode !== 'function') return '';
    try {
      var q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      var n = q.getModuleCount(), m = 2, d = '';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
        }
      }
      var s = n + 2 * m;
      return '<svg viewBox="0 0 ' + s + ' ' + s + '" shape-rendering="crispEdges" aria-hidden="true"><rect width="' + s + '" height="' + s + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    } catch (e) { return ''; }
  }
  function codeFor(id) { return 'stempelei:' + id; }

  // Liest eine Kartennummer aus Scan oder Eingabe: "0427", "stempelei:0427" oder ein Link mit "#karte-0427".
  function parseCode(text) {
    var t = String(text || '').trim();
    var m = /^(?:stempelei:)?(\d{4})$/i.exec(t) || /#karte-(\d{4})(?:$|[^\d])/.exec(t);
    return m ? m[1] : null;
  }

  // ---------- Stempelkarte zeichnen ----------
  // opts: { qr: bool, status: bool }
  function buildCard(id, opts) {
    var c = S.cards[id], g = goal();
    var card = el('div', 'card');

    var head = el('div', 'card-head');
    head.appendChild(el('h2', 'card-name', bizName()));
    var earn = (S.biz.earn || '').trim();
    if (earn) head.appendChild(el('p', 'card-earn', 'Einen Stempel gibt es für ' + earn + '.'));
    card.appendChild(head);

    var slots = el('ol', 'slots');
    var cols = colsFor(g);
    slots.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    slots.style.maxWidth = (cols * 104) + 'px';
    slots.setAttribute('aria-label', c.stamps + ' von ' + g + ' Stempeln');
    var rewardAt = {};
    S.biz.rewards.forEach(function (r) { rewardAt[r.at] = true; });
    var freshFrom = ui.fresh && ui.fresh.id === id ? ui.fresh.from : Infinity;
    var html = '';
    for (var i = 0; i < g; i++) {
      var isRew = !!rewardAt[i + 1], on = i < c.stamps;
      var inner = on ? stampSVG(i, i >= freshFrom) : (isRew ? GIFT : '<span class="n">' + (i + 1) + '</span>');
      html += '<li class="slot' + (isRew ? ' reward' : '') + (on ? ' on' : '') + '">' + inner + '</li>';
    }
    slots.innerHTML = html;
    card.appendChild(slots);

    var legend = el('ul', 'legend');
    sortedRewards().forEach(function (r) {
      var claimed = isClaimed(c, r), free = r.at <= c.stamps && !claimed;
      var li = el('li', claimed ? 'done' : (free ? 'free' : ''));
      li.appendChild(el('span', 'at', r.at + ' Stempel'));
      li.appendChild(el('span', 'txt', rewardText(r)));
      li.appendChild(el('span', claimed ? 'st pressed' : 'st', claimed ? 'eingelöst' : (free ? 'frei' : '')));
      legend.appendChild(li);
    });
    card.appendChild(legend);

    if (opts && opts.status) {
      var st = el('p', 'card-status');
      var av = available(c);
      var strong = el('strong');
      if (av.length) {
        st.classList.add('free');
        strong.textContent = av.length === 1 ? 'Prämie frei: ' : av.length + ' Prämien frei: ';
        st.appendChild(strong);
        st.appendChild(document.createTextNode(av.map(rewardText).join(', ') + '. Zeig die Karte an der Kasse.'));
      } else {
        var next = sortedRewards().filter(function (r) { return r.at > c.stamps; })[0];
        if (next) {
          var left = next.at - c.stamps;
          strong.textContent = 'Noch ' + left + ' Stempel';
          st.appendChild(strong);
          st.appendChild(document.createTextNode(' bis ' + rewardText(next) + '.'));
        } else {
          st.textContent = 'Alle Prämien eingelöst.';
        }
      }
      card.appendChild(st);
    }

    if (opts && opts.qr) {
      var row = el('div', 'qrrow');
      var box = el('div', 'qr');
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', 'QR-Code der Karte ' + id);
      box.innerHTML = qrSVG(codeFor(id));
      var txt = el('p', 'qrtext');
      txt.appendChild(document.createTextNode('An der Kasse zeigen'));
      txt.appendChild(el('b', null, id));
      row.appendChild(box);
      row.appendChild(txt);
      card.appendChild(row);
    }

    var foot = el('div', 'card-foot');
    var nr = el('span', null, 'Karte ');
    nr.appendChild(el('span', 'fig', id));
    foot.appendChild(nr);
    if (c.redeemed > 0) foot.appendChild(el('span', null, c.redeemed + ' ' + plural(c.redeemed, 'Prämie', 'Prämien') + ' geholt'));
    foot.appendChild(el('span', 'fig', c.stamps + ' / ' + g));
    card.appendChild(foot);
    return card;
  }

  function mountCard(slot, id, opts) {
    var host = document.querySelector('[data-card="' + slot + '"]');
    if (!host) return;
    host.textContent = '';
    if (id && S.cards[id]) host.appendChild(buildCard(id, opts));
  }

  // ---------- Aktionen ----------
  function addLog(entry) {
    entry.id = S.nextLog++;
    entry.t = new Date().toISOString();
    S.log.unshift(entry);
    if (S.log.length > MAX_LOG) S.log.length = MAX_LOG;
  }
  function snapshot(c) { return { stamps: c.stamps, claimed: c.claimed.slice(), redeemed: c.redeemed }; }

  function give(id, n) {
    var c = S.cards[id], g = goal();
    if (!c) return { ok: false, msg: 'Diese Karte gibt es nicht.' };
    if (c.stamps >= g) return { ok: false, msg: 'Die Karte ist voll. Löse zuerst die Prämie ein.' };
    var add = Math.max(1, Math.min(n, g - c.stamps));
    var prev = snapshot(c);
    ui.fresh = { id: id, from: c.stamps };
    c.stamps += add;
    addLog({ type: 'give', card: id, n: add, prev: prev });
    save();
    var msg = add + ' Stempel vergeben.';
    var av = available(c);
    if (av.length) msg += ' Prämie frei: ' + rewardText(av[0]) + '.';
    else if (c.stamps >= g) msg += ' Die Karte ist voll.';
    return { ok: true, msg: msg };
  }

  function redeem(id, rewardId) {
    var c = S.cards[id];
    if (!c) return { ok: false, msg: 'Diese Karte gibt es nicht.' };
    var r = available(c).filter(function (x) { return x.id === rewardId; })[0];
    if (!r) return { ok: false, msg: 'Diese Prämie ist auf der Karte nicht frei.' };
    var prev = snapshot(c);
    c.claimed.push(r.id);
    c.redeemed += 1;
    var restart = S.biz.rewards.every(function (x) { return isClaimed(c, x); });
    if (restart) { c.stamps = 0; c.claimed = []; }
    addLog({ type: 'redeem', card: id, reward: rewardText(r), prev: prev });
    save();
    return { ok: true, msg: 'Eingelöst: ' + rewardText(r) + '.' + (restart ? ' Die Karte beginnt von vorn.' : '') };
  }

  function lastUndoable(id) {
    for (var i = 0; i < S.log.length; i++) {
      var e = S.log[i];
      if (e.card === id && (e.type === 'give' || e.type === 'redeem') && !e.undone && e.prev) return e;
    }
    return null;
  }
  function describe(e) {
    if (e.type === 'give') return e.n + ' Stempel';
    if (e.type === 'redeem') return 'Einlösung „' + e.reward + '“';
    return '';
  }
  function undo(id) {
    var c = S.cards[id], e = lastUndoable(id);
    if (!c || !e) return { ok: false, msg: 'Für diese Karte gibt es nichts zum Rückgängigmachen.' };
    c.stamps = e.prev.stamps;
    c.claimed = e.prev.claimed.slice();
    c.redeemed = e.prev.redeemed;
    e.undone = true;
    normalize();
    addLog({ type: 'undo', card: id, what: describe(e) });
    save();
    return { ok: true, msg: 'Rückgängig gemacht: ' + describe(e) + '.' };
  }

  function issueCard() {
    if (cardIds().length >= MAX_CARDS) return null;
    var id;
    do { id = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); } while (S.cards[id] || id === '0000');
    S.cards[id] = blankCard(0);
    addLog({ type: 'new', card: id });
    save();
    return id;
  }

  // ---------- Rendern ----------
  function applyInk() {
    document.documentElement.style.setProperty('--stamp', inkVar(S.biz.ink));
  }

  function renderHero() {
    var id = S.me, c = S.cards[id];
    mountCard('hero', id, { status: true, qr: false });
    mountCard('flow', id, { status: false, qr: true });
    mountCard('flowm', id, { status: false, qr: true });
    mountCard('setup', id, { status: true, qr: false });
    Array.prototype.forEach.call($('templates').children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.key === S.biz.type));
    });
    var av = available(c), full = c.stamps >= goal();
    $('heroGive').disabled = full;
    var rb = $('heroRedeem');
    rb.hidden = !av.length;
    if (av.length) rb.textContent = 'Einlösen: ' + rewardText(av[0]);
    $('heroUndo').disabled = !lastUndoable(id);
  }

  function renderKasse() {
    $('kLogin').hidden = ui.authed;
    $('kMain').hidden = !ui.authed;
    if (!ui.authed) return;
    $('kBiz').textContent = bizName();

    ['stempeln', 'einrichten', 'verlauf'].forEach(function (t) {
      var on = ui.tab === t;
      var tab = $('tab-' + t);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('panel-' + t).hidden = !on;
    });

    if (ui.openId && !S.cards[ui.openId]) ui.openId = null;
    var id = ui.openId, has = !!id;
    $('kEmpty').hidden = has;
    $('kOpen').hidden = !has;
    if (has) {
      var c = S.cards[id], g = goal(), left = g - c.stamps;
      $('kId').textContent = id;
      $('kGuestLink').href = '#karte-' + id;
      $('kNew').hidden = ui.newId !== id;
      if (ui.newId === id) $('kNewQr').innerHTML = qrSVG(codeFor(id));
      mountCard('kasse', id, { status: false, qr: false });

      ui.amount = Math.max(1, Math.min(ui.amount, Math.max(1, left)));
      var amt = $('amtInput');
      if (document.activeElement !== amt) amt.value = ui.amount;
      amt.max = String(Math.max(1, left));
      $('amtMinus').disabled = ui.amount <= 1 || left <= 0;
      $('amtPlus').disabled = ui.amount >= left;
      $('kGive').disabled = left <= 0;
      $('kGive').textContent = left <= 0 ? 'Karte ist voll' : ui.amount + ' Stempel vergeben';

      var av = available(c), list = $('kRedeemList');
      list.textContent = '';
      $('kRedeemGroup').hidden = !av.length;
      av.forEach(function (r) {
        var b = el('button', 'btn btn--ink');
        b.type = 'button';
        b.appendChild(el('span', null, rewardText(r)));
        b.appendChild(el('span', null, 'einlösen'));
        b.addEventListener('click', function () {
          var res = redeem(id, r.id);
          kflash(res.msg, !res.ok);
          renderAll();
        });
        list.appendChild(b);
      });

      var u = lastUndoable(id);
      $('kUndo').disabled = !u;
      $('kUndo').textContent = u ? 'Rückgängig: ' + describe(u) : 'Rückgängig';
    }

    renderStats();
    renderLog();
    renderTiles();
    mountCard('preview', S.me, { status: true, qr: true });
  }

  function renderStats() {
    var today = new Date().toDateString(), give = 0, red = 0, neu = 0;
    S.log.forEach(function (e) {
      if (new Date(e.t).toDateString() !== today || e.undone) return;
      if (e.type === 'give') give += e.n || 0;
      if (e.type === 'redeem') red += 1;
      if (e.type === 'new') neu += 1;
    });
    $('statGive').textContent = give;
    $('statRedeem').textContent = red;
    $('statNew').textContent = neu;
  }

  function logText(e) {
    var k = 'Karte ' + e.card + ': ';
    if (e.type === 'give') return k + e.n + ' Stempel vergeben';
    if (e.type === 'redeem') return k + 'Prämie eingelöst, ' + e.reward;
    if (e.type === 'undo') return k + 'rückgängig gemacht (' + e.what + ')';
    if (e.type === 'new') return k + 'neu ausgegeben';
    return k + e.type;
  }

  function renderLog() {
    var ul = $('log');
    ul.textContent = '';
    if (!S.log.length) {
      ul.appendChild(el('li', 'empty', 'Noch keine Aktionen. Öffne eine Karte unter „Stempeln“ und vergib den ersten Stempel.'));
      return;
    }
    S.log.slice(0, 15).forEach(function (e) {
      var li = el('li', e.undone ? 'undone' : '');
      var t = el('time', null, new Date(e.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
      t.dateTime = e.t;
      li.appendChild(t);
      li.appendChild(el('span', null, logText(e)));
      ul.appendChild(li);
    });
  }

  function renderTiles() {
    var box = $('tiles');
    box.textContent = '';
    cardIds().forEach(function (id) {
      var c = S.cards[id];
      var t = el('div', 'tile stock');
      var q = el('div', 'qr');
      q.setAttribute('role', 'img');
      q.setAttribute('aria-label', 'QR-Code der Karte ' + id);
      q.innerHTML = qrSVG(codeFor(id));
      t.appendChild(q);
      t.appendChild(el('b', null, id));
      t.appendChild(el('span', null, c.stamps + ' / ' + goal() + ' Stempel'));
      var row = el('div', 'actions');
      var b = el('button', 'btn btn--card btn--s', 'Öffnen');
      b.type = 'button';
      b.addEventListener('click', function () { setTab('stempeln'); openCard(id); });
      var a = el('a', 'btn btn--card btn--s', 'Gast');
      a.href = '#karte-' + id;
      a.setAttribute('aria-label', 'Gast-Ansicht der Karte ' + id);
      row.appendChild(b);
      row.appendChild(a);
      t.appendChild(row);
      box.appendChild(t);
    });
  }

  function renderGuest() {
    var id = ui.guestId, ok = !!(id && S.cards[id]);
    $('guestMissing').hidden = ok;
    mountCard('guest', ok ? id : null, { status: true, qr: true });
    var now = new Date();
    $('guestClock').textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function renderAll() {
    applyInk();
    renderHero();
    renderKasse();
    renderGuest();
    ui.fresh = null;
  }

  // ---------- Einstellungen ----------
  function renderControls() {
    $('fName').value = S.biz.name;
    $('fEarn').value = S.biz.earn;
    Array.prototype.forEach.call($('presets').children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.key === S.biz.type));
    });
    Array.prototype.forEach.call($('swatches').children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.key === S.biz.ink));
    });
    renderRewardRows(false);
  }

  function renderRewardRows(focusLast) {
    var box = $('rrows');
    box.textContent = '';
    S.biz.rewards.forEach(function (r, idx) {
      var row = el('div', 'rrow');

      var num = el('input');
      num.type = 'number'; num.min = '1'; num.max = String(MAX_STAMPS); num.inputMode = 'numeric';
      num.id = 'rAt' + r.id;
      num.value = r.at;
      num.setAttribute('aria-label', 'Prämie ' + (idx + 1) + ': ab wie vielen Stempeln');
      num.addEventListener('input', function () {
        var v = parseInt(num.value, 10);
        if (v >= 1 && v <= MAX_STAMPS) {
          r.at = v; normalize(); save(); renderAll();
          sflash('');
        } else if (num.value !== '') {
          sflash('Die Stempelzahl muss zwischen 1 und ' + MAX_STAMPS + ' liegen.', true);
        }
      });
      num.addEventListener('change', function () { num.value = r.at; sflash(''); });

      var txt = el('input');
      txt.type = 'text'; txt.maxLength = 40; txt.value = r.text;
      txt.id = 'rTx' + r.id;
      txt.placeholder = 'z. B. Getränk aufs Haus';
      txt.setAttribute('aria-label', 'Prämie ' + (idx + 1) + ': Was gibt es?');
      txt.addEventListener('input', function () { r.text = txt.value; save(); renderAll(); });

      var del = el('button', 'btn btn--card', '×');
      del.type = 'button';
      del.setAttribute('aria-label', 'Prämie ' + (idx + 1) + ' entfernen');
      del.disabled = S.biz.rewards.length <= 1;
      del.addEventListener('click', function () {
        if (S.biz.rewards.length <= 1) return;
        S.biz.rewards = S.biz.rewards.filter(function (x) { return x.id !== r.id; });
        normalize(); save(); renderRewardRows(false); renderAll();
        sflash('Prämie entfernt.');
      });

      row.appendChild(num); row.appendChild(txt); row.appendChild(del);
      box.appendChild(row);
    });
    $('addReward').disabled = S.biz.rewards.length >= MAX_REWARDS;
    if (focusLast) {
      var inputs = box.querySelectorAll('input[type="text"]');
      var last = inputs[inputs.length - 1];
      if (last) last.focus();
    }
  }

  function applyPreset(k) {
    var p = PRESETS[k];
    S.biz.type = k; S.biz.name = p.name; S.biz.earn = p.earn;
    S.biz.rewards = makeRewards(p.rewards, S.biz.nextId);
    S.biz.nextId += p.rewards.length;
    cardIds().forEach(function (id) { S.cards[id].claimed = []; });
    normalize(); save();
    renderControls(); renderAll();
  }

  function buildPickers() {
    Object.keys(PRESETS).forEach(function (k) {
      var b = el('button', null, PRESETS[k].label);
      b.type = 'button'; b.dataset.key = k;
      b.addEventListener('click', function () {
        applyPreset(k);
        sflash(k === 'eigen' ? 'Leere Karte. Trag Name, Regel und Prämien ein.' : 'Vorlage „' + PRESETS[k].label + '“ übernommen.');
        if (k === 'eigen') $('fName').focus();
      });
      $('presets').appendChild(b);
    });
    ['restaurant', 'cafe', 'baeckerei', 'friseur'].forEach(function (k) {
      var b = el('button', null, PRESETS[k].label);
      b.type = 'button'; b.dataset.key = k;
      b.addEventListener('click', function () { applyPreset(k); });
      $('templates').appendChild(b);
    });
    Object.keys(INKS).forEach(function (k) {
      var b = el('button', 'swatch');
      b.type = 'button'; b.dataset.key = k;
      b.style.background = inkVar(k);
      b.setAttribute('aria-label', 'Stempelfarbe ' + INKS[k].label);
      b.title = INKS[k].label;
      b.addEventListener('click', function () { S.biz.ink = k; save(); renderControls(); renderAll(); });
      $('swatches').appendChild(b);
    });
  }

  // ---------- Meldungen ----------
  function setFlash(id, msg, isErr) {
    var n = $(id);
    n.textContent = msg || '';
    n.classList.toggle('err', !!isErr);
  }
  function kflash(msg, isErr) { setFlash('kFlash', msg, isErr); }
  function scanflash(msg, isErr) { setFlash('scanFlash', msg, isErr); }
  function sflash(msg, isErr) { setFlash('setupFlash', msg, isErr); }

  // ---------- Kasse ----------
  function setTab(t) {
    if (ui.tab === t) return;
    ui.tab = t;
    if (t !== 'stempeln') stopCamera();
    renderKasse();
  }

  function openCard(id, via) {
    if (!S.cards[id]) {
      scanflash('Karte ' + id + ' gibt es bei deinem Betrieb nicht. Prüfe die Nummer.', true);
      return false;
    }
    ui.openId = id;
    ui.amount = 1;
    if (ui.newId !== id) ui.newId = null;
    kflash(via === 'scan' ? 'Code erkannt.' : '');
    scanflash('');
    renderKasse();
    if (window.matchMedia && window.matchMedia('(max-width: 920px)').matches) {
      var p = $('kCardPanel');
      p.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      p.focus({ preventScroll: true });
    }
    return true;
  }

  // ---------- Kamera ----------
  var cam = { stream: null, raf: 0, last: 0, canvas: null, ctx: null, wanted: false, lastWrong: 0 };

  function camUi(on) {
    $('cam').hidden = !on;
    $('camStart').hidden = on;
    $('camStop').hidden = !on;
  }

  function startCamera() {
    if (cam.stream || cam.wanted) return;
    if (typeof jsQR !== 'function') { scanflash('Der Scanner konnte nicht geladen werden. Tippe die Kartennummer ein.', true); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      scanflash('Dieser Browser gibt die Kamera hier nicht frei. Wähle ein Foto vom Code oder tippe die Nummer ein.', true);
      return;
    }
    cam.wanted = true;
    scanflash('Kamera wird gestartet …');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (stream) {
        if (!cam.wanted) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        cam.stream = stream;
        var v = $('camVideo');
        v.srcObject = stream;
        camUi(true);
        return v.play().then(function () {
          scanflash('Halte den QR-Code des Gasts in den Rahmen.');
          cam.raf = requestAnimationFrame(tick);
        });
      })
      .catch(function (err) {
        var name = err && err.name;
        stopCamera();
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          scanflash('Der Kamerazugriff wurde nicht erlaubt. Erlaube ihn in den Browser-Einstellungen, wähle ein Foto oder tippe die Nummer ein.', true);
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          scanflash('Keine Kamera gefunden. Wähle ein Foto oder tippe die Nummer ein.', true);
        } else if (name === 'NotReadableError') {
          scanflash('Die Kamera wird gerade von einer anderen App benutzt. Schließe sie und versuch es noch einmal.', true);
        } else {
          scanflash('Die Kamera ließ sich nicht starten. Wähle ein Foto oder tippe die Nummer ein.', true);
        }
      });
  }

  function stopCamera() {
    cam.wanted = false;
    if (cam.raf) cancelAnimationFrame(cam.raf);
    cam.raf = 0;
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
    cam.stream = null;
    var v = $('camVideo');
    if (v) { try { v.pause(); } catch (e) { /* egal */ } v.srcObject = null; }
    camUi(false);
  }

  function tick(ts) {
    if (!cam.stream) return;
    cam.raf = requestAnimationFrame(tick);
    var v = $('camVideo');
    if (ts - cam.last < 160 || v.readyState < 2 || !v.videoWidth) return;
    cam.last = ts;
    var sc = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
    var w = Math.max(1, Math.round(v.videoWidth * sc)), h = Math.max(1, Math.round(v.videoHeight * sc));
    if (!cam.canvas) {
      cam.canvas = document.createElement('canvas');
      cam.ctx = cam.canvas.getContext('2d', { willReadFrequently: true });
    }
    if (cam.canvas.width !== w) cam.canvas.width = w;
    if (cam.canvas.height !== h) cam.canvas.height = h;
    cam.ctx.drawImage(v, 0, 0, w, h);
    var img = cam.ctx.getImageData(0, 0, w, h);
    var res = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (!res || !res.data) return;
    var id = parseCode(res.data);
    if (id) {
      stopCamera();
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* egal */ } }
      openCard(id, 'scan');
    } else if (ts - cam.lastWrong > 2500) {
      cam.lastWrong = ts;
      scanflash('Das ist kein Stempelei-Code. Halte den Code auf der Stempelkarte des Gasts in den Rahmen.', true);
    }
  }

  // Code aus einem Foto lesen
  function decodeFile(file) {
    return new Promise(function (resolve) {
      if (typeof jsQR !== 'function') { resolve({ err: 'lib' }); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var out;
        try {
          var sc = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var cx = cv.getContext('2d');
          cx.drawImage(img, 0, 0, w, h);
          var res = jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
          out = res ? { text: res.data } : { err: 'none' };
        } catch (e) { out = { err: 'img' }; }
        URL.revokeObjectURL(url);
        resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ err: 'img' }); };
      img.src = url;
    });
  }

  // ---------- Ereignisse ----------
  function bind() {
    // Startseite
    $('heroGive').addEventListener('click', function () {
      var r = give(S.me, 1); setFlash('heroFlash', r.msg, !r.ok); renderAll();
    });
    $('heroRedeem').addEventListener('click', function () {
      var av = available(S.cards[S.me]);
      if (!av.length) return;
      var r = redeem(S.me, av[0].id); setFlash('heroFlash', r.msg, !r.ok); renderAll();
    });
    $('heroUndo').addEventListener('click', function () {
      var r = undo(S.me); setFlash('heroFlash', r.msg, !r.ok); renderAll();
    });

    // Anmeldung
    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('loginCode').value.trim();
      if (v === ACCESS_CODE) {
        ui.authed = true;
        try { sessionStorage.setItem(AUTH_KEY, '1'); } catch (err) { /* egal */ }
        $('loginCode').value = '';
        setFlash('loginFlash', '');
        renderKasse();
        $('tab-' + ui.tab).focus();
      } else {
        setFlash('loginFlash', v ? 'Der Code stimmt nicht. Der Demo-Code ist 1234.' : 'Gib den vierstelligen Zugangscode ein.', true);
        $('loginCode').value = '';
        $('loginCode').focus();
      }
    });
    $('logout').addEventListener('click', function () {
      stopCamera();
      ui.authed = false; ui.openId = null; ui.newId = null;
      try { sessionStorage.removeItem(AUTH_KEY); } catch (err) { /* egal */ }
      renderKasse();
      $('loginCode').focus();
    });

    // Tabs mit Pfeiltasten
    var tabs = ['stempeln', 'einrichten', 'verlauf'];
    tabs.forEach(function (t, i) {
      var b = $('tab-' + t);
      b.addEventListener('click', function () { setTab(t); });
      b.addEventListener('keydown', function (e) {
        var j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        if (j === null) return;
        e.preventDefault();
        setTab(tabs[j]);
        $('tab-' + tabs[j]).focus();
      });
    });

    // Karte öffnen
    $('camStart').addEventListener('click', startCamera);
    $('camStop').addEventListener('click', function () { stopCamera(); scanflash(''); });
    $('numForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var raw = $('numInput').value;
      var id = parseCode(raw);
      if (!id) { scanflash('Die Kartennummer hat 4 Ziffern, zum Beispiel 0427.', true); return; }
      if (openCard(id)) $('numInput').value = '';
    });
    $('photoInput').addEventListener('change', function (e) {
      var input = e.target, f = input.files && input.files[0];
      if (!f) return;
      stopCamera();
      scanflash('Code wird gelesen …');
      decodeFile(f).then(function (res) {
        input.value = '';
        if (res.err === 'lib') { scanflash('Der Scanner konnte nicht geladen werden. Tippe die Kartennummer ein.', true); return; }
        if (res.err === 'img') { scanflash('Das Bild ließ sich nicht öffnen. Versuch ein anderes Foto.', true); return; }
        if (res.err) { scanflash('Kein Code erkannt. Geh näher ran, achte auf gutes Licht oder tippe die Nummer ein.', true); return; }
        var id = parseCode(res.text);
        if (!id) { scanflash('Das ist kein Stempelei-Code.', true); return; }
        openCard(id, 'scan');
      });
    });
    $('newCard').addEventListener('click', function () {
      var id = issueCard();
      if (!id) { scanflash('Die Demo hat schon ' + MAX_CARDS + ' Karten. Setze sie unter „Verlauf“ zurück.', true); return; }
      ui.newId = id;
      openCard(id);
      kflash('Karte ' + id + ' ist bereit für den ersten Stempel.');
      renderAll();
    });
    $('openDemo').addEventListener('click', function () { openCard(S.me); });
    $('kClose').addEventListener('click', function () {
      ui.openId = null; ui.newId = null; kflash(''); renderKasse(); $('camStart').focus();
    });

    // Stempel vergeben
    $('amtMinus').addEventListener('click', function () { ui.amount -= 1; renderKasse(); });
    $('amtPlus').addEventListener('click', function () { ui.amount += 1; renderKasse(); });
    $('amtInput').addEventListener('input', function (e) {
      var v = parseInt(e.target.value, 10);
      if (v >= 1) { ui.amount = v; renderKasse(); }
    });
    $('amtInput').addEventListener('blur', function () { renderKasse(); });
    $('kGive').addEventListener('click', function () {
      if (!ui.openId) return;
      var r = give(ui.openId, ui.amount);
      ui.amount = 1; ui.newId = null;
      $('amtInput').blur();
      kflash(r.msg, !r.ok);
      renderAll();
    });
    $('kUndo').addEventListener('click', function () {
      if (!ui.openId) return;
      var r = undo(ui.openId); kflash(r.msg, !r.ok); renderAll();
    });

    // Einstellungen
    $('fName').addEventListener('input', function (e) { S.biz.name = e.target.value; save(); renderAll(); });
    $('fEarn').addEventListener('input', function (e) { S.biz.earn = e.target.value; save(); renderAll(); });
    $('addReward').addEventListener('click', function () {
      if (S.biz.rewards.length >= MAX_REWARDS) return;
      S.biz.rewards.push({ id: S.biz.nextId++, at: Math.min(MAX_STAMPS, goal() + 2), text: '' });
      normalize(); save();
      renderRewardRows(true); renderAll();
    });

    // Demo zurücksetzen, mit Bestätigung im Knopf
    var resetTimer = 0;
    $('reset').addEventListener('click', function () {
      var b = $('reset');
      if (!ui.resetArmed) {
        ui.resetArmed = true;
        b.textContent = 'Wirklich zurücksetzen? Noch einmal tippen';
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () { ui.resetArmed = false; b.textContent = 'Demo zurücksetzen'; }, 4000);
        return;
      }
      clearTimeout(resetTimer);
      ui.resetArmed = false;
      b.textContent = 'Demo zurücksetzen';
      var biz = S.biz;
      S = defaults();
      S.biz = biz;   // Einstellungen der Karte bleiben, Karten und Verlauf werden neu angelegt
      normalize(); save();
      ui.openId = null; ui.newId = null;
      kflash('');
      renderAll();
    });

    // Andere Tabs desselben Browsers
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY) return;
      S = load();
      var form = $('setupForm');
      var editing = form && form.contains(document.activeElement);
      if (!editing) renderControls();
      renderAll();
    });

    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); });
  }

  // ---------- Ansichten ----------
  var VIEWS = ['start', 'preise', 'kasse', 'karte', 'impressum', 'datenschutz'];
  var TITLES = { start: 'Stempelei', preise: 'Stempelei Preise', kasse: 'Stempelei Kasse', karte: 'Stempelei Deine Karte', impressum: 'Stempelei Impressum', datenschutz: 'Stempelei Datenschutz' };
  var current = null;

  function route() {
    var key = (location.hash || '').replace(/^#/, '') || 'start';
    var m = /^karte(?:-(\d{4}))?$/.exec(key);
    if (m) { ui.guestId = m[1] || S.me; key = 'karte'; }
    if (VIEWS.indexOf(key) === -1) key = 'start';
    if (key !== 'kasse') stopCamera();
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== key; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (a) {
      if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = TITLES[key];
    if (key === 'karte') renderGuest();
    if (current !== null) window.scrollTo(0, 0);
    current = key;
  }

  // Ablauf auf der Startseite: das Bild rechts folgt der Stufe, die gerade in der Mitte steht.
  // Auf schmalen Bildschirmen steht jedes Objekt direkt unter seiner Stufe.
  function buildFlow() {
    var visual = $('flowVisual');
    var first = document.querySelector('[data-inline="1"]');
    if (first) first.appendChild(el('div')).setAttribute('data-card', 'flowm');
    ['2', '3'].forEach(function (n) {
      var src = visual.querySelector('[data-obj="' + n + '"] .slip');
      var dst = document.querySelector('[data-inline="' + n + '"]');
      if (src && dst) dst.appendChild(src.cloneNode(true));
    });
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) visual.dataset.active = e.target.dataset.stage; });
    }, { rootMargin: '-45% 0px -45% 0px' });
    Array.prototype.forEach.call(document.querySelectorAll('.flow-steps > li'), function (li) { io.observe(li); });
  }

  // ---------- Start ----------
  normalize();
  buildPickers();
  buildFlow();
  bind();
  renderControls();
  route();
  renderAll();
})();

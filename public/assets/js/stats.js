// Statistik für den Inhaber: Kennzahlen, Verlauf als Säulendiagramm (SVG), Stammgäste, Prämien.
// Ohne Bibliothek: Die Seite darf nur eigene Skripte laden (CSP). Texte aus der Datenbank nur als textContent.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (texts) => window.I18N.t(texts);
  const lang = () => (window.I18N.lang === 'en' ? 'en-GB' : 'de-DE');
  const SVG = 'http://www.w3.org/2000/svg';

  const MEASURES = {
    stamps: { de: 'Stempel', en: 'Stamps' },
    redeemed: { de: 'Einlösungen', en: 'Redemptions' },
    issued: { de: 'Neue Karten', en: 'New cards' },
  };
  const RANGE_NAMES = {
    '30d': { de: 'vorigen 30 Tagen', en: 'previous 30 days' },
    '90d': { de: 'vorigen 90 Tagen', en: 'previous 90 days' },
    '12m': { de: 'vorigen 12 Monaten', en: 'previous 12 months' },
  };

  let data = null;
  let range = '30d';
  let measure = 'stamps';
  let active = -1; // Säule mit Tooltip (Maus oder Tastatur)

  function say(text, kind) {
    $('flash').textContent = text;
    $('flash').classList.toggle('err', kind === 'err');
  }

  const num = (n, digits = 0) =>
    new Intl.NumberFormat(lang(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

  function bucketLabel(iso, long) {
    const d = new Date(`${iso}T12:00:00`);
    if (data.bucket === 'month') {
      return new Intl.DateTimeFormat(lang(), long ? { month: 'long', year: 'numeric' } : { month: 'short' }).format(d);
    }
    return new Intl.DateTimeFormat(lang(), long ? { weekday: 'short', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'numeric' }).format(d);
  }

  // ---------- Kennzahlen ----------
  function setTile(id, value, delta) {
    const tile = $(id);
    tile.querySelector('[data-value]').textContent = value;
    const d = tile.querySelector('[data-delta]');
    d.textContent = delta?.text ?? '';
    d.className = `kpi-delta${delta?.dir ? ` ${delta.dir}` : ''}`;
  }

  /** Veränderung zur Vorperiode. Mehr ist hier immer gut (mehr Stempel, mehr Einlösungen, mehr Karten). */
  function delta(now, before) {
    const vs = t({ de: `ggü. ${t(RANGE_NAMES[range])}`, en: `vs. ${t(RANGE_NAMES[range])}` });
    if (now === before) return { text: `± 0 ${vs}`, dir: '' };
    const up = now > before;
    const arrow = up ? '▲' : '▼';
    const change = before === 0 ? `${up ? '+' : '−'}${num(Math.abs(now - before))}` : `${up ? '+' : '−'}${num(Math.abs((now - before) / before) * 100)} %`;
    return { text: `${arrow} ${change} ${vs}`, dir: up ? 'up' : 'down' };
  }

  function renderKpis() {
    const { totals: n, previous: p, guests: g } = data;
    setTile('kStamps', num(n.stamps), delta(n.stamps, p.stamps));
    setTile('kRedeemed', num(n.redeemed), delta(n.redeemed, p.redeemed));
    setTile('kIssued', num(n.issued), delta(n.issued, p.issued));
    setTile('gActive', num(g.activeCards));
    const share = g.activeCards ? Math.round((g.returningCards / g.activeCards) * 100) : 0;
    setTile('gReturning', num(g.returningCards), {
      text: t({ de: `${share} % der aktiven Karten`, en: `${share} % of active cards` }),
      dir: '',
    });
    setTile('gAvg', num(g.avgVisits, 1));
    $('near').textContent = num(data.nearReward);
  }

  // ---------- Verlauf ----------
  /** Runde Schritte für die y-Achse: 1, 2, 5, 10, 20, 50 … */
  function niceStep(max) {
    const raw = Math.max(1, max) / 4;
    const pow = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return Math.max(1, m * pow);
    return 10 * pow;
  }

  function el(name, attrs) {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  /** Säule mit 4px runder Oberkante, unten eckig auf der Grundlinie. */
  function columnPath(x, y, w, h) {
    const r = Math.min(4, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function renderChart() {
    const box = $('chart');
    const rows = data.series;
    const values = rows.map((r) => r[measure]);
    const width = Math.max(280, box.clientWidth);
    const height = 240;
    const m = { top: 12, right: 8, bottom: 28, left: 40 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const step = niceStep(Math.max(...values));
    const top = Math.max(step, Math.ceil(Math.max(...values) / step) * step);
    const y = (v) => m.top + h - (v / top) * h;
    const band = w / rows.length;
    const barW = Math.max(2, Math.min(24, band - 2)); // 2px Luft zwischen Säulen, höchstens 24px breit

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', tabindex: 0, role: 'img' });
    const total = values.reduce((a, b) => a + b, 0);
    svg.setAttribute(
      'aria-label',
      t({
        de: `${t(MEASURES[measure])} pro ${data.bucket === 'month' ? 'Monat' : 'Tag'}, zusammen ${num(total)}. Mit den Pfeiltasten durch die Werte gehen.`,
        en: `${t(MEASURES[measure])} per ${data.bucket}, ${num(total)} in total. Use the arrow keys to step through the values.`,
      }),
    );

    // Gitterlinien und y-Achse
    for (let v = 0; v <= top; v += step) {
      svg.appendChild(el('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: 'grid' }));
      const label = el('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' });
      label.textContent = num(v);
      svg.appendChild(label);
    }
    // x-Achse: nur so viele Beschriftungen, wie nebeneinander passen
    const every = Math.max(1, Math.ceil(rows.length / Math.floor(w / 56)));
    rows.forEach((r, i) => {
      if ((rows.length - 1 - i) % every !== 0) return;
      const label = el('text', { x: m.left + band * i + band / 2, y: height - 8, 'text-anchor': 'middle', class: 'tick' });
      label.textContent = bucketLabel(r.date, false);
      svg.appendChild(label);
    });

    rows.forEach((r, i) => {
      const v = r[measure];
      const x = m.left + band * i + (band - barW) / 2;
      if (v > 0) {
        svg.appendChild(el('path', { d: columnPath(x, y(v), barW, y(0) - y(v)), class: `bar${i === active ? ' on' : ''}` }));
      }
      // Trefferfläche über die ganze Höhe des Bands, größer als die Säule
      const hit = el('rect', { x: m.left + band * i, y: m.top, width: band, height: h, class: 'hit', 'data-i': i });
      svg.appendChild(hit);
    });

    svg.addEventListener('pointermove', (e) => {
      const i = e.target.getAttribute?.('data-i');
      if (i !== null && i !== undefined) show(Number(i));
    });
    svg.addEventListener('pointerleave', () => show(-1));
    svg.addEventListener('focus', () => show(active >= 0 ? active : rows.length - 1));
    svg.addEventListener('blur', () => show(-1));
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = Math.min(rows.length - 1, Math.max(0, (active < 0 ? rows.length - 1 : active) + (e.key === 'ArrowRight' ? 1 : -1)));
        show(next);
      }
    });

    // Tooltip liegt im Diagramm-Container, seine Position wird relativ dazu berechnet
    box.replaceChildren(svg, $('tip'));
    $('chartTitle').textContent = t({
      de: `${t(MEASURES[measure])} pro ${data.bucket === 'month' ? 'Monat' : 'Tag'}`,
      en: `${t(MEASURES[measure])} per ${data.bucket}`,
    });

    function show(i) {
      active = i;
      for (const b of svg.querySelectorAll('.bar')) b.classList.remove('on');
      const tip = $('tip');
      if (i < 0) {
        tip.hidden = true;
        return;
      }
      const bars = [...svg.querySelectorAll('.hit')];
      // Säule hervorheben (nur wenn es eine gibt, bei 0 ist nichts gezeichnet)
      const v = rows[i][measure];
      if (v > 0) {
        const pathIndex = rows.slice(0, i + 1).filter((r) => r[measure] > 0).length - 1;
        svg.querySelectorAll('.bar')[pathIndex]?.classList.add('on');
      }
      const strong = document.createElement('strong');
      strong.textContent = num(v);
      const name = document.createElement('span');
      name.textContent = ` ${t(MEASURES[measure])}`;
      const when = document.createElement('span');
      when.className = 'tip-date';
      when.textContent = bucketLabel(rows[i].date, true);
      tip.replaceChildren(strong, name, when);
      tip.hidden = false;
      const hit = bars[i];
      const scale = box.clientWidth / width;
      const cx = (Number(hit.getAttribute('x')) + band / 2) * scale;
      const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), box.clientWidth - tip.offsetWidth);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y(Math.max(v, 0)) * scale - tip.offsetHeight - 8)}px`;
    }
  }

  function renderTable() {
    const table = $('table');
    const head = document.createElement('tr');
    for (const text of [t({ de: 'Zeitraum', en: 'Period' }), t(MEASURES.stamps), t(MEASURES.redeemed), t(MEASURES.issued)]) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    const tbody = document.createElement('tbody');
    for (const r of [...data.series].reverse()) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = bucketLabel(r.date, true);
      tr.appendChild(th);
      for (const v of [r.stamps, r.redeemed, r.issued]) {
        const td = document.createElement('td');
        td.className = 'fig';
        td.textContent = num(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.replaceChildren(thead, tbody);
  }

  // ---------- Prämien: Rangliste als waagerechte Balken ----------
  function renderRewards() {
    const list = $('rewards');
    list.replaceChildren();
    const max = Math.max(1, ...data.rewards.map((r) => r.redeemed));
    const programs = new Set(data.rewards.map((r) => r.program));
    if (!data.rewards.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = t({ de: 'Noch keine Prämien angelegt.', en: 'No rewards set up yet.' });
      list.appendChild(li);
      return;
    }
    for (const r of data.rewards) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'rank-label';
      label.textContent = r.text;
      const meta = document.createElement('small');
      meta.textContent = ` · ${t({ de: `${r.threshold} Stempel`, en: `${r.threshold} stamps` })}${programs.size > 1 ? ` · ${r.program}` : ''}`;
      label.appendChild(meta);
      const track = document.createElement('span');
      track.className = 'rank-track';
      const bar = document.createElement('span');
      bar.className = 'rank-bar';
      bar.style.width = `${(r.redeemed / max) * 100}%`;
      if (r.redeemed === 0) bar.hidden = true;
      const value = document.createElement('span');
      value.className = 'rank-value';
      value.textContent = num(r.redeemed);
      track.append(bar, value);
      li.append(label, track);
      list.appendChild(li);
    }
  }

  function render() {
    if (!data) return;
    const empty = !data.totals.stamps && !data.totals.redeemed && !data.totals.issued && !data.guests.activeCards;
    $('empty').hidden = !empty;
    renderKpis();
    renderChart();
    renderTable();
    renderRewards();
    // Zeiträume des Pakets
    for (const b of $('ranges').querySelectorAll('button')) {
      const ok = data.allowedRanges.includes(b.dataset.range);
      b.setAttribute('aria-pressed', String(b.dataset.range === range));
      b.classList.toggle('locked', !ok);
      b.title = ok ? '' : t({ de: 'Im Paket Groß', en: 'In the Large package' });
    }
    $('csv').hidden = !data.csv;
    $('csv').href = `/api/stats.csv?range=${range}`;
    $('planHint').hidden = data.csv;
  }

  async function load(next) {
    $('body').classList.add('loading'); // Der alte Stand bleibt sichtbar, bis der neue da ist
    let res;
    try {
      res = await fetch(`/api/stats?range=${next}`, { credentials: 'same-origin' });
    } catch {
      $('body').classList.remove('loading');
      return say(t({ de: 'Keine Verbindung. Prüf dein Internet.', en: 'No connection. Check your internet.' }), 'err');
    }
    $('body').classList.remove('loading');
    if (res.status === 401) return location.replace('/login');
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 && body.error === 'plan_feature') {
      $('planHint').hidden = false;
      return say(t({ de: 'Diese Auswertung gibt es im Paket Groß.', en: 'This report is included in the Large package.' }), 'err');
    }
    if (!res.ok) return say(t({ de: 'Die Zahlen ließen sich nicht laden.', en: 'The numbers could not be loaded.' }), 'err');
    say('');
    range = next;
    active = -1;
    data = body;
    render();
  }

  $('ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (b) load(b.dataset.range);
  });
  $('measures').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-measure]');
    if (!b) return;
    measure = b.dataset.measure;
    for (const x of $('measures').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    active = -1;
    renderChart();
  });
  window.I18N.onChange(render);
  new ResizeObserver(() => data && renderChart()).observe($('chart'));
  load('30d');
})();

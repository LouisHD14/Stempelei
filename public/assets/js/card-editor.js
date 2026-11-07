// Karte gestalten: Vorlagen, Name, Stempelregel, Farbe, Prämien, Live-Vorschau, Speichern.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (texts) => window.I18N.t(texts);
  const form = $('form');
  const flash = $('flash');
  const MAX_REWARDS = 5;
  const PREVIEW_STAMPS = 3;

  const INK_NAMES = {
    tinte: { de: 'Tinte', en: 'Ink' },
    blau: { de: 'Blau', en: 'Blue' },
    gruen: { de: 'Grün', en: 'Green' },
    koralle: { de: 'Koralle', en: 'Coral' },
  };

  // Vorlagen pro Branche. Texte in der Sprache, die beim Klick eingestellt ist.
  const TEMPLATES = [
    {
      label: { de: 'Restaurant', en: 'Restaurant' },
      earnRule: { de: 'jeden Besuch ab 10 €', en: 'every visit over €10' },
      ink: 'tinte',
      rewards: [
        [5, { de: 'Espresso aufs Haus', en: 'Free espresso' }],
        [10, { de: 'Dessert aufs Haus', en: 'Free dessert' }],
      ],
    },
    {
      label: { de: 'Café', en: 'Café' },
      earnRule: { de: 'jedes Heißgetränk', en: 'every hot drink' },
      ink: 'koralle',
      rewards: [[8, { de: 'Kaffee gratis', en: 'Free coffee' }]],
    },
    {
      label: { de: 'Bäckerei', en: 'Bakery' },
      earnRule: { de: 'jeden Einkauf ab 5 €', en: 'every purchase over €5' },
      ink: 'blau',
      rewards: [[10, { de: 'Brotlaib gratis', en: 'Free loaf of bread' }]],
    },
    {
      label: { de: 'Friseur', en: 'Hairdresser' },
      earnRule: { de: 'jeden Termin', en: 'every appointment' },
      ink: 'gruen',
      rewards: [[6, { de: 'Haarwäsche gratis', en: 'Free hair wash' }]],
    },
    {
      label: { de: 'Eisdiele', en: 'Ice cream' },
      earnRule: { de: 'jede Kugel', en: 'every scoop' },
      ink: 'koralle',
      rewards: [
        [6, { de: 'Waffel gratis', en: 'Free waffle' }],
        [12, { de: 'Becher gratis', en: 'Free sundae' }],
      ],
    },
  ];

  const MSG = {
    saved: { de: 'Gespeichert. Deine Gäste sehen die Karte ab sofort so.', en: 'Saved. Your guests see the card like this from now on.' },
    created: { de: 'Karte angelegt.', en: 'Card created.' },
    unsaved: { de: 'Nicht gespeicherte Änderungen', en: 'Unsaved changes' },
    name: { de: 'Bitte gib der Karte einen Namen.', en: 'Please give the card a name.' },
    rewardText: { de: 'Jede Prämie braucht einen Text.', en: 'Every reward needs a text.' },
    rewardThreshold: { de: 'Zwei Prämien dürfen nicht dieselbe Stempelzahl haben.', en: 'Two rewards cannot have the same number of stamps.' },
    rewardRange: { de: 'Die Stempelzahl muss zwischen 1 und 20 liegen.', en: 'The number of stamps must be between 1 and 20.' },
    noRewards: { de: 'Eine Karte braucht mindestens eine Prämie.', en: 'A card needs at least one reward.' },
    plan_limit: { de: 'Dein Paket erlaubt keine weitere Stempelkarte.', en: 'Your package does not allow another stamp card.' },
    failed: { de: 'Speichern hat nicht geklappt. Versuch es noch einmal.', en: 'Saving did not work. Please try again.' },
    offline: { de: 'Keine Verbindung. Prüf dein Internet.', en: 'No connection. Check your internet.' },
  };

  /** Aktuell bearbeitete Karte. id ist null für eine neue Karte. */
  let state = { id: null, name: '', earnRule: '', ink: 'tinte', rewards: [] };
  let programs = [];
  let limit = 1;
  let businessName = '';
  let dirty = false;

  function say(text, kind) {
    flash.textContent = text;
    flash.classList.toggle('err', kind === 'err');
    flash.classList.toggle('ok', kind === 'ok');
  }

  async function api(method, path, body) {
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch {
      return { ok: false, status: 0, data: {} };
    }
  }

  // ---------- Anzeige ----------
  function preview() {
    const card = window.StampCard.render(
      {
        name: state.name.trim() || businessName,
        earnRule: state.earnRule.trim(),
        ink: state.ink,
        rewards: state.rewards.filter((r) => r.text.trim() && r.threshold >= 1 && r.threshold <= 20),
        stamps: PREVIEW_STAMPS,
      },
      { status: true },
    );
    $('preview').replaceChildren(card);
  }

  function renderInks() {
    const box = $('inks');
    box.replaceChildren();
    for (const ink of window.StampCard.INKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = `var(--ink-${ink})`;
      b.setAttribute('aria-pressed', String(state.ink === ink));
      b.setAttribute('aria-label', t(INK_NAMES[ink]));
      b.title = t(INK_NAMES[ink]);
      b.addEventListener('click', () => {
        state.ink = ink;
        changed();
        renderInks();
      });
      box.appendChild(b);
    }
  }

  function renderTemplates() {
    const box = $('templates');
    box.replaceChildren();
    for (const tpl of TEMPLATES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(tpl.label);
      b.addEventListener('click', () => {
        state.earnRule = t(tpl.earnRule);
        state.ink = tpl.ink;
        // Vorhandene Prämien-IDs weiterverwenden, damit eingelöste Prämien zugeordnet bleiben
        const ids = state.rewards.map((r) => r.id).filter(Boolean);
        state.rewards = tpl.rewards.map(([threshold, text], i) => ({ id: ids[i], threshold, text: t(text) }));
        if (!state.name.trim()) state.name = businessName;
        fillForm();
        changed();
      });
      box.appendChild(b);
    }
  }

  function renderRewards() {
    const box = $('rewards');
    box.replaceChildren();
    state.rewards.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rrow';
      const n = document.createElement('input');
      n.type = 'number';
      n.min = '1';
      n.max = '20';
      n.inputMode = 'numeric';
      n.value = String(r.threshold);
      n.setAttribute('aria-label', t({ de: `Stempel für Prämie ${i + 1}`, en: `Stamps for reward ${i + 1}` }));
      n.addEventListener('input', () => {
        r.threshold = Number.parseInt(n.value, 10) || 0;
        changed();
      });
      const txt = document.createElement('input');
      txt.maxLength = 60;
      txt.value = r.text;
      txt.placeholder = t({ de: 'z. B. Kaffee gratis', en: 'e.g. Free coffee' });
      txt.setAttribute('aria-label', t({ de: `Text für Prämie ${i + 1}`, en: `Text for reward ${i + 1}` }));
      txt.addEventListener('input', () => {
        r.text = txt.value;
        changed();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--card';
      del.textContent = '×';
      del.disabled = state.rewards.length === 1;
      del.setAttribute('aria-label', t({ de: `Prämie ${i + 1} entfernen`, en: `Remove reward ${i + 1}` }));
      del.addEventListener('click', () => {
        state.rewards.splice(i, 1);
        renderRewards();
        changed();
      });
      row.append(n, txt, del);
      box.appendChild(row);
    });
    $('addReward').disabled = state.rewards.length >= MAX_REWARDS;
  }

  function renderPrograms() {
    const box = $('programTabs');
    box.replaceChildren();
    // Auswahl nur zeigen, wenn es mehr als eine Karte gibt oder eine weitere erlaubt ist
    const canAdd = limit === null || programs.length < limit;
    $('programs').hidden = programs.length <= 1 && !(programs.length === 1 && canAdd);
    $('addProgram').hidden = !canAdd || state.id === null;
    for (const prog of programs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = prog.name;
      b.setAttribute('aria-pressed', String(prog.id === state.id));
      b.addEventListener('click', () => load(prog));
      box.appendChild(b);
    }
  }

  function fillForm() {
    $('name').value = state.name;
    $('earnRule').value = state.earnRule;
    renderInks();
    renderRewards();
  }

  function changed() {
    dirty = true;
    preview();
  }

  function load(prog) {
    if (dirty && !window.confirm(t({ de: 'Änderungen verwerfen?', en: 'Discard changes?' }))) return;
    state = prog
      ? { id: prog.id, name: prog.name, earnRule: prog.earnRule, ink: prog.ink, rewards: prog.rewards.map((r) => ({ ...r })) }
      : { id: null, name: businessName, earnRule: '', ink: 'tinte', rewards: [{ threshold: 10, text: '' }] };
    dirty = false;
    fillForm();
    renderPrograms();
    preview();
    say('');
  }

  // ---------- Prüfen und Speichern ----------
  function problem() {
    if (!state.name.trim()) return ['name', $('name')];
    if (state.rewards.length === 0) return ['noRewards', null];
    const rows = $('rewards').querySelectorAll('.rrow');
    for (const [i, r] of state.rewards.entries()) {
      if (!Number.isInteger(r.threshold) || r.threshold < 1 || r.threshold > 20) return ['rewardRange', rows[i]?.children[0]];
      if (!r.text.trim()) return ['rewardText', rows[i]?.children[1]];
    }
    const seen = new Set();
    for (const [i, r] of state.rewards.entries()) {
      if (seen.has(r.threshold)) return ['rewardThreshold', rows[i]?.children[0]];
      seen.add(r.threshold);
    }
    return null;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
    const p = problem();
    if (p) {
      const [code, input] = p;
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
      return say(t(MSG[code]), 'err');
    }
    const payload = {
      name: state.name.trim(),
      earnRule: state.earnRule.trim(),
      ink: state.ink,
      rewards: state.rewards.map((r) => (r.id ? { id: r.id, threshold: r.threshold, text: r.text.trim() } : { threshold: r.threshold, text: r.text.trim() })),
    };
    $('save').disabled = true;
    const isNew = state.id === null;
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/programs' : `/api/programs/${state.id}`, payload);
    $('save').disabled = false;
    if (r.status === 401) return location.replace('/login');
    if (!r.ok) {
      const code = r.status === 0 ? 'offline' : MSG[r.data.error] ? r.data.error : MSG[r.data.field] ? r.data.field : 'failed';
      return say(t(MSG[code]), 'err');
    }
    const saved = r.data.program;
    programs = isNew ? [...programs, saved] : programs.map((x) => (x.id === saved.id ? saved : x));
    dirty = false;
    load(saved);
    say(t(isNew ? MSG.created : MSG.saved), 'ok');
    $('nextStep').hidden = false;
  });

  // ---------- Eingaben ----------
  $('name').addEventListener('input', (e) => {
    state.name = e.target.value;
    changed();
  });
  $('earnRule').addEventListener('input', (e) => {
    state.earnRule = e.target.value;
    changed();
  });
  $('addReward').addEventListener('click', () => {
    const max = Math.max(0, ...state.rewards.map((r) => r.threshold));
    state.rewards.push({ threshold: Math.min(20, max + 5), text: '' });
    renderRewards();
    changed();
    $('rewards').lastElementChild?.children[1]?.focus();
  });
  $('addProgram').addEventListener('click', () => load(null));
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });
  window.I18N.onChange(() => {
    renderTemplates();
    renderInks();
    renderRewards();
    preview();
  });

  // ---------- Start ----------
  (async () => {
    const [me, list] = await Promise.all([api('GET', '/api/auth/me'), api('GET', '/api/programs')]);
    if (me.status === 401 || list.status === 401) return location.replace('/login');
    if (!me.ok || !list.ok) return say(t(MSG.failed), 'err');
    businessName = me.data.business.name;
    programs = list.data.programs;
    limit = list.data.limit;
    renderTemplates();
    load(programs[0] ?? null);
    if (!programs.length) {
      say(t({ de: 'Wähle eine Vorlage oder trag deine eigenen Prämien ein.', en: 'Pick a template or enter your own rewards.' }));
    }
  })();
})();

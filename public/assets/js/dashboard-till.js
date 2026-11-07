// Kasse einrichten: Team mit PINs, Geräte freischalten und sperren, Kasse öffnen.
// Alle Listen werden aus dem Zustand neu gezeichnet, damit ein Sprachwechsel alles mitnimmt.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (texts) => window.I18N.t(texts);
  const PIN = /^[0-9]{4,6}$/;

  const MSG = {
    offline: { de: 'Keine Verbindung. Prüf dein Internet und versuch es noch einmal.', en: 'No connection. Check your internet and try again.' },
    failed: { de: 'Das hat nicht geklappt. Versuch es noch einmal.', en: 'That did not work. Please try again.' },
    forbidden: { de: 'Anfrage abgelehnt. Lade die Seite neu.', en: 'Request refused. Please reload the page.' },
    too_many_requests: { de: 'Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.', en: 'Too many attempts. Wait a few minutes and try again.' },
    not_found: { de: 'Das gibt es nicht mehr. Die Liste ist jetzt aktuell.', en: 'This no longer exists. The list is now up to date.' },
    plan_limit: { de: 'Dein Paket hat keinen freien Platz mehr im Team. Entferne eine Person oder wähle ein größeres Paket.', en: 'Your package has no free team seat left. Remove someone or choose a bigger package.' },
    pin_taken: { de: 'Diese PIN hat schon jemand im Team. Jede Person braucht ihre eigene PIN.', en: 'Someone on the team already has this PIN. Everyone needs their own PIN.' },
    field_name: { de: 'Der Name braucht 1 bis 40 Zeichen.', en: 'The name needs 1 to 40 characters.' },
    field_pin: { de: 'Die PIN besteht aus 4 bis 6 Ziffern.', en: 'The PIN consists of 4 to 6 digits.' },
  };

  /** Zustand der Seite. editPin/confirm merken, welche Zeile gerade ein Inline-Formular zeigt. */
  const state = {
    staff: [],
    limit: null,
    devices: [],
    editPin: null,
    confirmStaff: null,
    confirmDevice: null,
    pair: null, // { code, expiresAt: Date, known: Set der Geräte-IDs beim Erzeugen }
  };
  let timer = null;
  let poll = null;

  function errorText(r) {
    if (r.status === 0) return t(MSG.offline);
    // Feldmeldung nur bei Formatfehlern, sonst den genauen Fehlercode (z. B. pin_taken trägt auch field: 'pin')
    const code = r.data.error === 'bad_request' && r.data.field ? `field_${r.data.field}` : r.data.error;
    return t(MSG[code] ?? MSG.failed);
  }

  function say(el, text, kind) {
    el.textContent = text;
    el.classList.toggle('err', kind === 'err');
    el.classList.toggle('ok', kind === 'ok');
  }

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
    // Session abgelaufen: zurück zur Anmeldung statt halbe Seite
    if (res.status === 401) location.replace('/login');
    return { ok: res.ok, status: res.status, data };
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  const locale = () => (window.I18N.lang === 'en' ? 'en-GB' : 'de-DE');
  const dateTime = (iso) => new Date(iso).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });

  // ---------- Team ----------

  function renderLimit() {
    const n = state.staff.length;
    const full = state.limit !== null && n >= state.limit;
    $('staffLimit').textContent =
      state.limit === null
        ? t({ de: `${n} ${n === 1 ? 'Person' : 'Personen'}, unbegrenzt viele Plätze`, en: `${n} ${n === 1 ? 'person' : 'people'}, unlimited seats` })
        : t({ de: `${n} von ${state.limit} Plätzen belegt`, en: `${n} of ${state.limit} seats taken` }) +
          (full ? t({ de: '. Für mehr Personen brauchst du ein größeres Paket.', en: '. For more people you need a bigger package.' }) : '');
    // Volles Paket: Formular sperren, der Grund steht direkt darüber
    $('addStaffSet').disabled = full;
  }

  function renderStaff() {
    // Entwurf einer neuen PIN über das Neuzeichnen retten (Sprachwechsel)
    const draft = document.querySelector('#staffList input[name="newPin"]')?.value ?? '';
    const list = $('staffList');
    list.replaceChildren();
    if (state.staff.length === 0) {
      list.append(el('li', { class: 'tillset-empty muted', text: t({ de: 'Noch niemand im Team. Leg unten die erste Person an.', en: 'No one on the team yet. Add the first person below.' }) }));
    }
    for (const s of state.staff) {
      const row = el('li', { class: 'tillset-row' }, el('span', { class: 'tillset-name', text: s.name }));
      if (state.editPin === s.id) row.append(pinForm(s, draft));
      else if (state.confirmStaff === s.id) row.append(confirmBox(s.name, 'staff', s.id));
      else {
        row.append(
          el(
            'div',
            { class: 'actions' },
            el('button', { class: 'btn btn--card btn--s', type: 'button', 'data-focus': `pin-${s.id}`, text: t({ de: 'PIN ändern', en: 'Change PIN' }), 'aria-label': t({ de: `PIN ändern (${s.name})`, en: `Change PIN (${s.name})` }), onclick: () => openRow({ editPin: s.id }, renderStaff, `newPin-${s.id}`) }),
            el('button', { class: 'btn btn--card btn--s btn--danger', type: 'button', 'data-focus': `del-${s.id}`, text: t({ de: 'Entfernen', en: 'Remove' }), 'aria-label': t({ de: `Entfernen (${s.name})`, en: `Remove (${s.name})` }), onclick: () => openRow({ confirmStaff: s.id }, renderStaff, `yes-staff-${s.id}`) }),
          ),
        );
      }
      list.append(row);
    }
    renderLimit();
  }

  /** Öffnet ein Inline-Formular in einer Zeile und schließt alle anderen. */
  function openRow(patch, render, focusId) {
    // Ein angefangener PIN-Entwurf gehört nur zu seiner Zeile
    for (const input of document.querySelectorAll('#staffList input[name="newPin"]')) input.value = '';
    Object.assign(state, { editPin: null, confirmStaff: null, confirmDevice: null }, patch);
    render();
    if (render === renderStaff) renderDevices();
    else renderStaff();
    $(focusId)?.focus();
  }

  function closeRow(render, focusKey) {
    Object.assign(state, { editPin: null, confirmStaff: null, confirmDevice: null });
    render();
    document.querySelector(`[data-focus="${focusKey}"]`)?.focus();
  }

  function pinForm(s, draft) {
    const id = `newPin-${s.id}`;
    const form = el(
      'form',
      { class: 'tillset-inline', novalidate: '' },
      el('div', { class: 'field' }, el('label', { for: id, text: t({ de: `Neue PIN für ${s.name}`, en: `New PIN for ${s.name}` }) }), el('input', { id, name: 'newPin', type: 'password', inputmode: 'numeric', pattern: '[0-9]{4,6}', minlength: '4', maxlength: '6', required: '', autocomplete: 'new-password' })),
      el('div', { class: 'actions' }, el('button', { class: 'btn btn--ink btn--s', type: 'submit', text: t({ de: 'PIN speichern', en: 'Save PIN' }) }), el('button', { class: 'btn btn--card btn--s', type: 'button', text: t({ de: 'Abbrechen', en: 'Cancel' }), onclick: () => closeRow(renderStaff, `pin-${s.id}`) })),
    );
    form.querySelector('input').value = draft;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      input.removeAttribute('aria-invalid');
      if (!PIN.test(input.value)) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return say($('teamFlash'), t(MSG.field_pin), 'err');
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      const r = await api('PUT', `/api/staff/${encodeURIComponent(s.id)}/pin`, { pin: input.value });
      button.disabled = false;
      if (!r.ok) {
        say($('teamFlash'), errorText(r), 'err');
        if (r.status === 404) return loadStaff();
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      say($('teamFlash'), t({ de: `Neue PIN für ${s.name} gespeichert.`, en: `New PIN for ${s.name} saved.` }), 'ok');
      input.value = '';
      closeRow(renderStaff, `pin-${s.id}`);
    });
    return form;
  }

  /** Inline-Bestätigung statt window.confirm: Ja/Abbrechen in der Zeile. */
  function confirmBox(name, kind, id) {
    const isStaff = kind === 'staff';
    const render = isStaff ? renderStaff : renderDevices;
    const back = `del-${id}`;
    return el(
      'div',
      { class: 'tillset-confirm', role: 'group', 'aria-label': t({ de: 'Bestätigen', en: 'Confirm' }) },
      el('span', {
        text: isStaff
          ? t({ de: `${name} wirklich entfernen? Die PIN gilt dann nicht mehr.`, en: `Really remove ${name}? The PIN will stop working.` })
          : t({ de: `${name} wirklich sperren? Die Kasse auf diesem Gerät ist dann sofort zu.`, en: `Really block ${name}? The till on this device closes right away.` }),
      }),
      el(
        'div',
        { class: 'actions' },
        el('button', { id: `yes-${kind}-${id}`, class: 'btn btn--ink btn--s', type: 'button', text: isStaff ? t({ de: 'Ja, entfernen', en: 'Yes, remove' }) : t({ de: 'Ja, sperren', en: 'Yes, block' }), onclick: (e) => (isStaff ? removeStaff(id, name, e.currentTarget) : revokeDevice(id, name, e.currentTarget)) }),
        el('button', { class: 'btn btn--card btn--s', type: 'button', text: t({ de: 'Abbrechen', en: 'Cancel' }), onclick: () => closeRow(render, back) }),
      ),
    );
  }

  async function removeStaff(id, name, button) {
    button.disabled = true;
    const r = await api('DELETE', `/api/staff/${encodeURIComponent(id)}`);
    button.disabled = false;
    if (!r.ok && r.status !== 404) return say($('teamFlash'), errorText(r), 'err');
    state.confirmStaff = null;
    say($('teamFlash'), t({ de: `${name} ist nicht mehr im Team.`, en: `${name} is no longer on the team.` }), 'ok');
    await loadStaff();
    $('staffName').focus();
  }

  async function loadStaff() {
    const r = await api('GET', '/api/staff');
    if (!r.ok) return say($('teamFlash'), errorText(r), 'err');
    state.staff = r.data.staff;
    state.limit = r.data.limit ?? null;
    renderStaff();
  }

  $('addStaff').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('staffName');
    const pin = $('staffPin');
    for (const input of [name, pin]) input.removeAttribute('aria-invalid');
    let problem = null;
    if (!name.value.trim() || name.value.trim().length > 40) problem = [name, MSG.field_name];
    else if (!PIN.test(pin.value)) problem = [pin, MSG.field_pin];
    if (problem) {
      problem[0].setAttribute('aria-invalid', 'true');
      problem[0].focus();
      return say($('teamFlash'), t(problem[1]), 'err');
    }
    $('addStaffBtn').disabled = true;
    const r = await api('POST', '/api/staff', { name: name.value.trim(), pin: pin.value });
    $('addStaffBtn').disabled = false;
    if (!r.ok) {
      say($('teamFlash'), errorText(r), 'err');
      const bad = r.data.error === 'pin_taken' || r.data.field === 'pin' ? pin : r.data.field === 'name' ? name : null;
      bad?.setAttribute('aria-invalid', 'true');
      bad?.focus();
      if (r.data.error === 'plan_limit') loadStaff();
      return;
    }
    say($('teamFlash'), t({ de: `${r.data.staff.name} ist im Team. Die PIN gilt ab sofort an der Kasse.`, en: `${r.data.staff.name} is on the team. The PIN works at the till right away.` }), 'ok');
    name.value = '';
    pin.value = '';
    await loadStaff();
    // Nächste Person direkt eintippen, solange Platz ist
    if (!$('addStaffSet').disabled) name.focus();
    else $('h-team').focus();
  });

  // ---------- Geräte ----------

  function renderDevices() {
    const list = $('deviceList');
    list.replaceChildren();
    if (state.devices.length === 0) {
      list.append(el('li', { class: 'tillset-empty muted', text: t({ de: 'Noch kein Gerät freigeschaltet.', en: 'No device approved yet.' }) }));
    }
    for (const d of state.devices) {
      const seen = d.lastSeenAt
        ? t({ de: `Zuletzt benutzt: ${dateTime(d.lastSeenAt)}`, en: `Last used: ${dateTime(d.lastSeenAt)}` })
        : t({ de: `Freigeschaltet: ${dateTime(d.createdAt)}, noch nicht benutzt`, en: `Approved: ${dateTime(d.createdAt)}, not used yet` });
      const row = el('li', { class: 'tillset-row' }, el('span', { class: 'tillset-name' }, el('span', { text: d.name }), el('small', { class: 'muted', text: seen })));
      if (state.confirmDevice === d.id) row.append(confirmBox(d.name, 'device', d.id));
      else {
        row.append(el('div', { class: 'actions' }, el('button', { class: 'btn btn--card btn--s btn--danger', type: 'button', 'data-focus': `del-${d.id}`, text: t({ de: 'Sperren', en: 'Block' }), 'aria-label': t({ de: `Sperren (${d.name})`, en: `Block (${d.name})` }), onclick: () => openRow({ confirmDevice: d.id }, renderDevices, `yes-device-${d.id}`) })));
      }
      list.append(row);
    }
  }

  async function revokeDevice(id, name, button) {
    button.disabled = true;
    const r = await api('DELETE', `/api/devices/${encodeURIComponent(id)}`);
    button.disabled = false;
    if (!r.ok && r.status !== 404) return say($('deviceFlash'), errorText(r), 'err');
    state.confirmDevice = null;
    say($('deviceFlash'), t({ de: `${name} ist gesperrt.`, en: `${name} is blocked.` }), 'ok');
    await loadDevices();
    $('pairBtn').focus();
  }

  async function loadDevices() {
    const r = await api('GET', '/api/devices');
    if (!r.ok) {
      say($('deviceFlash'), errorText(r), 'err');
      return false;
    }
    state.devices = r.data.devices;
    renderDevices();
    return true;
  }

  function stopPair() {
    clearInterval(timer);
    clearInterval(poll);
    timer = poll = null;
    state.pair = null;
    $('pairBox').hidden = true;
    renderPairButton();
  }

  function renderPairButton() {
    $('pairBtn').textContent = state.pair ? t({ de: 'Neuen Code erzeugen', en: 'Create a new code' }) : t({ de: 'Gerät freischalten', en: 'Approve a device' });
  }

  function renderPair() {
    renderPairButton();
    if (!state.pair) return;
    const { code, expiresAt } = state.pair;
    // In zwei Vierergruppen, damit man ihn leichter abtippt
    $('pairCode').textContent = `${code.slice(0, 4)} ${code.slice(4)}`;
    $('pairHow').textContent = t({
      de: `Öffne auf dem Tablet oder Handy ${location.origin}/till und gib dort diesen Code ein. Der Code gilt nur einmal.`,
      en: `On the tablet or phone, open ${location.origin}/till and enter this code there. The code works only once.`,
    });
    // Code nur im Fragment: landet nicht in Server-Logs oder im Referer
    $('useHere').href = `/till#code=${encodeURIComponent(code)}`;
    const left = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('pairTimer').textContent = t({ de: `Noch ${mmss} gültig`, en: `Valid for another ${mmss}` });
    if (left === 0) {
      stopPair();
      say($('deviceFlash'), t({ de: 'Der Code ist abgelaufen. Erzeug bei Bedarf einen neuen.', en: 'The code has expired. Create a new one if you need it.' }), 'err');
      $('pairBtn').focus();
    }
  }

  $('pairBtn').addEventListener('click', async () => {
    $('pairBtn').disabled = true;
    const r = await api('POST', '/api/devices/pairing-code', {});
    $('pairBtn').disabled = false;
    if (!r.ok) return say($('deviceFlash'), errorText(r), 'err');
    clearInterval(timer);
    clearInterval(poll);
    state.pair = { code: String(r.data.code), expiresAt: new Date(r.data.expiresAt), known: new Set(state.devices.map((d) => d.id)) };
    $('pairBox').hidden = false;
    renderPair();
    say($('deviceFlash'), t({ de: 'Code erzeugt. Er gilt 10 Minuten.', en: 'Code created. It is valid for 10 minutes.' }), 'ok');
    $('pairCode').focus();
    timer = setInterval(renderPair, 1000);
    // shortcut: fragt alle 5 s nach neuen Geräten, solange ein Code offen ist; bei vielen Inhabern gleichzeitig auf Live-Push umstellen
    poll = setInterval(async () => {
      if (!state.pair || document.hidden) return;
      const known = state.pair.known;
      if (!(await loadDevices())) return;
      const added = state.devices.find((d) => !known.has(d.id));
      if (added) {
        stopPair();
        say($('deviceFlash'), t({ de: `${added.name} ist freigeschaltet. Dort kann sich dein Team jetzt mit der PIN anmelden.`, en: `${added.name} is approved. Your team can now log in there with their PIN.` }), 'ok');
        $('pairBtn').focus();
      }
    }, 5000);
  });

  // ---------- Start ----------

  async function init() {
    const me = await api('GET', '/api/auth/me');
    if (me.status === 401) return;
    if (!me.ok) return say($('flash'), errorText(me), 'err');
    await Promise.all([loadStaff(), loadDevices()]);
    for (const id of ['team', 'devices', 'open']) $(id).hidden = false;
    $('h-team').tabIndex = -1;
  }

  window.I18N.onChange(() => {
    renderStaff();
    renderDevices();
    renderPair();
  });

  init();
})();

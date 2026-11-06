// Konto-Seiten: Registrieren, Anmelden, E-Mail bestätigen, Passwort zurücksetzen, Konto.
// Jede Seite setzt data-page am <body>, das Skript erledigt den Rest.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const flash = $('flash');
  const page = document.body.dataset.page;

  function say(text, kind) {
    flash.textContent = text;
    flash.classList.toggle('err', kind === 'err');
    flash.classList.toggle('ok', kind === 'ok');
  }

  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch {
      return { ok: false, status: 0, data: { message: 'Keine Verbindung. Prüf dein Internet und versuch es noch einmal.' } };
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) data.message = 'Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.';
    return { ok: res.ok, status: res.status, data };
  }

  /** Fehlermeldungen der Schema-Prüfung sind technisch, deshalb prüfen wir vorher selbst. */
  function check(form) {
    for (const input of form.querySelectorAll('input')) {
      input.removeAttribute('aria-invalid');
      // tooShort meldet der Browser nur nach Eingabe per Tastatur, nicht bei Autofill. Deshalb selbst zählen.
      const short = input.minLength > 0 && input.value.length > 0 && input.value.length < input.minLength;
      if (short || !input.checkValidity()) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        const label = form.querySelector(`label[for="${input.id}"]`)?.textContent ?? 'Feld';
        if (input.validity.valueMissing) return `Bitte fülle „${label}“ aus.`;
        if (input.validity.typeMismatch) return 'Bitte gib eine gültige E-Mail-Adresse ein.';
        if (short) return `„${label}“ braucht mindestens ${input.minLength} Zeichen.`;
        return `Bitte prüfe „${label}“.`;
      }
    }
    return null;
  }

  function onSubmit(handler) {
    const form = $('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = check(form);
      if (problem) return say(problem, 'err');
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      say('');
      try {
        await handler(Object.fromEntries(new FormData(form)));
      } finally {
        button.disabled = false;
      }
    });
  }

  /** Das Token steht hinter # im Link, so landet es nicht in Server-Logs. */
  function tokenFromLink() {
    const t = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname);
    return t;
  }

  const pages = {
    registrieren() {
      onSubmit(async (v) => {
        const r = await api('/api/auth/register', v);
        if (!r.ok) return say(r.data.message ?? 'Das hat nicht geklappt.', 'err');
        $('form').hidden = true;
        say(`Fast geschafft: Wir haben dir eine E-Mail an ${v.email} geschickt. Klick auf den Link darin, um dein Konto zu bestätigen.`, 'ok');
      });
    },

    anmelden() {
      const resend = $('resend');
      onSubmit(async (v) => {
        resend.hidden = true;
        const r = await api('/api/auth/login', v);
        if (r.ok) return location.assign('/konto');
        if (r.data.error === 'email_not_verified') resend.hidden = false;
        say(r.data.message ?? 'Das hat nicht geklappt.', 'err');
      });
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        const r = await api('/api/auth/verify/resend', { email: $('email').value });
        resend.disabled = false;
        say(r.ok ? 'Wir haben dir einen neuen Link geschickt.' : r.data.message, r.ok ? 'ok' : 'err');
      });
    },

    async bestaetigen() {
      const t = tokenFromLink();
      if (!t) return ($('lead').textContent = 'In diesem Link fehlt etwas. Öffne ihn bitte direkt aus der E-Mail.');
      const r = await api('/api/auth/verify', { token: t });
      $('lead').textContent = r.ok ? 'Danke, deine E-Mail-Adresse ist bestätigt. Du bist angemeldet.' : r.data.message;
      $('next').hidden = !r.ok;
    },

    'passwort-vergessen'() {
      onSubmit(async (v) => {
        const r = await api('/api/auth/password-reset/request', v);
        if (!r.ok) return say(r.data.message ?? 'Das hat nicht geklappt.', 'err');
        say(`Wenn es ein Konto für ${v.email} gibt, ist der Link unterwegs. Er gilt eine Stunde.`, 'ok');
      });
    },

    'passwort-neu'() {
      const t = tokenFromLink();
      if (!t) {
        $('form').hidden = true;
        return say('In diesem Link fehlt etwas. Öffne ihn bitte direkt aus der E-Mail.', 'err');
      }
      onSubmit(async (v) => {
        const r = await api('/api/auth/password-reset/confirm', { token: t, password: v.password });
        if (!r.ok) return say(r.data.message ?? 'Das hat nicht geklappt.', 'err');
        $('form').hidden = true;
        $('next').hidden = false;
        say('Dein neues Passwort ist gespeichert. Alle Geräte wurden abgemeldet.', 'ok');
      });
    },

    async konto() {
      const r = await api('/api/auth/me');
      if (r.status === 401) return location.replace('/anmelden');
      if (!r.ok) return say(r.data.message ?? 'Das Konto ließ sich nicht laden.', 'err');
      const { user, business } = r.data;
      const plans = { klein: 'Klein', mittel: 'Mittel', gross: 'Groß' };
      const until = new Date(business.trialEndsAt).toLocaleDateString('de-DE');
      $('bizName').textContent = business.name;
      $('userEmail').textContent = user.email;
      $('plan').textContent =
        business.subscriptionStatus === 'trialing'
          ? `${plans[business.plan]}, kostenlos getestet bis ${until}`
          : plans[business.plan];
      $('facts').hidden = false;
      $('logout').addEventListener('click', async () => {
        await api('/api/auth/logout', {});
        location.assign('/anmelden');
      });
    },
  };

  pages[page]?.();
})();

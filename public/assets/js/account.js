// Konto-Seiten und Dashboard. Jede Seite setzt data-page am <body>, das Skript erledigt den Rest.
// Texte kommen über I18N.t({ de, en }) aus i18n.js.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (texts) => window.I18N.t(texts);
  const flash = $('flash');
  const page = document.body.dataset.page;

  const MSG = {
    offline: { de: 'Keine Verbindung. Prüf dein Internet und versuch es noch einmal.', en: 'No connection. Check your internet and try again.' },
    failed: { de: 'Das hat nicht geklappt. Versuch es noch einmal.', en: 'That did not work. Please try again.' },
    too_many_requests: { de: 'Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.', en: 'Too many attempts. Wait a few minutes and try again.' },
    invalid_credentials: { de: 'E-Mail-Adresse oder Passwort stimmen nicht.', en: 'Email address or password is incorrect.' },
    email_not_verified: { de: 'Bitte bestätige zuerst deine E-Mail-Adresse. Den Link findest du in deinem Postfach.', en: 'Please confirm your email address first. You will find the link in your inbox.' },
    invalid_token: { de: 'Dieser Link ist abgelaufen oder wurde schon benutzt.', en: 'This link has expired or has already been used.' },
    forbidden: { de: 'Anfrage abgelehnt. Lade die Seite neu.', en: 'Request refused. Please reload the page.' },
    field_email: { de: 'Bitte gib eine gültige E-Mail-Adresse ein.', en: 'Please enter a valid email address.' },
    field_password: { de: 'Das Passwort braucht mindestens 10 Zeichen.', en: 'The password needs at least 10 characters.' },
    field_businessName: { de: 'Der Name des Betriebs braucht 2 bis 80 Zeichen.', en: 'The business name needs 2 to 80 characters.' },
    field_token: { de: 'Dieser Link ist ungültig. Öffne ihn bitte direkt aus der E-Mail.', en: 'This link is invalid. Please open it directly from the email.' },
    missing_token: { de: 'In diesem Link fehlt etwas. Öffne ihn bitte direkt aus der E-Mail.', en: 'Something is missing in this link. Please open it directly from the email.' },
  };

  /** Fehlertext aus dem Fehlercode der API, in der Sprache der Seite. */
  function errorText(r) {
    if (r.status === 0) return t(MSG.offline);
    const code = r.data.field ? `field_${r.data.field}` : r.data.error;
    return t(MSG[code] ?? MSG.failed);
  }

  function say(text, kind) {
    if (!flash) return;
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
      return { ok: false, status: 0, data: {} };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  /** Prüft das Formular vor dem Absenden, mit verständlichen Meldungen. */
  function check(form) {
    for (const input of form.querySelectorAll('input')) {
      input.removeAttribute('aria-invalid');
      // tooShort meldet der Browser nur nach Eingabe per Tastatur, nicht bei Autofill. Deshalb selbst zählen.
      const short = input.minLength > 0 && input.value.length > 0 && input.value.length < input.minLength;
      if (short || !input.checkValidity()) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        const label = form.querySelector(`label[for="${input.id}"]`)?.textContent ?? '';
        if (input.validity.valueMissing) return t({ de: `Bitte fülle „${label}“ aus.`, en: `Please fill in “${label}”.` });
        if (input.validity.typeMismatch) return t(MSG.field_email);
        if (short) {
          return t({ de: `„${label}“ braucht mindestens ${input.minLength} Zeichen.`, en: `“${label}” needs at least ${input.minLength} characters.` });
        }
        return t({ de: `Bitte prüfe „${label}“.`, en: `Please check “${label}”.` });
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
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname);
    return token;
  }

  /** Wer schon angemeldet ist, braucht Anmelden und Registrieren nicht. */
  async function skipIfLoggedIn() {
    const r = await api('/api/auth/me');
    if (r.ok) location.replace('/dashboard');
  }

  const pages = {
    register() {
      skipIfLoggedIn();
      onSubmit(async (v) => {
        const r = await api('/api/auth/register', { ...v, locale: window.I18N.lang });
        if (!r.ok) return say(errorText(r), 'err');
        $('form').hidden = true;
        say(
          t({
            de: `Fast geschafft: Wir haben dir eine E-Mail an ${v.email} geschickt. Klick auf den Link darin, um dein Konto zu bestätigen.`,
            en: `Almost done: we sent an email to ${v.email}. Click the link in it to confirm your account.`,
          }),
          'ok',
        );
      });
    },

    login() {
      skipIfLoggedIn();
      const resend = $('resend');
      onSubmit(async (v) => {
        resend.hidden = true;
        const r = await api('/api/auth/login', v);
        if (r.ok) return location.assign('/dashboard');
        if (r.data.error === 'email_not_verified') resend.hidden = false;
        say(errorText(r), 'err');
      });
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        const r = await api('/api/auth/verify/resend', { email: $('email').value, locale: window.I18N.lang });
        resend.disabled = false;
        say(r.ok ? t({ de: 'Wir haben dir einen neuen Link geschickt.', en: 'We sent you a new link.' }) : errorText(r), r.ok ? 'ok' : 'err');
      });
    },

    async verify() {
      const token = tokenFromLink();
      if (!token) return say(t(MSG.missing_token), 'err');
      const r = await api('/api/auth/verify', { token });
      $('lead').hidden = true;
      if (!r.ok) return say(errorText(r), 'err');
      say(t({ de: 'Danke, deine E-Mail-Adresse ist bestätigt. Du bist angemeldet.', en: 'Thanks, your email address is confirmed. You are logged in.' }), 'ok');
      $('next').hidden = false;
    },

    'forgot-password'() {
      onSubmit(async (v) => {
        const r = await api('/api/auth/password-reset/request', { ...v, locale: window.I18N.lang });
        if (!r.ok) return say(errorText(r), 'err');
        say(
          t({
            de: `Wenn es ein Konto für ${v.email} gibt, ist der Link unterwegs. Er gilt eine Stunde.`,
            en: `If there is an account for ${v.email}, the link is on its way. It is valid for one hour.`,
          }),
          'ok',
        );
      });
    },

    'reset-password'() {
      const token = tokenFromLink();
      if (!token) {
        $('form').hidden = true;
        return say(t(MSG.missing_token), 'err');
      }
      onSubmit(async (v) => {
        const r = await api('/api/auth/password-reset/confirm', { token, password: v.password });
        if (!r.ok) return say(errorText(r), 'err');
        $('form').hidden = true;
        $('next').hidden = false;
        say(t({ de: 'Dein neues Passwort ist gespeichert. Alle Geräte wurden abgemeldet.', en: 'Your new password is saved. All devices have been logged out.' }), 'ok');
      });
    },

    async dashboard() {
      const r = await api('/api/auth/me');
      if (r.status === 401) return location.replace('/login');
      if (!r.ok) return say(errorText(r), 'err');
      const { user, business, steps } = r.data;
      const done = {
        'step-account': true,
        'step-card': steps.cardDesigned,
        'step-till': steps.tillSetUp,
        'step-first': steps.firstCardIssued,
        'step-plan': steps.planChosen,
      };
      const ids = Object.keys(done);
      const next = ids.find((id) => !done[id]);
      const PLANS = { klein: { de: 'Klein', en: 'Small' }, mittel: { de: 'Mittel', en: 'Medium' }, gross: { de: 'Groß', en: 'Large' } };

      function render() {
        $('bizName').textContent = business.name;
        $('factBiz').textContent = business.name;
        $('factEmail').textContent = user.email;
        const until = new Date(business.trialEndsAt);
        const days = Math.max(0, Math.ceil((until.getTime() - Date.now()) / 86_400_000));
        const date = until.toLocaleDateString(window.I18N.lang === 'en' ? 'en-GB' : 'de-DE');
        const trialing = business.subscriptionStatus === 'trialing';
        $('trial').textContent = trialing
          ? t({
              de: `Testphase: noch ${days} ${days === 1 ? 'Tag' : 'Tage'}, bis ${date}.`,
              en: `Trial: ${days} ${days === 1 ? 'day' : 'days'} left, until ${date}.`,
            })
          : '';
        $('factPlan').textContent = trialing
          ? t({ de: `Testphase bis ${date}`, en: `Trial until ${date}` })
          : t(PLANS[business.plan] ?? PLANS.klein);
        const count = ids.filter((id) => done[id]).length;
        $('progress').textContent = t({ de: `${count} von ${ids.length} erledigt`, en: `${count} of ${ids.length} done` });
        for (const id of ids) {
          const li = $(id);
          li.classList.toggle('done', done[id]);
          li.classList.toggle('next', id === next);
          li.querySelector('[data-state]').textContent = done[id] ? t({ de: 'Erledigt', en: 'Done' }) : '';
          li.querySelector('.check-mark').textContent = done[id] ? '✓' : String(ids.indexOf(id) + 1);
          if (id === next) li.setAttribute('aria-current', 'step');
          else li.removeAttribute('aria-current');
        }
      }
      render();
      window.I18N.onChange(render);
    },
  };

  // Abmelden gibt es im Kopf aller angemeldeten Seiten
  $('logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', {});
    location.assign('/login');
  });

  pages[page]?.();
})();

/* Promocje: zamykanie paska, licznik do rzeczywistej daty końca, formularz newslettera. */
(function () {
  'use strict';

  /* ---------- Pasek kampanii ---------- */
  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-promo-bar-close]');
    if (!close) return;
    const bar = close.closest('[data-promo-bar]');
    if (!bar) return;
    const key = bar.dataset.promoBar;
    const until = Number(bar.dataset.promoBarUntil || 0);
    const now = Math.floor(Date.now() / 1000);
    const maxAge = Math.min(until > now ? until - now : 30 * 86400, 60 * 86400);
    const current = (document.cookie.match(/(?:^|;\s*)mcs_promo_bar_off=([^;]*)/) || [])[1] || '';
    const keys = decodeURIComponent(current).split(',').filter(Boolean).filter((k) => k !== key);
    keys.push(key);
    const value = encodeURIComponent(keys.slice(-5).join(','));
    document.cookie = 'mcs_promo_bar_off=' + value + '; path=/; max-age=' + maxAge + '; SameSite=Lax';
    bar.remove();
  });

  /* ---------- Licznik ---------- */
  document.querySelectorAll('[data-promo-countdown]').forEach((box) => {
    const end = Number(box.dataset.promoCountdown);
    const serverNow = Number(box.dataset.promoNow);
    if (!end || !serverNow) return;
    // Czas serwera, żeby zły zegar w urządzeniu nie zmieniał daty końca.
    const skew = serverNow * 1000 - Date.now();
    const pad = (n) => String(n).padStart(2, '0');
    const parts = {};
    box.querySelectorAll('[data-unit]').forEach((n) => { parts[n.dataset.unit] = n; });
    const done = box.querySelector('[data-promo-countdown-done]');
    let timer = null;
    const tick = () => {
      const left = Math.floor((end * 1000 - (Date.now() + skew)) / 1000);
      if (left < 0) {
        clearInterval(timer);
        box.classList.add('is-over');
        if (done) done.hidden = false;
        return;
      }
      if (parts.d) parts.d.textContent = pad(Math.floor(left / 86400));
      if (parts.h) parts.h.textContent = pad(Math.floor(left / 3600) % 24);
      if (parts.m) parts.m.textContent = pad(Math.floor(left / 60) % 60);
      if (parts.s) parts.s.textContent = pad(left % 60);
    };
    tick();
    timer = setInterval(tick, 1000);
  });

  /* ---------- Newsletter ---------- */
  const say = (form, text, type) => {
    const box = form.querySelector('[data-nl-message]');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
    box.classList.toggle('nl-form__msg--ok', type === 'ok');
    box.classList.toggle('nl-form__msg--err', type === 'err');
  };

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-newsletter]');
    if (!form || !window.MCS || !window.MCS.api) return;
    e.preventDefault();
    const email = form.querySelector('input[name=email]');
    const consent = form.querySelector('input[name=consent]');
    const button = form.querySelector('button[type=submit]');
    if (email && !email.value.trim()) {
      say(form, 'Wpisz adres e-mail.', 'err');
      email.setAttribute('aria-invalid', 'true');
      email.focus();
      return;
    }
    if (email && !email.checkValidity()) {
      say(form, 'To nie wygląda na poprawny adres e-mail.', 'err');
      email.setAttribute('aria-invalid', 'true');
      email.focus();
      return;
    }
    if (email) email.removeAttribute('aria-invalid');
    if (consent && !consent.checked) {
      say(form, 'Aby się zapisać, zaznacz zgodę na otrzymywanie newslettera.', 'err');
      consent.focus();
      return;
    }
    if (button) button.classList.add('is-loading');
    try {
      const hp = form.querySelector('input[name=mcs_website]');
      const data = await window.MCS.api('newsletter/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          email: email ? email.value.trim() : '',
          consent: consent && consent.checked ? 1 : 0,
          context: (form.querySelector('input[name=context]') || {}).value || '',
          mcs_website: hp ? hp.value : '',
        }),
      });
      say(form, data.message || 'Sprawdź skrzynkę e-mail i potwierdź zapis.', 'ok');
      form.classList.add('is-done');
      form.reset();
    } catch (err) {
      say(form, err.message || 'Nie udało się wysłać formularza. Spróbuj ponownie za chwilę.', 'err');
    } finally {
      if (button) button.classList.remove('is-loading');
    }
  });
})();

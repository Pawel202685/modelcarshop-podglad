/* Strony informacyjne: wyszukiwarka prezentów i formularz kontaktowy. */
(function () {
  'use strict';
  const M = window.MCS || {};

  /* ---------- Wyszukiwarka prezentów ---------- */
  const gift = document.querySelector('[data-gift]');
  if (gift) initGift(gift);

  function initGift(form) {
    const steps = [...form.querySelectorAll('[data-gift-step]')];
    const nav = form.querySelector('[data-gift-steps]');
    const prev = form.querySelector('[data-gift-prev]');
    const submit = form.querySelector('[data-gift-submit]');
    const live = form.querySelector('[data-gift-live]');
    const reset = form.querySelector('[data-gift-reset]');
    const results = document.querySelector('[data-gift-results]');
    const keys = steps.map((s) => s.dataset.giftStep);
    let current = 0;
    let requestId = 0;
    let advanceTimer = 0;
    let pointerInput = false;

    form.classList.add('is-stepper');
    if (nav) nav.hidden = false;

    const answers = () => {
      const out = {};
      keys.forEach((key) => {
        const checked = form.querySelector(`input[name="${key}"]:checked`);
        if (checked) out[key] = checked.value;
      });
      return out;
    };

    const syncNav = () => {
      const state = answers();
      form.querySelectorAll('[data-gift-goto]').forEach((btn) => {
        const key = btn.dataset.giftGoto;
        const index = keys.indexOf(key);
        const li = btn.closest('li');
        li.classList.toggle('is-current', index === current);
        li.classList.toggle('is-done', key in state);
        if (index === current) btn.setAttribute('aria-current', 'step');
        else btn.removeAttribute('aria-current');
        const value = form.querySelector(`[data-gift-value="${key}"]`);
        const checked = form.querySelector(`input[name="${key}"]:checked`);
        if (value) value.textContent = checked ? checked.dataset.label : '';
      });
      if (reset) reset.hidden = Object.keys(state).length === 0;
    };

    const show = (index, focus) => {
      current = Math.max(0, Math.min(steps.length - 1, index));
      steps.forEach((step, i) => {
        step.hidden = i !== current;
        step.classList.toggle('is-entering', i === current);
      });
      if (prev) prev.hidden = current === 0;
      if (submit) submit.textContent = current === steps.length - 1 ? 'Zobacz propozycje' : 'Dalej';
      syncNav();
      if (focus) {
        const target = steps[current].querySelector('input:checked') || steps[current].querySelector('input');
        if (target) target.focus({ preventScroll: true });
      }
    };

    const stateUrl = () => {
      const params = new URLSearchParams(answers());
      const base = form.getAttribute('action');
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    };

    const renderHtml = (html) => {
      // Odpowiedź pochodzi z własnego szablonu; DOMParser nie uruchamia skryptów.
      const doc = new DOMParser().parseFromString(html, 'text/html');
      results.replaceChildren(...doc.body.childNodes);
    };

    const refresh = async () => {
      const state = answers();
      const id = ++requestId;
      history.replaceState(null, '', stateUrl());
      if (!Object.keys(state).length) {
        results.hidden = true;
        results.replaceChildren();
        if (live) live.textContent = '';
        return true;
      }
      results.setAttribute('aria-busy', 'true');
      results.classList.add('is-loading');
      try {
        const data = await M.api('gift?' + new URLSearchParams(state).toString());
        if (id !== requestId) return;
        renderHtml(data.html);
        results.hidden = false;
        if (live) live.textContent = data.total > 0 ? `Pasuje: ${data.label}` : 'Brak modeli w tym budżecie';
        return true;
      } catch (err) {
        if (id !== requestId) return false;
        if (live) live.textContent = 'Nie udało się odświeżyć wyników. Spróbuj jeszcze raz.';
        if (M.toast) M.toast(err.message || 'Nie udało się pobrać propozycji.', { type: 'error' });
        return false;
      } finally {
        if (id === requestId) {
          results.removeAttribute('aria-busy');
          results.classList.remove('is-loading');
        }
      }
    };

    const goToResults = () => {
      results.hidden = false;
      const title = results.querySelector('[data-gift-results-title]');
      results.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (title) title.focus({ preventScroll: true });
    };

    form.addEventListener('change', (e) => {
      if (e.target.type !== 'radio') return;
      syncNav();
      refresh();
      clearTimeout(advanceTimer);
      const index = keys.indexOf(e.target.name);
      // Strzałki zmieniają wybór od razu, więc automatycznie przechodzimy dalej tylko po kliknięciu.
      if (pointerInput && index === current && current < steps.length - 1) {
        advanceTimer = window.setTimeout(() => show(current + 1, true), 260);
      }
    });

    form.addEventListener('pointerdown', () => {
      pointerInput = true;
    });
    form.addEventListener('keydown', () => {
      pointerInput = false;
    });

    form.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-gift-goto]');
      if (goto) {
        clearTimeout(advanceTimer);
        show(keys.indexOf(goto.dataset.giftGoto), true);
      }
    });

    if (prev) {
      prev.addEventListener('click', () => {
        clearTimeout(advanceTimer);
        show(current - 1, true);
      });
    }

    if (reset) {
      reset.addEventListener('click', (e) => {
        e.preventDefault();
        form.querySelectorAll('input:checked').forEach((input) => {
          input.checked = false;
        });
        clearTimeout(advanceTimer);
        show(0, true);
        refresh();
      });
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearTimeout(advanceTimer);
      if (current < steps.length - 1) {
        show(current + 1, true);
        return;
      }
      if (!Object.keys(answers()).length) {
        if (live) live.textContent = 'Wybierz co najmniej jedną odpowiedź.';
        show(0, true);
        return;
      }
      // Gdy API zawiedzie, zostaje zwykłe przejście na adres z odpowiedziami (działa bez JS).
      refresh().then((ok) => {
        if (ok) goToResults();
        else window.location.href = stateUrl();
      });
    });

    // Start: pierwsze pytanie bez odpowiedzi (także po wejściu z linku).
    const state = answers();
    const firstOpen = keys.findIndex((key) => !(key in state));
    show(firstOpen === -1 ? steps.length - 1 : firstOpen, false);
    if (Object.keys(state).length && live) {
      const count = results.querySelector('[data-gift-results-title] em');
      if (count) live.textContent = `Pasuje: ${count.textContent}`;
    }
  }

  /* ---------- Formularz kontaktowy ---------- */
  const contact = document.querySelector('[data-contact-form]');
  if (contact) {
    const topic = contact.querySelector('#kontakt-temat');
    const order = contact.querySelector('[data-contact-order]');
    const orderInput = order && order.querySelector('input');
    const syncOrder = () => {
      if (!order) return;
      const relevant = topic && ['zamowienie', 'zwrot'].includes(topic.value);
      order.hidden = !relevant && !(orderInput && orderInput.value);
    };
    if (topic) {
      topic.addEventListener('change', syncOrder);
      syncOrder();
    }

    contact.addEventListener('submit', () => {
      const button = contact.querySelector('.contact-submit');
      if (button) {
        button.classList.add('is-loading');
        button.setAttribute('aria-busy', 'true');
      }
    });

    const invalid = contact.querySelector('[aria-invalid="true"]');
    if (invalid) invalid.focus();
  }

  const sent = document.querySelector('[data-contact-sent]');
  if (sent) sent.focus({ preventScroll: true });
})();

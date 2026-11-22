/* Lista życzeń (przełączniki, licznik, strona listy) i formularz powiadomienia o dostępności. */
(function () {
  'use strict';
  const M = window.MCS;
  if (!M || !M.api) return;

  /* Znacznik bez danych: gość ma listę, więc warto pytać serwer o jej stan. */
  const FLAG = 'mcs_wl_used';
  const flag = {
    get() {
      try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; }
    },
    set(on) {
      try {
        if (on) localStorage.setItem(FLAG, '1');
        else localStorage.removeItem(FLAG);
      } catch (e) { /* tryb prywatny */ }
    },
  };

  const plural = (n, one, few, many) => {
    if (n === 1) return one;
    const u = n % 10;
    const t = n % 100;
    return u >= 2 && u <= 4 && (t < 12 || t > 14) ? few : many;
  };

  const friendly = (err) => (err && err.status === 403 ? 'Sesja wygasła. Odśwież stronę i spróbuj ponownie.' : err.message);

  let ids = new Set([...document.querySelectorAll('[data-wish][aria-pressed="true"]')].map((b) => Number(b.dataset.wish)));

  function paint() {
    document.querySelectorAll('.js-wishlist-count').forEach((el) => {
      el.textContent = String(ids.size);
      el.dataset.count = String(ids.size);
    });
    document.querySelectorAll('[data-wish]').forEach((btn) => {
      btn.setAttribute('aria-pressed', ids.has(Number(btn.dataset.wish)) ? 'true' : 'false');
    });
  }

  document.addEventListener('mcs:catalog-updated', paint);

  function apply(data) {
    if (!data || !Array.isArray(data.ids)) return;
    ids = new Set(data.ids.map(Number));
    flag.set(ids.size > 0);
    paint();
  }

  async function sync() {
    /* Strona listy z pozycjami zawsze pyta serwer, co odbudowuje znacznik po wyczyszczeniu danych strony. */
    if (!M.loggedIn && !flag.get() && !document.querySelector('[data-wl-item]')) return;
    try {
      apply(await M.api('wishlist'));
    } catch (err) {
      /* Licznik to dodatek: błąd nie przeszkadza w zakupach. */
    }
  }

  async function change(id, add) {
    return add
      ? M.api('wishlist/items', { method: 'POST', body: JSON.stringify({ product_id: id }) })
      : M.api('wishlist/items/' + id, { method: 'DELETE' });
  }

  async function toggle(btn) {
    const id = Number(btn.dataset.wish);
    if (!id || btn.classList.contains('is-busy')) return;
    const add = !ids.has(id);
    btn.classList.add('is-busy');
    btn.setAttribute('aria-pressed', add ? 'true' : 'false');
    try {
      apply(await change(id, add));
      btn.classList.add('is-pop');
      setTimeout(() => btn.classList.remove('is-pop'), 340);
      if (add) {
        M.toast('Zapisano na liście życzeń', { href: wishlistUrl(), label: 'Zobacz listę' });
      } else {
        M.toast('Usunięto z listy życzeń');
        leaveList(id);
      }
    } catch (err) {
      btn.setAttribute('aria-pressed', add ? 'false' : 'true');
      M.toast(friendly(err), { type: 'error' });
    } finally {
      btn.classList.remove('is-busy');
    }
  }

  function wishlistUrl() {
    const link = document.querySelector('.header-actions a[href*="lista-zyczen"]');
    return link ? link.href : M.home + 'lista-zyczen/';
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-wish]');
    if (!btn) return;
    e.preventDefault();
    toggle(btn);
  });

  /* ---------- Strona listy ---------- */
  const summary = document.querySelector('[data-wl-summary]');
  const emptyBox = document.querySelector('[data-wl-empty]');
  const actions = document.querySelector('[data-wl-actions]');
  const addAll = document.querySelector('[data-wl-add-all]');
  const addLabel = document.querySelector('[data-wl-add-label]');

  function buyable() {
    return [...document.querySelectorAll('[data-wl-item][data-wl-buyable]:not(.is-leaving)')];
  }

  function refreshPage() {
    if (!emptyBox) return;
    const items = document.querySelectorAll('[data-wl-item]:not(.is-leaving)');
    const count = items.length;
    const countEl = document.querySelector('[data-wl-count]');
    const wordEl = document.querySelector('[data-wl-word]');
    if (countEl) countEl.textContent = String(count);
    if (wordEl) wordEl.textContent = plural(count, 'model', 'modele', 'modeli');
    if (summary) summary.hidden = count === 0;
    emptyBox.hidden = count !== 0;
    const note = document.querySelector('[data-wl-note]');
    if (note && count === 0) note.hidden = true;
    const available = buyable().length;
    if (actions) actions.hidden = available === 0;
    if (addLabel) addLabel.textContent = 'Dodaj dostępne do koszyka (' + available + ')';
  }

  function leaveList(id) {
    const item = document.querySelector('[data-wl-item="' + id + '"]');
    if (!item) return;
    const hadFocus = item.contains(document.activeElement);
    item.classList.add('is-leaving');
    refreshPage();
    setTimeout(() => {
      const neighbour = item.nextElementSibling || item.previousElementSibling;
      item.remove();
      const grid = document.querySelector('[data-wl-grid]');
      if (grid && !grid.children.length) grid.remove();
      /* Fokus nie może zniknąć razem z kartą. */
      if (hadFocus) {
        const target = (neighbour && neighbour.querySelector('[data-wl-remove]')) || (emptyBox && emptyBox.querySelector('a'));
        if (target) target.focus();
      }
    }, 260);
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-wl-remove]');
    if (!btn) return;
    const id = Number(btn.dataset.wlRemove);
    btn.disabled = true;
    try {
      apply(await change(id, false));
      M.toast('Usunięto z listy życzeń');
      leaveList(id);
    } catch (err) {
      btn.disabled = false;
      M.toast(friendly(err), { type: 'error' });
    }
  });

  if (addAll) {
    addAll.addEventListener('click', async () => {
      const items = buyable();
      if (!items.length) return;
      addAll.disabled = true;
      addAll.setAttribute('aria-busy', 'true');
      let added = 0;
      let failed = 0;
      /* Kolejno, bo równoległe zapisy sesji WooCommerce mogłyby zgubić pozycje. */
      for (let i = 0; i < items.length; i += 1) {
        addLabel.textContent = 'Dodajemy ' + (i + 1) + ' z ' + items.length + '…';
        try {
          await M.addToCart(items[i].dataset.wlItem, 1);
          added += 1;
        } catch (err) {
          failed += 1;
        }
      }
      addAll.disabled = false;
      addAll.removeAttribute('aria-busy');
      refreshPage();
      if (added) {
        M.toast('Dodano do koszyka: ' + added + ' ' + plural(added, 'model', 'modele', 'modeli'), { href: M.cartUrl, label: 'Przejdź do koszyka' });
      }
      if (failed) {
        M.toast('Nie udało się dodać: ' + failed + ' ' + plural(failed, 'model', 'modele', 'modeli') + '. Sprawdź dostępność.', { type: 'error', ms: 8000 });
      }
    });
  }

  /* ---------- Powiadomienie o dostępności ---------- */
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-restock-form]');
    if (!form) return;
    e.preventDefault();
    const root = form.closest('[data-restock]');
    const error = form.querySelector('[data-restock-error]');
    const email = form.querySelector('input[name="email"]');
    const consent = form.querySelector('input[name="consent"]');
    const submit = form.querySelector('button[type="submit"]');

    const showError = (message, field) => {
      error.textContent = message;
      error.hidden = false;
      if (field) field.focus();
    };
    error.hidden = true;

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) {
      showError('Podaj poprawny adres e-mail.', email);
      return;
    }
    if (!consent.checked) {
      showError('Zaznacz zgodę, abyśmy mogli wysłać powiadomienie.', consent);
      return;
    }

    submit.classList.add('is-loading');
    submit.disabled = true;
    try {
      const res = await M.api('restock', {
        method: 'POST',
        body: JSON.stringify({
          product_id: Number(form.elements.product_id.value),
          email: email ? email.value.trim() : '',
          consent: true,
          mcs_website: form.elements.mcs_website ? form.elements.mcs_website.value : '',
        }),
      });
      const done = root.querySelector('[data-restock-done]');
      root.querySelector('[data-restock-message]').textContent = res.message;
      form.hidden = true;
      done.hidden = false;
      done.focus();
    } catch (err) {
      showError(friendly(err));
    } finally {
      submit.classList.remove('is-loading');
      submit.disabled = false;
    }
  });

  /* Wypisanie: przeglądarka wysyła formularz sama, skaner poczty bez JavaScriptu nie. */
  const auto = document.querySelector('[data-restock-auto]');
  if (auto) auto.submit();

  /* Stan z serwera (zalogowani) zostaje na ekranie, dopóki nie przyjdzie odpowiedź. */
  sync();
})();

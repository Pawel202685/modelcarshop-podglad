/* Katalog: filtrowanie bez przeładowania strony. Bez JavaScriptu działają zwykłe linki i formularz GET. */
(function () {
  'use strict';

  const root = document.querySelector('[data-shop]');
  if (!root) return;
  const M = window.MCS || {};
  const form = root.querySelector('[data-shop-form]');
  const main = root.querySelector('.shop-main');
  const drawer = document.getElementById('shop-filters');
  const live = root.querySelector('[data-shop-live]');
  const desktop = window.matchMedia('(min-width: 1000px)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  document.documentElement.classList.add('js');

  const regions = {
    hero: root.querySelector('[data-shop-region="hero"]'),
    chips: root.querySelector('[data-shop-region="chips"]'),
    results: root.querySelector('[data-shop-region="results"]'),
  };

  /* ---------- Wysokość przyklejonego nagłówka ---------- */
  const header = document.querySelector('.site-header');
  function measure() {
    if (!header) return;
    const top = parseFloat(getComputedStyle(header).top) || 0;
    root.style.setProperty('--shop-top', Math.round(header.offsetHeight + top) + 'px');
  }
  measure();
  window.addEventListener('resize', measure, { passive: true });
  if ('ResizeObserver' in window && header) new ResizeObserver(measure).observe(header);

  /* ---------- Panel: na telefonie jest oknem dialogowym, na komputerze zwykłą kolumną ---------- */
  function syncDrawerRole() {
    if (!drawer) return;
    if (desktop.matches) {
      drawer.removeAttribute('role');
      drawer.removeAttribute('aria-modal');
      drawer.inert = false;
      if (drawer.classList.contains('is-open')) {
        drawer.classList.remove('is-open');
        if (!document.querySelector('.drawer.is-open, .modal.is-open')) document.body.classList.remove('is-locked');
      }
    } else {
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      if (!drawer.classList.contains('is-open')) drawer.inert = true;
    }
  }
  syncDrawerRole();
  desktop.addEventListener('change', syncDrawerRole);

  // Adres z kotwicą panelu (wersja bez JavaScriptu) otwiera go przez wspólne API.
  if (location.hash === '#shop-filters' && drawer) {
    history.replaceState(null, '', location.pathname + location.search);
    if (!desktop.matches && M.openLayer) M.openLayer(drawer);
  }

  /* ---------- Budowa adresu z formularza ---------- */
  function formUrl() {
    const data = new FormData(form);
    const params = new URLSearchParams();
    const lists = {};
    data.forEach((value, key) => {
      const text = String(value).trim();
      if (text === '') return;
      if (key.endsWith('[]')) {
        const name = key.slice(0, -2);
        (lists[name] = lists[name] || []).push(text);
      } else {
        params.set(key, text);
      }
    });
    Object.keys(lists).forEach((name) => params.set(name, lists[name].join(',')));
    const sort = root.querySelector('[data-shop-sort]');
    if (sort) params.set('sort', sort.value);
    const url = new URL(form.getAttribute('action'), location.href);
    url.search = params.toString();
    return url.toString();
  }

  /* ---------- Pobieranie i podmiana fragmentów ---------- */
  let controller = null;
  let sequence = 0;

  function setBusy(busy) {
    main.classList.toggle('is-loading', busy);
    regions.results.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function swap(el, html) {
    if (!el) return;
    const doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
    el.replaceChildren(...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true)));
  }

  function syncFacets(data) {
    Object.keys(data.facets).forEach((key) => {
      const group = form.querySelector('[data-facet="' + key + '"]');
      if (!group) return;
      const info = data.facets[key];
      group.querySelectorAll('[data-facet-opt]').forEach((label) => {
        const state = info.options[label.dataset.facetOpt];
        if (!state) return;
        const input = label.querySelector('input');
        const count = label.querySelector('[data-count]');
        const active = !!state[1];
        input.checked = active;
        const empty = state[0] === 0 && !active;
        input.disabled = empty;
        label.classList.toggle('is-empty', empty);
        if (count) count.textContent = state[0];
      });
      const badge = group.querySelector('[data-facet-badge]');
      if (badge) {
        badge.textContent = info.selected;
        badge.hidden = !info.selected;
      }
    });

    const price = data.price;
    const from = form.querySelector('[data-price-from]');
    const to = form.querySelector('[data-price-to]');
    if (from && document.activeElement !== from) from.value = price.from === null ? '' : price.from;
    if (to && document.activeElement !== to) to.value = price.to === null ? '' : price.to;
    if (from) from.placeholder = price.min;
    if (to) to.placeholder = price.max;
    syncRange();
  }

  function applyPayload(data, push) {
    swap(regions.hero, data.html.hero);
    swap(regions.chips, data.html.chips);
    swap(regions.results, data.html.results);
    syncFacets(data);
    restoreWishlist();

    const total = root.querySelector('[data-shop-total]');
    if (total) total.textContent = data.label;
    const apply = form.querySelector('[data-shop-apply]');
    if (apply) apply.textContent = 'Pokaż ' + data.label;
    const clear = form.querySelector('[data-shop-clear]');
    if (clear) {
      clear.hidden = !data.filters;
      clear.setAttribute('href', data.clear_url);
    }
    const badge = root.querySelector('[data-shop-filter-count]');
    if (badge) {
      badge.textContent = data.filters;
      badge.hidden = !data.filters;
    }
    const sortBox = root.querySelector('[data-shop-sortbox]');
    if (sortBox) sortBox.hidden = data.total === 0;
    const sort = root.querySelector('[data-shop-sort]');
    if (sort) {
      const missing = !Array.from(sort.options).some((o) => o.value === data.sort);
      if (missing || sort.options.length !== Object.keys(data.sort_options).length) {
        sort.replaceChildren(...Object.keys(data.sort_options).map((value) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = data.sort_options[value];
          return option;
        }));
      }
      sort.value = data.sort;
    }
    form.setAttribute('action', data.base_url);
    syncHidden(data);
    const searchInput = document.getElementById('site-search');
    if (searchInput && document.activeElement !== searchInput) searchInput.value = data.state.q || '';
    document.title = data.title;
    if (live) live.textContent = 'Wyniki: ' + data.label;
    if (push) history.pushState({ mcsShop: true }, '', data.url);
    else history.replaceState({ mcsShop: true }, '', data.url);
    document.dispatchEvent(new CustomEvent('mcs:catalog-updated', { detail: { total: data.total, url: data.url } }));
  }

  /*
   * Listę życzeń gościa serwer zna, ale karty renderuje bez jej stanu (uzupełnia go wishlist.js przy wczytaniu).
   * Po podmianie wyników odtwarzamy serduszka tym samym zapytaniem i tylko u gości, którzy mają listę.
   */
  function restoreWishlist() {
    if (M.loggedIn || !M.api || !regions.results.querySelector('[data-wish]')) return;
    let used = false;
    try {
      used = localStorage.getItem('mcs_wl_used') === '1';
    } catch (e) {
      return;
    }
    if (!used) return;
    M.api('wishlist')
      .then((data) => {
        const ids = new Set((data && Array.isArray(data.ids) ? data.ids : []).map(Number));
        regions.results.querySelectorAll('[data-wish]').forEach((btn) => {
          btn.setAttribute('aria-pressed', ids.has(Number(btn.dataset.wish)) ? 'true' : 'false');
        });
      })
      .catch(() => {});
  }

  /* Ukryte pola formularza (zapytanie, kolekcja, nowości) podążają za stanem z serwera. */
  function syncHidden(data) {
    form.querySelectorAll('input[type=hidden]:not([name=f])').forEach((n) => n.remove());
    const add = (name, value) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.prepend(input);
    };
    if (data.state.q) add('q', data.state.q);
    (data.state.kolekcja || []).forEach((slug) => add('kolekcja[]', slug));
    if (data.state.nowosci) add('nowosci', '1');
    if (data.state.promocje) add('promocje', '1');
  }

  function load(url, opts = {}) {
    const push = opts.push !== false;
    const target = new URL(url, location.href);
    target.searchParams.set('_mcs', '1');
    const mine = ++sequence;
    if (controller) controller.abort();
    controller = new AbortController();
    setBusy(true);

    return fetch(target.toString(), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then((res) => {
        const fallback = Object.assign(new Error('http'), { fallback: true });
        if (!res.ok) throw fallback;
        return res.json().catch(() => {
          throw fallback;
        });
      })
      .then((data) => {
        if (mine !== sequence) return;
        applyPayload(data, push);
        setBusy(false);
        if (opts.scroll) scrollToResults();
        else keepResultsInView();
        // Kliknięty link zniknął razem z fragmentem: fokus wraca na początek wyników.
        if (opts.refocus) main.focus({ preventScroll: true });
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (mine !== sequence) return;
        setBusy(false);
        if (err && err.fallback) {
          location.assign(url);
          return;
        }
        if (M.toast) M.toast('Nie udało się odświeżyć wyników. Sprawdź połączenie.', { type: 'error', href: url, label: 'Spróbuj ponownie', ms: 8000 });
      });
  }

  function scrollToResults() {
    const top = main.getBoundingClientRect().top + window.scrollY - (parseFloat(root.style.getPropertyValue('--shop-top')) || 0) - 8;
    window.scrollTo({ top, behavior: reduced.matches ? 'auto' : 'smooth' });
  }

  function keepResultsInView() {
    if (drawer && drawer.classList.contains('is-open')) return;
    const offset = (parseFloat(root.style.getPropertyValue('--shop-top')) || 0) + 8;
    if (main.getBoundingClientRect().top < offset - 200) scrollToResults();
  }

  /* ---------- Zdarzenia ---------- */
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-facet-search]') || t.matches('[data-price-low], [data-price-high]')) return;
    load(formUrl());
  });

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-shop-sort]')) load(formUrl(), { scroll: true });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (drawer && drawer.classList.contains('is-open') && M.closeLayer) {
      M.closeLayer(drawer);
      scrollToResults();
    }
    load(formUrl());
  });

  root.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-shop-link]');
    if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    load(link.href, { scroll: link.hasAttribute('data-shop-scroll'), refocus: true });
  });

  window.addEventListener('popstate', () => {
    load(location.href, { push: false });
  });

  history.replaceState({ mcsShop: true }, '', location.href);

  /* ---------- Wyszukiwanie wewnątrz długich list ---------- */
  function fold(text) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ł/g, 'l');
  }

  form.querySelectorAll('[data-facet-search-wrap]').forEach((wrap) => {
    wrap.hidden = false;
    const group = wrap.closest('[data-facet]');
    const input = wrap.querySelector('[data-facet-search]');
    const more = group.querySelector('[data-facet-more]');
    const none = group.querySelector('[data-facet-none]');
    const labels = group.querySelectorAll('[data-facet-opt]');
    input.addEventListener('input', () => {
      const q = fold(input.value.trim());
      let shown = 0;
      labels.forEach((label) => {
        const text = fold(label.querySelector('.facet-opt__label').textContent);
        const match = !q || text.includes(q);
        label.classList.toggle('is-filtered-out', !match);
        if (match) shown++;
      });
      if (more) more.open = q !== '' ? true : more.open;
      if (none) none.hidden = shown > 0;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
  });

  /* ---------- Zakres ceny: suwak jako dodatek do pól liczbowych ---------- */
  const priceBox = form.querySelector('[data-price]');
  let syncRange = () => {};
  if (priceBox) {
    const range = priceBox.querySelector('[data-price-range]');
    const low = priceBox.querySelector('[data-price-low]');
    const high = priceBox.querySelector('[data-price-high]');
    const fill = priceBox.querySelector('[data-price-fill]');
    const from = priceBox.querySelector('[data-price-from]');
    const to = priceBox.querySelector('[data-price-to]');
    const min = Number(priceBox.dataset.min);
    const max = Number(priceBox.dataset.max);

    if (max > min) {
      range.hidden = false;
      syncRange = () => {
        const lo = from.value === '' ? min : Math.max(min, Math.min(max, Number(from.value)));
        const hi = to.value === '' ? max : Math.max(min, Math.min(max, Number(to.value)));
        low.value = lo;
        high.value = hi;
        fill.style.left = ((lo - min) / (max - min)) * 100 + '%';
        fill.style.right = 100 - ((hi - min) / (max - min)) * 100 + '%';
      };
      const onInput = (e) => {
        let lo = Number(low.value);
        let hi = Number(high.value);
        if (lo > hi) {
          if (e.target === low) lo = hi;
          else hi = lo;
          low.value = lo;
          high.value = hi;
        }
        from.value = lo <= min ? '' : lo;
        to.value = hi >= max ? '' : hi;
        fill.style.left = ((lo - min) / (max - min)) * 100 + '%';
        fill.style.right = 100 - ((hi - min) / (max - min)) * 100 + '%';
      };
      low.addEventListener('input', onInput);
      high.addEventListener('input', onInput);
      [low, high].forEach((n) => n.addEventListener('change', () => load(formUrl())));
      [from, to].forEach((n) => n.addEventListener('input', syncRange));
      syncRange();
    }
  }
})();

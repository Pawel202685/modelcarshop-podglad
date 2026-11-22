/* Strona główna: zakładki przeglądania, budżet i wyszukiwarka w nagłówku po przewinięciu. */
(function () {
  'use strict';

  /* ---------- Zakładki „Przeglądaj” ---------- */
  document.querySelectorAll('[data-tabs]').forEach((root) => {
    const list = root.querySelector('[data-tablist]');
    if (!list) return;
    const tabs = [...list.querySelectorAll('[data-tab]')];
    const panels = [...root.querySelectorAll('[data-panel]')];
    if (!tabs.length) return;

    list.hidden = false;
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Sposób przeglądania');
    root.classList.add('is-tabbed');

    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const active = t === tab;
        t.setAttribute('aria-selected', active ? 'true' : 'false');
        t.tabIndex = active ? 0 : -1;
      });
      panels.forEach((p) => {
        p.hidden = p.dataset.panel !== tab.dataset.tab;
      });
      if (focus) tab.focus();
    };

    tabs.forEach((tab) => tab.setAttribute('role', 'tab'));
    panels.forEach((panel) => {
      panel.setAttribute('role', 'tabpanel');
      panel.tabIndex = 0;
    });
    select(tabs[0], false);

    list.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) select(tab, false);
    });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (e.key === 'Home') next = tabs[0];
      if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) {
        e.preventDefault();
        select(next, true);
      }
    });
  });

  /* ---------- Budżet: linki do katalogu stają się przełącznikiem ---------- */
  document.querySelectorAll('[data-budget]').forEach((root) => {
    const list = root.querySelector('[data-budget-tabs]');
    if (!list) return;
    const tabs = [...list.querySelectorAll('[data-band]')];
    const panels = [...root.querySelectorAll('[data-band-panel]')];
    if (tabs.length < 2) return;

    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Zakres cen');

    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
        t.tabIndex = active ? 0 : -1;
      });
      panels.forEach((p) => {
        p.hidden = p.dataset.bandPanel !== tab.dataset.band;
      });
      if (focus) tab.focus();
    };

    tabs.forEach((tab) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'budget-panel-' + tab.dataset.band);
    });
    panels.forEach((panel) => panel.setAttribute('role', 'tabpanel'));
    select(tabs[0], false);

    list.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-band]');
      if (!tab || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      select(tab, false);
    });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (next) {
        e.preventDefault();
        select(next, true);
      } else if (e.key === ' ') {
        e.preventDefault();
        select(tabs[i], false);
      }
    });
  });

  /* ---------- Podpowiedzi w wyszukiwarce pierwszego ekranu (ten sam punkt REST co w nagłówku) ---------- */
  const heroForm = document.querySelector('[data-hero-search]');
  if (heroForm && window.MCS && window.MCS.api) initHeroSuggest(heroForm);

  function initHeroSuggest(form) {
    const M = window.MCS;
    const input = form.querySelector('input[name="q"]');
    const panel = form.querySelector('.search-panel');
    if (!input || !panel) return;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', panel.id);
    input.setAttribute('aria-autocomplete', 'list');

    const status = document.createElement('div');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    form.appendChild(status);

    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    let options = [];
    let active = -1;
    let timer = 0;
    let seq = 0;
    const cache = new Map();

    const close = () => {
      panel.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const open = () => {
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const setActive = (index) => {
      if (options[active]) {
        options[active].setAttribute('aria-selected', 'false');
        options[active].classList.remove('is-active');
      }
      active = index;
      if (options[active]) {
        options[active].setAttribute('aria-selected', 'true');
        options[active].classList.add('is-active');
        input.setAttribute('aria-activedescendant', options[active].id);
        options[active].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    };

    const addOption = (node, url, index) => {
      node.id = 'hero-opt-' + index;
      node.href = url;
      node.tabIndex = -1;
      node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', 'false');
      options.push(node);
      return node;
    };

    const render = (data, query) => {
      options = [];
      active = -1;
      input.removeAttribute('aria-activedescendant');
      const frag = document.createDocumentFragment();
      const products = (data.products || []).slice(0, 5);
      if (!products.length) {
        const box = el('div', 'sp-msg sp-msg--empty');
        box.setAttribute('role', 'presentation');
        box.appendChild(el('p', 'sp-msg__title', 'Brak podpowiedzi dla „' + query + '”'));
        box.appendChild(el('p', 'sp-msg__detail', 'Sprawdź pisownię albo wpisz markę, model lub numer katalogowy.'));
        frag.appendChild(box);
      } else {
        const group = el('div', 'sp-group');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Modele');
        products.forEach((item, i) => {
          const a = addOption(el('a', 'sp-product'), item.url, i);
          const media = el('span', 'sp-product__media');
          if (item.image) {
            const img = document.createElement('img');
            img.src = item.image;
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.width = 200;
            img.height = 134;
            img.addEventListener('error', () => img.remove());
            media.appendChild(img);
          }
          a.appendChild(media);
          const body = el('span', 'sp-product__body');
          const meta = [item.maker, item.scale].filter(Boolean).join(' · ');
          if (meta) body.appendChild(el('span', 'sp-product__meta', meta));
          body.appendChild(el('span', 'sp-product__name', item.name));
          a.appendChild(body);
          const side = el('span', 'sp-product__side');
          side.appendChild(el('span', 'sp-product__price', item.price));
          if (!item.available) side.appendChild(el('span', 'sp-product__stock', 'Niedostępny'));
          a.appendChild(side);
          a.setAttribute('aria-label', [item.name, meta, item.price, item.available ? '' : 'chwilowo niedostępny'].filter(Boolean).join(', '));
          group.appendChild(a);
        });
        frag.appendChild(group);
      }
      if (data.all_url) {
        const all = addOption(el('a', 'sp-all'), data.all_url, options.length);
        all.appendChild(el('span', '', data.total ? 'Zobacz wszystkie wyniki: ' + data.total : 'Szukaj w całym katalogu'));
        frag.appendChild(all);
      }
      panel.replaceChildren(frag);
      status.textContent = products.length ? 'Podpowiedzi: ' + options.length : 'Brak podpowiedzi';
      open();
    };

    const search = async (query) => {
      const id = ++seq;
      try {
        const data = cache.get(query) || (await M.api('search/suggest?q=' + encodeURIComponent(query)));
        cache.set(query, data);
        if (id === seq && document.activeElement === input) render(data, query);
      } catch (err) {
        // Podpowiedzi są dodatkiem: przy błędzie działa zwykłe wysłanie formularza.
        if (id === seq) close();
      }
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const query = input.value.trim();
      if (query.length < 2) {
        seq++;
        close();
        return;
      }
      timer = window.setTimeout(() => search(query), 170);
    });
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2 && options.length) open();
    });
    input.addEventListener('keydown', (e) => {
      if (panel.hidden) {
        if (e.key === 'ArrowDown' && options.length) {
          e.preventDefault();
          open();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(active < options.length - 1 ? active + 1 : 0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(active > 0 ? active - 1 : options.length - 1);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && options[active]) {
        e.preventDefault();
        window.location.href = options[active].href;
      }
    });
    panel.addEventListener('mousedown', (e) => e.preventDefault());
    document.addEventListener('click', (e) => {
      if (!form.contains(e.target)) close();
    });
    input.addEventListener('blur', () => window.setTimeout(close, 120));
  }

  /* ---------- Telefon: po minięciu wyszukiwarki z pierwszego ekranu wraca ta z nagłówka ---------- */
  const heroSearch = document.querySelector('[data-hero-search]');
  if (heroSearch && document.body.classList.contains('home')) {
    const header = document.querySelector('.site-header');
    const update = () => {
      const limit = header ? header.getBoundingClientRect().bottom : 0;
      document.body.classList.toggle('hero-search-passed', heroSearch.getBoundingClientRect().bottom < limit);
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  }
})();

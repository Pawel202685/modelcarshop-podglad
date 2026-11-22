/* Podpowiedzi w wyszukiwarce nagłówka: dostępny combobox (WAI-ARIA 1.2). Bez JavaScriptu działa zwykły formularz. */
(function () {
  'use strict';

  const input = document.getElementById('site-search');
  const panel = document.getElementById('search-panel');
  if (!input || !panel) return;

  const M = window.MCS || {};
  const form = input.closest('form');
  const MIN_CHARS = 2;
  const DEBOUNCE = 170;
  const cache = new Map();

  let timer = 0;
  let controller = null;
  let options = [];
  let active = -1;
  let lastQuery = '';
  let lastData = null;
  let seq = 0;

  // Komunikaty dla czytników ekranu: poza listą, bo listbox może zawierać tylko opcje.
  const status = document.createElement('div');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  form.appendChild(status);

  /* ---------- Otwieranie i zamykanie ---------- */
  function open() {
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  }

  function setActive(index) {
    if (options[active]) {
      options[active].setAttribute('aria-selected', 'false');
      options[active].classList.remove('is-active');
    }
    active = index;
    const option = options[active];
    if (option) {
      option.setAttribute('aria-selected', 'true');
      option.classList.add('is-active');
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  /* ---------- Bezpieczne budowanie DOM ---------- */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function arrowIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 12h15.500M13.500 6l6 6-6 6');
    svg.appendChild(path);
    return svg;
  }

  /** Porównanie bez polskich znaków i wielkości liter, z mapą pozycji do oryginału. */
  function foldWithMap(text) {
    let out = '';
    const map = [];
    const chars = Array.from(text);
    let pos = 0;
    chars.forEach((ch) => {
      const folded = ch
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace('ł', 'l')
        .replace('ß', 'ss');
      for (let i = 0; i < folded.length; i++) {
        out += folded[i];
        map.push(pos);
      }
      pos += ch.length;
    });
    map.push(pos);
    return { out, map };
  }

  function queryTerms(query, corrected) {
    const source = (query + ' ' + (corrected || '')).toLowerCase();
    const terms = foldWithMap(source)
      .out.split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2);
    return Array.from(new Set(terms)).sort((a, b) => b.length - a.length);
  }

  /** Wstawia tekst z oznaczonymi dopasowaniami na początku słów. Bez innerHTML. */
  function highlight(target, text, terms) {
    const { out, map } = foldWithMap(text);
    const ranges = [];
    terms.forEach((term) => {
      let from = 0;
      while (from < out.length) {
        const at = out.indexOf(term, from);
        if (at === -1) break;
        const before = at === 0 ? '' : out[at - 1];
        if (at === 0 || !/[a-z0-9]/.test(before)) {
          ranges.push([at, at + term.length]);
        }
        from = at + term.length;
      }
    });
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    ranges.forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    let cursor = 0;
    merged.forEach(([a, b]) => {
      const start = map[a];
      const end = map[b];
      if (start > cursor) target.appendChild(document.createTextNode(text.slice(cursor, start)));
      target.appendChild(el('mark', '', text.slice(start, end)));
      cursor = end;
    });
    if (cursor < text.length) target.appendChild(document.createTextNode(text.slice(cursor)));
  }

  /* ---------- Widok ---------- */
  function showMessage(kind, title, detail) {
    options = [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
    const box = el('div', 'sp-msg sp-msg--' + kind);
    box.setAttribute('role', 'presentation');
    if (kind === 'loading') {
      box.appendChild(el('span', 'sp-spinner'));
    }
    box.appendChild(el('p', 'sp-msg__title', title));
    if (detail) box.appendChild(el('p', 'sp-msg__detail', detail));
    panel.replaceChildren(box);
    open();
  }

  function showLoading(query) {
    // Podczas pisania zostają poprzednie podpowiedzi; pełny stan ładowania tylko przy pierwszym zapytaniu.
    if (panel.hidden || !options.length) {
      showMessage('loading', 'Szukamy „' + query + '”…');
    } else {
      panel.classList.add('is-busy');
    }
  }

  let optionSeq = 0;
  function option(node, url, label) {
    node.id = 'sp-opt-' + ++optionSeq;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', 'false');
    node.tabIndex = -1;
    node.href = url;
    if (label) node.setAttribute('aria-label', label);
    node.dataset.index = String(options.length);
    options.push(node);
    return node;
  }

  function group(title) {
    const wrap = el('div', 'sp-group');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', title);
    wrap.appendChild(el('p', 'sp-group__title', title));
    wrap.lastChild.setAttribute('aria-hidden', 'true');
    return wrap;
  }

  function renderProduct(item, terms) {
    const a = el('a', 'sp-product');
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
    const name = el('span', 'sp-product__name');
    highlight(name, item.name, terms);
    body.appendChild(name);
    a.appendChild(body);

    const side = el('span', 'sp-product__side');
    side.appendChild(el('span', 'sp-product__price', item.price));
    if (!item.available) side.appendChild(el('span', 'sp-product__stock', 'Niedostępny'));
    a.appendChild(side);

    const label = [item.name, meta, item.price, item.available ? '' : 'chwilowo niedostępny'].filter(Boolean).join(', ');
    return option(a, item.url, label);
  }

  function renderTerm(kind, item, terms) {
    const a = el('a', 'sp-term');
    const name = el('span', 'sp-term__name');
    highlight(name, item.name, terms);
    a.appendChild(name);
    a.appendChild(el('small', '', String(item.count)));
    return option(a, item.url, kind + ' ' + item.name + ', modeli: ' + item.count);
  }

  function render(data, query) {
    panel.classList.remove('is-busy');
    options = [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
    const terms = queryTerms(query, data.corrected);
    const frag = document.createDocumentFragment();

    const hasTerms = data.brands.length || data.makers.length || data.scales.length;
    if (!data.products.length && !hasTerms) {
      const box = el('div', 'sp-msg sp-msg--empty');
      box.setAttribute('role', 'presentation');
      box.appendChild(el('p', 'sp-msg__title', 'Brak podpowiedzi dla „' + query + '”'));
      box.appendChild(el('p', 'sp-msg__detail', data.corrected ? '' : 'Sprawdź pisownię albo wpisz markę, model lub numer katalogowy.'));
      frag.appendChild(box);
      if (data.corrected) {
        const wrap = group('Czy chodziło Ci o');
        wrap.classList.add('sp-group--fix');
        wrap.appendChild(correctionOption(data.corrected));
        frag.appendChild(wrap);
      }
      const all = option(el('a', 'sp-all'), data.all_url);
      all.appendChild(el('span', '', 'Szukaj w całym katalogu'));
      all.appendChild(arrowIcon());
      frag.appendChild(all);
      panel.replaceChildren(frag);
      open();
      status.textContent = 'Brak podpowiedzi.';
      return;
    }

    if (data.corrected) {
      const wrap = group('Wyniki dla');
      wrap.classList.add('sp-group--fix');
      wrap.appendChild(correctionOption(data.corrected));
      frag.appendChild(wrap);
    }

    if (data.products.length) {
      const wrap = group('Modele');
      data.products.forEach((item) => wrap.appendChild(renderProduct(item, terms)));
      frag.appendChild(wrap);
    }

    if (hasTerms) {
      const row = el('div', 'sp-terms');
      [['Marki', 'Marka', data.brands], ['Producenci', 'Producent', data.makers], ['Skale', 'Skala', data.scales]].forEach(([title, kind, list]) => {
        if (!list.length) return;
        const wrap = group(title);
        list.forEach((item) => wrap.appendChild(renderTerm(kind, item, terms)));
        row.appendChild(wrap);
      });
      frag.appendChild(row);
    }

    const all = option(el('a', 'sp-all'), data.all_url, 'Zobacz wszystkie wyniki: ' + data.total);
    all.appendChild(el('span', '', 'Zobacz wszystkie wyniki'));
    all.appendChild(el('strong', '', String(data.total)));
    frag.appendChild(all);

    panel.replaceChildren(frag);
    open();
    status.textContent = data.total === 1 ? 'Znaleziono 1 model.' : 'Znaleziono modeli: ' + data.total + '. Użyj strzałek, aby wybrać podpowiedź.';
  }

  function correctionOption(corrected) {
    const a = el('a', 'sp-fix');
    a.appendChild(el('span', '', corrected));
    const url = new URL(form.getAttribute('action'), location.href);
    url.searchParams.set('q', corrected);
    return option(a, url.toString(), 'Szukaj: ' + corrected);
  }

  /* ---------- Pobieranie ---------- */
  function fetchSuggestions(query) {
    const key = query.toLowerCase();
    if (cache.has(key)) {
      lastData = cache.get(key);
      lastQuery = query;
      render(lastData, query);
      return;
    }
    const mine = ++seq;
    if (controller) controller.abort();
    controller = new AbortController();
    showLoading(query);

    fetch(M.rest + 'search/suggest?q=' + encodeURIComponent(query), {
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then((data) => {
        if (mine !== seq) return;
        if (cache.size > 40) cache.delete(cache.keys().next().value);
        cache.set(key, data);
        lastData = data;
        lastQuery = query;
        if (document.activeElement === input && input.value.trim() === query) render(data, query);
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (mine !== seq) return;
        panel.classList.remove('is-busy');
        if (document.activeElement === input) {
          showMessage('error', 'Podpowiedzi są chwilowo niedostępne', 'Naciśnij Enter, aby przeszukać katalog.');
          status.textContent = 'Podpowiedzi są chwilowo niedostępne.';
        }
      });
  }

  function schedule() {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      if (controller) controller.abort();
      seq++;
      lastQuery = '';
      options = [];
      panel.replaceChildren();
      close();
      return;
    }
    timer = setTimeout(() => fetchSuggestions(query), DEBOUNCE);
  }

  /* ---------- Zdarzenia ---------- */
  input.addEventListener('input', schedule);

  input.addEventListener('focus', () => {
    const query = input.value.trim();
    if (query.length < MIN_CHARS) return;
    if (lastData && lastQuery === query) {
      render(lastData, query);
    }
  });

  input.addEventListener('keydown', (e) => {
    const isOpen = !panel.hidden;
    switch (e.key) {
      case 'ArrowDown':
        if (!isOpen) {
          if (input.value.trim().length >= MIN_CHARS) {
            if (lastData && lastQuery === input.value.trim()) render(lastData, lastQuery);
            else schedule();
          }
          e.preventDefault();
          return;
        }
        if (options.length) {
          e.preventDefault();
          setActive(active + 1 >= options.length ? 0 : active + 1);
        }
        break;
      case 'ArrowUp':
        if (isOpen && options.length) {
          e.preventDefault();
          setActive(active <= 0 ? options.length - 1 : active - 1);
        }
        break;
      case 'Home':
        if (isOpen && active >= 0) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (isOpen && active >= 0) {
          e.preventDefault();
          setActive(options.length - 1);
        }
        break;
      case 'Enter':
        if (isOpen && options[active]) {
          e.preventDefault();
          window.location.assign(options[active].href);
        }
        break;
      case 'Escape':
        if (isOpen) {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (input.value !== '') {
          input.value = '';
          schedule();
        }
        break;
      case 'Tab':
        close();
        break;
      default:
    }
  });

  // Przytrzymanie myszy na liście nie może zabrać fokusu z pola.
  panel.addEventListener('mousedown', (e) => {
    if (e.target.closest('[role=option]')) e.preventDefault();
  });

  panel.addEventListener('mousemove', (e) => {
    const opt = e.target.closest('[role=option]');
    if (!opt) return;
    const index = Number(opt.dataset.index);
    if (index !== active) setActive(index);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!form.contains(e.target)) close();
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== input && !panel.contains(document.activeElement)) close();
    }, 120);
  });
})();

/*
 * Warstwa statycznego podglądu ModelCarShop. Ładowana jako pierwsza, przed skryptami sklepu.
 * Podmienia zapytania do serwera na lokalne dane, wyłącza zakup i formularze
 * oraz obsługuje listę życzeń w localStorage. Niczego nigdzie nie wysyła.
 */
(function () {
  'use strict';

  const self = document.currentScript;
  const BASE = (self && self.dataset.base) || '';
  const ROOT = BASE + '/assets/pv/';
  const WALKTHROUGH = BASE + '/jak-dziala-zakup/';
  const API_PREFIX = BASE + '/__podglad/';
  const WL_KEY = 'mcs_podglad_lista';
  const WL_FLAG = 'mcs_wl_used';
  const WL_MAX = 200;
  const FORMS_OFF = 'W podglądzie formularze są wyłączone. Nic nie zostało wysłane.';

  const PV = (window.MCSPV = window.MCSPV || {});
  PV.base = BASE;
  PV.walkthrough = WALKTHROUGH;
  const realFetch = window.fetch.bind(window);

  /* ------------------------------------------------------------------ *
   * Ładowanie danych na żądanie
   * ------------------------------------------------------------------ */

  const once = (fn) => {
    let p = null;
    return () => p || (p = fn().catch((e) => { p = null; throw e; }));
  };

  const fetchJson = (name) => realFetch(ROOT + 'data/' + name, { credentials: 'omit' }).then((res) => {
    if (!res.ok) throw new Error('Brak danych podglądu: ' + name);
    return res.json();
  });

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Nie wczytano skryptu ' + src));
    document.head.appendChild(s);
  });

  const loadEngine = once(async () => {
    const [data] = await Promise.all([fetchJson('engine.json'), loadScript(ROOT + 'engine.js')]);
    PV.engine.setData(data);
    return PV.engine;
  });

  let cardNames = {};
  const loadCards = once(async () => {
    const engine = await loadEngine();
    const data = await fetchJson('cards.json');
    cardNames = data.names || {};
    engine.setCards(data);
    return engine;
  });

  const loadGift = once(async () => {
    const [engine, gift] = await Promise.all([loadCards(), fetchJson('gift.json')]);
    engine.setGift(gift);
    return engine;
  });

  PV.loadEngine = loadEngine;
  PV.loadCards = loadCards;
  PV.loadGift = loadGift;

  /* ------------------------------------------------------------------ *
   * Lista życzeń w localStorage
   * ------------------------------------------------------------------ */

  const wishlist = {
    read() {
      try {
        const raw = JSON.parse(localStorage.getItem(WL_KEY) || '[]');
        return Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      } catch (e) {
        return [];
      }
    },
    write(ids) {
      try {
        localStorage.setItem(WL_KEY, JSON.stringify(ids.slice(0, WL_MAX)));
      } catch (e) { /* tryb prywatny */ }
    },
    response(extra) {
      const ids = this.read();
      return Object.assign({ ids, count: ids.length }, extra || {});
    },
  };

  /* Przed wishlist.js: znacznik mówi mu, że warto zapytać o stan listy. */
  try {
    if (wishlist.read().length) localStorage.setItem(WL_FLAG, '1');
  } catch (e) { /* tryb prywatny */ }

  /* ------------------------------------------------------------------ *
   * Zastępstwo fetch: REST i fragmenty katalogu bez serwera
   * ------------------------------------------------------------------ */

  const json = (data, status) => new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  const aborted = () => new DOMException('Przerwano', 'AbortError');

  async function handleApi(path, url, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();

    if (path === 'search/suggest') {
      const engine = await loadEngine();
      return json(engine.suggest(url.searchParams.get('q') || ''));
    }

    if (path === 'gift') {
      const engine = await loadGift();
      return json(engine.giftApi(url.searchParams));
    }

    if (path === 'wishlist' && method === 'GET') return json(wishlist.response());

    if (path === 'wishlist/items' && method === 'POST') {
      let id = 0;
      try {
        id = Number(JSON.parse((init && init.body) || '{}').product_id);
      } catch (e) { id = 0; }
      if (!Number.isInteger(id) || id <= 0) return json({ message: 'Nie znaleźliśmy tego modelu.' }, 404);
      const ids = wishlist.read().filter((n) => n !== id);
      ids.unshift(id);
      wishlist.write(ids);
      return json(wishlist.response({ product_id: id, in_list: true }));
    }

    const del = /^wishlist\/items\/(\d+)$/.exec(path);
    if (del && method === 'DELETE') {
      const id = Number(del[1]);
      wishlist.write(wishlist.read().filter((n) => n !== id));
      return json(wishlist.response({ product_id: id, in_list: false }));
    }

    // Każda inna droga (newsletter, powiadomienia, koszyk) w podglądzie niczego nie zapisuje.
    return json({ message: FORMS_OFF, preview: true }, 403);
  }

  window.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url;
    try {
      url = new URL(raw, location.href);
    } catch (e) {
      return realFetch(input, init);
    }
    if (url.origin !== location.origin) {
      return Promise.reject(new TypeError('Podgląd nie łączy się z innymi serwisami.'));
    }
    const signal = init && init.signal;
    const guard = (work) => (async () => {
      if (signal && signal.aborted) throw aborted();
      const out = await work();
      if (signal && signal.aborted) throw aborted();
      return out;
    })();

    if (url.searchParams.get('_mcs') === '1') {
      return guard(async () => {
        const engine = await loadCards();
        return json(engine.fragments(url.href));
      });
    }
    if (url.pathname.startsWith(API_PREFIX)) {
      const path = url.pathname.slice(API_PREFIX.length).replace(/^\/+|\/+$/g, '');
      return guard(() => handleApi(path, url, init));
    }
    return realFetch(input, init);
  };

  /* ------------------------------------------------------------------ *
   * Dialog „koszyk wyłączony”
   * ------------------------------------------------------------------ */

  let cartDialog = null;

  function buildCartDialog() {
    const box = document.createElement('div');
    box.className = 'modal pv-dialog';
    box.id = 'pv-cart-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'pv-cart-title');
    box.setAttribute('aria-describedby', 'pv-cart-text');
    box.inert = true;
    box.innerHTML =
      '<div class="modal__scrim" data-drawer-close></div>' +
      '<div class="modal__panel">' +
      '<button class="icon-btn modal__close" type="button" data-drawer-close aria-label="Zamknij"><svg class="icon icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5.500 5.500 13 13M18.500 5.500l-13 13"/></svg></button>' +
      '<p class="eyebrow">Podgląd sklepu</p>' +
      '<h2 class="pv-dialog__title" id="pv-cart-title">Koszyk jest w podglądzie <em>wyłączony</em></h2>' +
      '<p class="pv-dialog__text" id="pv-cart-text">Tutaj tylko oglądasz sklep, więc nic nie trafia do koszyka i nic nie jest zapisywane. W gotowym sklepie ten przycisk dodaje model do koszyka, a zakup można dokończyć z dostawą do Paczkomatu i płatnością online.</p>' +
      '<p class="pv-dialog__text pv-dialog__cond" data-pv-cond hidden>Przy tym egzemplarzu kupujący najpierw potwierdza opisany stan opakowania lub modelu.</p>' +
      '<div class="pv-dialog__actions">' +
      '<a class="btn btn--primary" href="' + WALKTHROUGH + '" data-autofocus>Zobacz, jak działa zakup</a>' +
      '<button class="btn btn--ghost" type="button" data-drawer-close>Zamknij</button>' +
      '</div></div>';
    document.body.appendChild(box);
    return box;
  }

  function openCartDialog(flagged) {
    if (!cartDialog) cartDialog = buildCartDialog();
    const cond = cartDialog.querySelector('[data-pv-cond]');
    if (cond) cond.hidden = !flagged;
    const M = window.MCS;
    if (M && M.openLayer) M.openLayer(cartDialog);
  }
  PV.openCartDialog = openCartDialog;

  /* ------------------------------------------------------------------ *
   * Przechwytywanie: zakup i formularze (faza capture, przed skryptami sklepu)
   * ------------------------------------------------------------------ */

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    const add = t.closest('[data-add-to-cart], [data-pstick-buy], [data-wl-add-all]');
    if (add) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openCartDialog(!!add.closest('[data-pstick]') && !!document.querySelector('[data-mcs-ack]'));
      return;
    }

    // Zamknięcie paska kampanii bez zapisywania ciasteczka: podgląd nie używa cookies.
    const barClose = t.closest('[data-promo-bar-close]');
    if (barClose) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const bar = barClose.closest('[data-promo-bar]');
      if (bar) bar.remove();
      return;
    }

    // Formularze wyłączone: przycisk wysyłki pokazuje komunikat także wtedy, gdy nie ma zdarzenia submit.
    const send = t.closest('button[type="submit"], input[type="submit"]');
    if (send) {
      const form = send.form || send.closest('form');
      if (form && form.hasAttribute('data-pv-inert')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        inertSubmit(form);
      }
    }
  }, true);

  function inertSubmit(form) {
    if (form.hasAttribute('data-mcs-buy')) {
      const flagged = !!form.querySelector('[data-mcs-ack]') || !!document.querySelector('[data-mcs-ack]');
      openCartDialog(flagged);
      return;
    }
    let note = form.querySelector('.pv-form-note');
    if (!note) {
      note = document.createElement('p');
      note.className = 'notice pv-form-note';
      note.setAttribute('role', 'status');
      note.tabIndex = -1;
      const text = document.createElement('span');
      text.textContent = FORMS_OFF + ' ';
      const link = document.createElement('a');
      link.href = WALKTHROUGH;
      link.textContent = 'Zobacz, jak działa zakup';
      note.append(text, link);
      form.appendChild(note);
    }
    note.hidden = false;
    note.focus({ preventScroll: true });
    note.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form instanceof HTMLFormElement && form.hasAttribute('data-pv-inert')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      inertSubmit(form);
    }
  }, true);

  /* ------------------------------------------------------------------ *
   * Katalog: stan z adresu, uporządkowanie filtrów
   * ------------------------------------------------------------------ */

  const STATE_KEYS = ['q', 's', 'marka', 'producent', 'skala', 'material', 'dostepnosc', 'otwierane', 'kolekcja', 'cena_od', 'cena_do', 'nowosci', 'promocje', 'sort'];

  const hasCatalogState = () => {
    const params = new URLSearchParams(location.search);
    for (const key of params.keys()) {
      if (STATE_KEYS.includes(key.replace(/\[\]$/, ''))) return true;
    }
    return false;
  };

  /* Na stronie ze stanem w adresie serwer ustawiłby zaznaczone filtry na górze listy i otworzył grupy. */
  function arrangeFacets(payload) {
    const form = document.querySelector('[data-shop-form]');
    if (!form || !payload || !payload.facets) return;
    Object.keys(payload.facets).forEach((key) => {
      const info = payload.facets[key];
      const group = form.querySelector('[data-facet="' + key + '"]');
      if (!group) return;
      if (info.selected) group.open = true;
      const head = group.querySelector(':scope [data-facet-list]');
      const more = group.querySelector('details.facet-more .facet-list');
      if (!head || !more) return;
      const labels = Array.from(group.querySelectorAll('[data-facet-opt]'));
      const options = labels.map((label, index) => {
        const state = info.options[label.dataset.facetOpt] || [0, 0];
        return { label, index, count: state[0], active: !!state[1] };
      });
      const hasResults = options.some((o) => o.count > 0);
      const visible = 8;
      const total = options.length;
      options.sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1) || (a.count > 0 ? 0 : 1) - (b.count > 0 ? 0 : 1) || a.index - b.index);
      options.forEach((o, pos) => {
        const fits = pos < visible && (o.count > 0 || !hasResults || total <= visible);
        (o.active || fits ? head : more).appendChild(o.label);
      });
      const outer = group.querySelector('details.facet-more');
      if (outer) outer.hidden = !more.children.length;
    });
  }

  function hydrateCatalog() {
    const root = document.querySelector('[data-shop]');
    if (!root) {
      document.documentElement.classList.remove('pv-hydrating');
      return;
    }
    if (!hasCatalogState()) {
      document.documentElement.classList.remove('pv-hydrating');
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      document.documentElement.classList.remove('pv-hydrating');
    };
    const timer = setTimeout(finish, 5000);
    document.addEventListener('mcs:catalog-updated', () => {
      clearTimeout(timer);
      finish();
    }, { once: true });
    loadCards()
      .then((engine) => arrangeFacets(engine.fragments(location.href)))
      .catch(() => {})
      .finally(() => {
        // shop.js na popstate pobiera bieżący adres przez fetch (obsługuje to warstwa powyżej).
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      });
  }

  /* ------------------------------------------------------------------ *
   * Strona listy życzeń
   * ------------------------------------------------------------------ */

  const plural = (n, one, few, many) => {
    if (n === 1) return one;
    const u = n % 10;
    const t = n % 100;
    return u >= 2 && u <= 4 && (t < 12 || t > 14) ? few : many;
  };

  async function renderWishlistPage() {
    const emptyBox = document.querySelector('[data-wl-empty]');
    if (!emptyBox) return;
    const wrap = emptyBox.parentElement;
    const noteHost = document.querySelector('[data-pv-wl-note]');
    const ids = wishlist.read();
    if (noteHost) noteHost.hidden = ids.length === 0;
    if (!ids.length) return;

    const engine = await loadCards();
    const trash = '<svg class="icon icon-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.500 7h15M9.500 7V4.500h5V7M6.500 7l1 13.500h9l1-13.500"/></svg>';
    const items = ids.filter((id) => engine.cardDefault(id) !== '');
    const ul = document.createElement('ul');
    ul.className = 'grid grid--products wl-grid';
    ul.setAttribute('data-wl-grid', '');
    ul.innerHTML = items.map((id, i) => {
      const html = engine.cardDefault(id);
      const card = i < 2 ? html.replace(' loading="lazy"', ' loading="eager"') : html;
      const can = html.includes('pcard--out') ? '' : ' data-wl-buyable';
      const name = cardNames[id] || '';
      return '<li class="wl-item" data-wl-item="' + id + '"' + can + '>' + card +
        '<button class="wl-remove" type="button" data-wl-remove="' + id + '" aria-label="Usuń z listy życzeń: ' + name.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' + trash + '<span>Usuń z listy</span></button></li>';
    }).join('');
    wrap.insertBefore(ul, emptyBox);

    const count = items.length;
    const summary = document.querySelector('[data-wl-summary]');
    const countEl = document.querySelector('[data-wl-count]');
    const wordEl = document.querySelector('[data-wl-word]');
    if (countEl) countEl.textContent = String(count);
    if (wordEl) wordEl.textContent = plural(count, 'model', 'modele', 'modeli');
    if (summary) summary.hidden = count === 0;
    emptyBox.hidden = count !== 0;
    const available = ul.querySelectorAll('[data-wl-buyable]').length;
    const actions = document.querySelector('[data-wl-actions]');
    const addLabel = document.querySelector('[data-wl-add-label]');
    if (actions) actions.hidden = available === 0;
    if (addLabel) addLabel.textContent = 'Dodaj dostępne do koszyka (' + available + ')';
    document.dispatchEvent(new CustomEvent('mcs:catalog-updated', { detail: { total: count } }));
  }

  /* ------------------------------------------------------------------ *
   * Prezenty: odpowiedzi z adresu (link do wyników)
   * ------------------------------------------------------------------ */

  function hydrateGift() {
    const form = document.querySelector('[data-gift]');
    if (!form || !location.search) return;
    const params = new URLSearchParams(location.search);
    let touched = false;
    params.forEach((value, key) => {
      const input = form.querySelector('input[type="radio"][name="' + CSS.escape(key) + '"][value="' + CSS.escape(value) + '"]');
      if (input) {
        input.checked = true;
        touched = true;
      }
    });
    if (touched) PV.giftRefresh = form.querySelector('input[type="radio"]:checked');
  }

  /* ------------------------------------------------------------------ *
   * Wyszukiwarka poradników (client-side, działa jak WP_Query po tytule, wstępie i treści)
   * ------------------------------------------------------------------ */

  function foldPl(text) {
    return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
  }

  /* Podział hasła jak w WP_Query::parse_search (cudzysłowy, spacje, przecinki, plusy). */
  function wpTokens(s) {
    const out = [];
    const delim = (c) => c === '\t' || c === ' ' || c === '"' || c === ',' || c === '+';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '"') {
        const j = s.indexOf('"', i + 1);
        const end = j === -1 ? s.length : j + 1;
        out.push(s.slice(i, end));
        i = end;
      } else if (delim(s[i])) {
        i += 1;
      } else if (i === 0 || delim(s[i - 1])) {
        let j = i;
        while (j < s.length && !delim(s[j])) j += 1;
        out.push(s.slice(i, j));
        i = j;
      } else {
        i += 1;
      }
    }
    return out;
  }

  function wpTerms(tokens, stopwords) {
    const checked = [];
    tokens.forEach((token) => {
      const exact = /^".+"$/.test(token);
      const term = exact ? token.replace(/^["']+|["']+$/g, '') : token.replace(/^["' ]+|["' ]+$/g, '');
      if (!term || (term.length === 1 && /^[a-z-]$/i.test(term))) return;
      if (stopwords.has(term.toLowerCase())) return;
      checked.push(term);
    });
    return checked;
  }

  /* Te same reguły co WP_Query: wszystkie słowa w tytule, wstępie lub treści, kolejność wg trafień w tytule i daty. */
  function blogMatches(posts, raw, stopList) {
    const s = String(raw);
    const stopwords = new Set(stopList || blogStopwords);
    const tokens = wpTokens(s);
    let terms = wpTerms(tokens, stopwords);
    if (!terms.length || terms.length > 9) terms = [s];
    const parsed = terms.map((term) => {
      const exclude = term.length > 1 && term[0] === '-';
      return { exclude, fold: foldPl(exclude ? term.slice(1) : term) };
    });
    const titled = parsed.filter((t) => !t.exclude).map((t) => t.fold);
    const sentence = /(?:\s|^)-/.test(s) ? '' : foldPl(s);
    const found = [];
    posts.forEach((post, index) => {
      const title = foldPl(post.title);
      const excerpt = foldPl(post.excerpt);
      const text = foldPl(post.text);
      const ok = parsed.every((t) => {
        const hit = title.includes(t.fold) || excerpt.includes(t.fold) || text.includes(t.fold);
        return t.exclude ? !hit : hit;
      });
      if (!ok) return;
      let rank;
      if (tokens.length > 1) {
        rank = 6;
        if (sentence && title.includes(sentence)) rank = 1;
        else if (titled.length && titled.length < 7 && titled.every((t) => title.includes(t))) rank = 2;
        else if (titled.length > 1 && titled.length < 7 && titled.some((t) => title.includes(t))) rank = 3;
        else if (sentence && excerpt.includes(sentence)) rank = 4;
        else if (sentence && text.includes(sentence)) rank = 5;
      } else {
        rank = titled.length && title.includes(titled[0]) ? 0 : 1;
      }
      found.push({ post, rank, index });
    });
    found.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return found.map((f) => f.post);
  }

  let blogStopwords = [];
  PV.blogMatches = blogMatches;

  async function hydrateBlogSearch() {
    const mast = document.querySelector('.bmast');
    if (!mast || !document.querySelector('[data-pv-blog-search]')) return;
    const params = new URLSearchParams(location.search);
    const raw = (params.get('s') || '').trim().slice(0, 120);
    if (!raw) return;
    document.title = 'Wyniki wyszukiwania: ' + raw + ' | ModelCarShop';
    const input = mast.querySelector('#blog-search');
    if (input) input.value = raw;
    const data = await fetchJson('blog.json');
    blogStopwords = data.stopwords || [];
    const posts = blogMatches(data.posts, raw);
    const shown = raw.length > 60 ? raw.slice(0, 59) + '…' : raw;
    const title = mast.querySelector('.bmast__title');
    if (title) {
      title.textContent = posts.length ? 'Wyniki dla ' : 'Brak wyników dla ';
      const em = document.createElement('em');
      em.textContent = '„' + shown + '”';
      title.appendChild(em);
    }
    const text = mast.querySelector('.bmast__text');
    let lead = mast.querySelector('.bmast__lead');
    if (posts.length) {
      if (!lead) {
        lead = document.createElement('p');
        lead.className = 'bmast__lead';
        text.appendChild(lead);
      }
      const word = plural(posts.length, 'poradnik', 'poradniki', 'poradników');
      lead.textContent = 'Znaleźliśmy ' + posts.length + ' ' + word + '.';
    } else if (lead) {
      lead.remove();
    }
    const list = document.querySelector('.blist');
    if (!list) return;
    if (posts.length) {
      const grid = document.createElement('div');
      const rest = posts.length % 3;
      grid.className = posts.length === 1 ? 'bgrid bgrid--solo' : 'bgrid' + (rest ? ' bgrid--r' + rest : '');
      grid.innerHTML = posts.map((p, i) => (i < 3 ? p.card.replace('loading="lazy"', 'loading="eager"') : p.card)).join('');
      list.replaceChildren(grid);
    } else {
      list.replaceChildren();
      const tpl = document.getElementById('pv-blog-empty');
      if (tpl) {
        const box = tpl.content.cloneNode(true);
        const shopLink = box.querySelector('[data-pv-search-shop]');
        if (shopLink) {
          shopLink.href = BASE + '/modele/?q=' + encodeURIComponent(raw);
          const lbl = raw.length > 24 ? raw.slice(0, 23) + '…' : raw;
          shopLink.textContent = 'Szukaj w sklepie: ' + lbl;
        }
        list.appendChild(box);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */

  hydrateGift();

  document.addEventListener('DOMContentLoaded', () => {
    hydrateCatalog();
    renderWishlistPage().catch(() => {});
    hydrateBlogSearch().catch(() => {});
    if (PV.giftRefresh) {
      // pages.js przelicza wyniki na zdarzenie change.
      PV.giftRefresh.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
})();

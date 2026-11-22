/*
 * Silnik podglądu: wyszukiwarka, katalog i prezenty bez serwera.
 * To wierny port plików includes/search/{text,engine,query,archive,rest}.php oraz pages/gift.php.
 * Słowniki (aliasy, skale, tłumaczenia kolorów) pochodzą z eksportu PHP i nie są tu przepisane.
 */
(function () {
  'use strict';

  const PV = (window.MCSPV = window.MCSPV || {});
  const BASE = PV.base || '';
  const U = (path) => BASE + path;

  const MATCH = { EXACT: 100, ALIAS: 96, COMPOUND: 94, TRANSLATION: 90, SCALE: 88, SUFFIX: 80, PREFIX: 70, FUZZY: 60 };
  const NBSP = ' ';
  const SHOP_FACETS = ['marka', 'producent', 'skala', 'material', 'dostepnosc', 'otwierane'];
  const LIST_KEYS = ['marka', 'producent', 'skala', 'material', 'dostepnosc', 'otwierane', 'kolekcja'];
  const FACET_DEFS = {
    marka: { label: 'Marka samochodu', short: 'Marka', name: 'brand_name' },
    producent: { label: 'Producent modelu', short: 'Producent', name: 'maker_name' },
    skala: { label: 'Skala', short: 'Skala', name: 'scale_name' },
    material: { label: 'Materiał', short: 'Materiał', name: 'material_name' },
    dostepnosc: { label: 'Dostępność', short: 'Dostępność', name: null },
    otwierane: { label: 'Otwierane elementy', short: 'Otwierane', name: null },
  };
  const VALUE_LABELS = {
    dostepnosc: { dostepne: 'Dostępne', 'do-potwierdzenia': 'Do potwierdzenia', niedostepne: 'Chwilowo niedostępne' },
    otwierane: { tak: 'Z otwieranymi elementami', nie: 'Bez otwieranych elementów' },
  };
  const SORT_OPTIONS = {
    polecane: 'Polecane',
    nowosci: 'Najnowsze',
    'cena-rosnaco': 'Cena: od najniższej',
    'cena-malejaco': 'Cena: od najwyższej',
    nazwa: 'Nazwa: A–Z',
  };

  let D = null;
  let rowsById = new Map();
  let rowsList = [];
  let searchable = [];
  let corpus = null;
  let displayMap = null;
  let stopSet = new Set();
  let aliasMap = new Map();
  let scaleSet = new Set();
  let collectionNames = {};
  let archiveByFacet = {};
  let cards = null;
  let cardOverrides = {};
  const SIZES_CATALOG = 'sizes="auto, (min-width:1160px) 340px, (min-width:720px) 33vw, 50vw"';
  const SIZES_DEFAULT = 'sizes="auto, (min-width:1160px) 25vw, (min-width:720px) 33vw, 50vw"';

  /* ------------------------------------------------------------------ *
   * Tekst: mcs_search_fold, tokens, skale
   * ------------------------------------------------------------------ */

  function fold(text) {
    const lower = String(text).toLowerCase();
    let out = '';
    const map = D.search.charMap;
    for (const ch of lower) {
      if (ch < '\u0080') out += ch;
      else out += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
    }
    return out;
  }

  const compact = (text) => fold(text).replace(/[^a-z0-9]+/g, '');

  function tokens(folded) {
    const cleaned = String(folded).replace(/@(?!\d)/g, ' ');
    const out = [];
    for (let part of cleaned.split(/[^a-z0-9@]+/)) {
      if (part === '') continue;
      if (part.includes('@') && !/^@\d{1,3}$/.test(part)) part = part.split('@').join('');
      if (part !== '') out.push(part);
    }
    return out;
  }

  // PCRE: \s bez flagi u to wyłącznie białe znaki ASCII.
  const WS = '[ \\t\\n\\r\\f\\v]';

  /** preg_replace z warunkiem (?<![a-z0-9.\-/:]) przed dopasowaniem (działa także bez lookbehind). */
  function replaceBounded(str, re, repl) {
    let out = '';
    let last = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(str)) !== null) {
      const prev = m.index > 0 ? str[m.index - 1] : '';
      if (prev !== '' && /[a-z0-9.\-/:]/.test(prev)) {
        re.lastIndex = m.index + 1;
        continue;
      }
      out += str.slice(last, m.index) + repl(m);
      last = m.index + m[0].length;
      re.lastIndex = last;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return out + str.slice(last);
  }

  function canonScales(folded) {
    const list = D.search.scales.join('|');
    const r1 = new RegExp('1' + WS + '*[:/]' + WS + '*(' + list + ')(?![0-9])', 'g');
    const r2 = new RegExp('1' + WS + '*-' + WS + '*(' + list + ')(?![0-9\\-])', 'g');
    const r3 = new RegExp('1' + WS + '+(' + list + ')(?![0-9:/\\-])', 'g');
    let out = replaceBounded(String(folded), r1, (m) => ' @' + m[1] + ' ');
    out = replaceBounded(out, r2, (m) => ' @' + m[1] + ' ');
    out = replaceBounded(out, r3, (m) => ' @' + m[1] + ' ');
    return out;
  }

  function translations(token) {
    if (token.length < 4) return [];
    const stems = D.search.translations;
    for (const stem of Object.keys(stems)) {
      if (token.startsWith(stem)) return stems[stem];
    }
    return [];
  }

  function maxEdits(length) {
    if (length < 4) return 0;
    if (length <= 7) return 1;
    return length <= 11 ? 2 : 3;
  }

  /** Odległość Damerau-Levenshteina z wczesnym przerwaniem (mcs_search_distance). */
  function distance(a, b, max) {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    if (la === 0 || lb === 0) return Math.max(la, lb);
    let before = null;
    let previous = [];
    for (let j = 0; j <= lb; j++) previous[j] = j;
    for (let i = 1; i <= la; i++) {
      const current = [i];
      let rowMin = i;
      const ca = a[i - 1];
      for (let j = 1; j <= lb; j++) {
        const cb = b[j - 1];
        let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca === cb ? 0 : 1));
        if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) {
          value = Math.min(value, before[j - 2] + 1);
        }
        current[j] = value;
        if (value < rowMin) rowMin = value;
      }
      if (rowMin > max) return max + 1;
      before = previous;
      previous = current;
    }
    return previous[lb] > max ? max + 1 : previous[lb];
  }

  const hasDigit = (t) => /\d/.test(t);
  const isDigits = (t) => /^[0-9]+$/.test(t);
  const isAlpha = (t) => /^[A-Za-z]+$/.test(t);

  /* ------------------------------------------------------------------ *
   * Silnik: mcs_search_parse, corpus, candidates, run
   * ------------------------------------------------------------------ */

  function parse(query) {
    let raw = String(query).replace(/\s+/gu, ' ').replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
    raw = Array.from(raw).slice(0, 120).join('');
    const folded = fold(raw);
    const toks = tokens(canonScales(folded));
    let required = [];
    let optional = [];
    for (const t of toks) {
      if (stopSet.has(t)) optional.push(t);
      else required.push(t);
    }
    if (!required.length && optional.length) {
      required = optional;
      optional = [];
    }
    return {
      raw,
      folded,
      tokens: Array.from(new Set(required)),
      optional: Array.from(new Set(optional)),
      compact: folded.replace(/[^a-z0-9]+/g, ''),
    };
  }

  function buildCorpus(rows) {
    const docs = [];
    const vocab = new Map();
    const compounds = new Set();
    for (const row of rows) {
      const t = new Map();
      for (const w of String(row.search_title).split(' ')) if (w !== '') t.set(w, 1.0);
      for (const w of String(row.search_attrs).split(' ')) if (w !== '' && !t.has(w)) t.set(w, 0.92);
      for (const [w, weight] of t) {
        if (weight === 1.0 || w !== String(row.sku_norm)) vocab.set(w, (vocab.get(w) || 0) + 1);
      }
      const c = new Set();
      for (const w of String(row.search_compound).split(' ')) {
        if (w !== '') {
          c.add(w);
          compounds.add(w);
        }
      }
      docs.push({ id: row.id, t, c, sku: String(row.sku_norm), title: ' ' + row.title_norm + ' ' });
    }
    return { docs, vocab, compounds };
  }

  function candidates(token, corp, lastTyping) {
    const vocab = corp.vocab;
    const found = new Map();
    const len = token.length;
    const bump = (word, value) => found.set(word, Math.max(found.get(word) || 0, value));

    if (vocab.has(token)) found.set(token, MATCH.EXACT);
    if (token.startsWith('@')) return { found, fix: null };

    let aliasFix = null;
    for (const target of aliasMap.get(token) || []) {
      if (vocab.has(target)) {
        bump(target, MATCH.ALIAS);
        if (aliasFix === null) aliasFix = target;
      }
    }

    let translated = false;
    for (const word of translations(token)) {
      if (vocab.has(word)) {
        bump(word, MATCH.TRANSLATION);
        translated = true;
      }
    }

    const digitsOnly = isDigits(token);
    if (digitsOnly) {
      let scale = null;
      if (len === 3 && token[0] === '1' && scaleSet.has(parseInt(token.slice(1), 10))) scale = '@' + parseInt(token.slice(1), 10);
      else if (len === 2 && scaleSet.has(parseInt(token, 10))) scale = '@' + parseInt(token, 10);
      if (scale !== null && vocab.has(scale)) bump(scale, MATCH.SCALE);
    }

    if (digitsOnly && len >= 2) {
      for (const word of vocab.keys()) {
        const head = word.length - len;
        if (head >= 1 && head <= 4 && word.endsWith(token) && isAlpha(word.slice(0, head))) bump(word, MATCH.SUFFIX);
      }
    }

    const digits = hasDigit(token);
    let hasPrefix = false;
    const prefixOk = digits ? lastTyping && len >= 2 : len >= 3 || (lastTyping && len >= 2);
    if (prefixOk) {
      for (const word of vocab.keys()) {
        if (word !== token && word.length > len && word.startsWith(token)) {
          bump(word, MATCH.PREFIX + Math.round((15 * len) / word.length + 1e-9));
          hasPrefix = true;
        }
      }
    }

    const known = vocab.has(token) || corp.compounds.has(token);
    let fuzzyFix = null;
    const max = maxEdits(len);
    if (!known && !digits && max > 0 && aliasFix === null && !translated && !hasPrefix) {
      let bestDistance = Infinity;
      let bestDf = -1;
      for (const [word, df] of vocab) {
        if (word === '' || word[0] === '@' || hasDigit(word)) continue;
        const wlen = word.length;
        if (wlen < 3 || Math.abs(wlen - len) > max) continue;
        let limit = max;
        if (word[0] !== token[0]) {
          if (len < 7) continue;
          limit = 1;
        }
        const d = distance(token, word, limit);
        if (d > limit) continue;
        bump(word, MATCH.FUZZY - 10 * (d - 1));
        if (d < bestDistance || (d === bestDistance && df > bestDf)) {
          bestDistance = d;
          bestDf = df;
          fuzzyFix = word;
        }
      }
    }
    return { found, fix: known ? null : aliasFix !== null ? aliasFix : fuzzyFix };
  }

  /** mcs_search_run dla pełnego zbioru wyszukiwalnego (typing = podpowiedzi). */
  function runSearch(query, typing) {
    const parsed = parse(query);
    const result = { hits: new Map(), corrected: '', relaxed: false, tokens: parsed.tokens, raw: parsed.raw };
    if (!parsed.tokens.length) return result;

    const corp = corpus || (corpus = buildCorpus(searchable));
    const toks = parsed.tokens;
    const count = toks.length;
    const cand = [];
    const fixes = new Map();
    toks.forEach((token, i) => {
      const info = candidates(token, corp, !!typing && i === count - 1);
      cand[i] = info.found;
      if (info.fix !== null) fixes.set(i, info.fix);
    });
    const optional = parsed.optional.filter((t) => corp.vocab.has(t));

    const pairs = [];
    for (let i = 0; i < count - 1; i++) pairs.push(toks[i] + toks[i + 1]);

    const comp = parsed.compact;
    const compDigits = comp !== '' && isDigits(comp);
    const hits = new Map();
    const partial = new Map();

    for (const doc of corp.docs) {
      const weighted = new Array(count).fill(0);
      const raw = new Array(count).fill(0);
      let phrase = 0;

      for (let i = 0; i < count; i++) {
        for (const [word, strength] of cand[i]) {
          if (doc.t.has(word)) {
            weighted[i] = Math.max(weighted[i], strength * doc.t.get(word));
            raw[i] = Math.max(raw[i], strength);
          } else if (doc.c.has(word)) {
            const capped = Math.min(strength, MATCH.COMPOUND);
            weighted[i] = Math.max(weighted[i], capped);
            raw[i] = Math.max(raw[i], capped);
          }
        }
        if (raw[i] < MATCH.COMPOUND && doc.c.has(toks[i])) {
          weighted[i] = MATCH.COMPOUND;
          raw[i] = MATCH.COMPOUND;
        }
      }

      for (let i = 0; i < pairs.length; i++) {
        const joined = pairs[i];
        if (doc.t.has(joined) || doc.c.has(joined)) {
          for (const k of [i, i + 1]) {
            weighted[k] = Math.max(weighted[k], MATCH.COMPOUND);
            raw[k] = Math.max(raw[k], MATCH.COMPOUND);
          }
          phrase += 6;
        }
        if (doc.title.includes(' ' + toks[i] + ' ' + toks[i + 1] + ' ')) phrase += 8;
      }

      const sku = doc.sku;
      let skuExact = false;
      let skuPrefix = false;
      if (sku !== '') {
        if (comp === sku || toks.includes(sku)) skuExact = true;
        else if (comp.length >= 4 && sku.startsWith(comp)) skuPrefix = true;
        else if (compDigits && comp.length >= 3 && sku.replace(/^[a-z]+/, '') === comp) skuPrefix = true;
      }

      let matched = 0;
      let fuzzy = false;
      let sum = 0;
      for (let i = 0; i < count; i++) {
        if (raw[i] > 0) {
          matched++;
          sum += weighted[i];
          if (raw[i] < MATCH.PREFIX) fuzzy = true;
        }
      }
      for (const word of optional) {
        if (doc.t.has(word)) sum += 4;
      }

      let score = sum / count + phrase;
      if (doc.title.startsWith(' ' + toks[0] + ' ')) score += 3;

      if (skuExact) hits.set(doc.id, { score, tier: 0 });
      else if (matched === count) hits.set(doc.id, { score, tier: fuzzy ? 3 : 1 });
      else if (skuPrefix) hits.set(doc.id, { score, tier: 2 });
      else if (count >= 2 && matched > 0) partial.set(doc.id, { score, matched });
    }

    if (!hits.size && partial.size) {
      const need = Math.ceil(count / 2);
      for (const [id, info] of partial) {
        if (info.matched >= need) hits.set(id, { score: info.matched * 100 + info.score, tier: 4 });
      }
      result.relaxed = hits.size > 0;
    }

    result.hits = hits;
    result.corrected = correction(parsed, fixes);
    return result;
  }

  function correction(parsed, fixes) {
    if (!fixes.size) return '';
    const out = parsed.tokens.map((t, i) => {
      if (t.startsWith('@')) return '1:' + t.slice(1);
      return fixes.has(i) ? fixes.get(i) : t;
    });
    const disp = displayMap || (displayMap = buildDisplay());
    return out.map((t) => (disp.has(t) ? disp.get(t) : t)).join(' ');
  }

  function buildDisplay() {
    const map = new Map();
    for (const row of searchable) {
      for (const name of [row.brand_name, row.maker_name]) {
        for (const word of String(name).split(/[\s,]+/u)) {
          if (word === '') continue;
          const key = compact(word);
          if (key !== '' && !map.has(key)) map.set(key, word);
        }
      }
    }
    for (const row of searchable) {
      for (const word of String(row.title).split(/[\s,()/]+/u)) {
        if (word === '') continue;
        const key = compact(word);
        if (key !== '' && !map.has(key) && !isDigits(key) && /\p{Lu}/u.test(word)) {
          map.set(key, word.replace(/^[.,]+|[.,]+$/g, ''));
        }
      }
    }
    return map;
  }

  /* ------------------------------------------------------------------ *
   * Porządkowanie: mcs_shop_sort_ids (PHP <=> na tablicach)
   * ------------------------------------------------------------------ */

  function cmp(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (typeof x === 'string' || typeof y === 'string') {
        const sx = String(x);
        const sy = String(y);
        if (sx === sy) continue;
        return sx < sy ? -1 : 1;
      }
      return x < y ? -1 : 1;
    }
    return 0;
  }

  /** PHP round(x, 2) dla dodatnich i ujemnych wartości (bez błędów reprezentacji). */
  function round2(x) {
    const sign = x < 0 ? -1 : 1;
    const v = Math.abs(x) * 100;
    let r = Math.round(v);
    // Korekta jak w PHP: wartości typu 1.005 reprezentowane minimalnie poniżej połówki.
    if (Math.abs(v - Math.floor(v) - 0.5) < 1e-9) r = Math.floor(v) + 1;
    return (sign * r) / 100;
  }

  const MAX_INT = Number.MAX_SAFE_INTEGER;

  function recommendedKey(row) {
    const availability = row.availability === 'in' || row.availability === 'low' ? 0 : row.availability === 'verify' ? 1 : 2;
    return [
      availability,
      row.image_id > 0 ? 0 : 1,
      row.featured ? 0 : 1,
      row.new_rank > 0 ? 0 : 1,
      row.new_rank > 0 ? row.new_rank : MAX_INT,
      -row.legacy,
    ];
  }

  function sortIds(ids, sort, hits) {
    const keys = new Map();
    for (const id of ids) {
      const row = rowsById.get(id);
      const rec = recommendedKey(row);
      let key;
      switch (sort) {
        case 'trafnosc': {
          const hit = (hits && hits.get(id)) || { tier: 9, score: 0 };
          key = [hit.tier, -round2(hit.score)].concat(rec);
          break;
        }
        case 'nowosci':
          key = [row.new_rank > 0 ? 0 : 1, row.new_rank > 0 ? row.new_rank : MAX_INT, -row.legacy];
          break;
        case 'cena-rosnaco':
          key = [row.price, rec[0], row.title_norm];
          break;
        case 'cena-malejaco':
          key = [-row.price, rec[0], row.title_norm];
          break;
        case 'nazwa':
          key = [row.title_norm, rec[0]];
          break;
        default:
          key = rec.slice();
      }
      key.push(id);
      keys.set(id, key);
    }
    return ids.slice().sort((a, b) => cmp(keys.get(a), keys.get(b)));
  }

  /* ------------------------------------------------------------------ *
   * Żądanie: mcs_shop_normalize_request
   * ------------------------------------------------------------------ */

  function sanitizeText(value) {
    let s = String(value);
    s = s.replace(/<[^>]*>?/g, '');
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    s = s.replace(/%[a-f0-9]{2}/gi, (m) => m);
    s = s.replace(/[\r\n\t ]+/g, ' ');
    return s.trim();
  }

  function sanitizeTitle(value) {
    let s = fold(String(value).replace(/<[^>]*>/g, ''));
    s = s.replace(/&[^;\s]+;/g, '');
    s = s.replace(/[^a-z0-9 _-]/g, '');
    s = s.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return s;
  }

  const sanitizeKey = (value) => String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '');

  function listParam(value) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return [];
    const items = Array.isArray(value) ? value : String(value).split(',');
    const out = [];
    for (const item of items) {
      const slug = sanitizeTitle(String(item).trim());
      if (slug !== '' && !out.includes(slug)) out.push(slug);
    }
    return out;
  }

  function moneyParam(value) {
    if (value === null || value === undefined || value === '' || Array.isArray(value)) return null;
    let v = String(value).trim().replace(/[  ]/g, '').replace(/zł/g, '').replace(/zl/g, '');
    v = v.replace(/,/g, '.');
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) return null;
    const amount = parseFloat(v);
    return amount >= 0 ? amount : null;
  }

  const defaultSort = (hasQuery, onlyNew) => (hasQuery ? 'trafnosc' : onlyNew ? 'nowosci' : 'polecane');

  function sortValue(sort, hasQuery, onlyNew) {
    let s = sanitizeKey(sort === undefined || sort === null ? '' : sort);
    const aliases = {
      recommended: 'polecane', featured: 'polecane', default: 'polecane',
      relevance: 'trafnosc',
      newest: 'nowosci', new: 'nowosci', najnowsze: 'nowosci',
      price: 'cena-rosnaco', price_asc: 'cena-rosnaco', 'price-asc': 'cena-rosnaco', cena: 'cena-rosnaco',
      price_desc: 'cena-malejaco', 'price-desc': 'cena-malejaco',
      name: 'nazwa', title: 'nazwa',
    };
    if (Object.prototype.hasOwnProperty.call(aliases, s)) s = aliases[s];
    if (s !== 'trafnosc' && !Object.prototype.hasOwnProperty.call(SORT_OPTIONS, s)) s = '';
    if (s === '' || (s === 'trafnosc' && !hasQuery)) s = defaultSort(hasQuery, onlyNew);
    return s;
  }

  function normalizeRequest(request) {
    let q = request.q !== undefined && !Array.isArray(request.q) ? sanitizeText(request.q) : '';
    q = Array.from(q.trim()).slice(0, 120).join('');
    const out = { q };
    for (const key of LIST_KEYS) out[key] = listParam(request[key]);
    let from = moneyParam(request.cena_od);
    let to = moneyParam(request.cena_do);
    if (from !== null && to !== null && from > to) [from, to] = [to, from];
    out.cena_od = from;
    out.cena_do = to;
    const truthy = (v) => !!v && v !== '0';
    out.nowosci = truthy(request.nowosci);
    out.promocje = truthy(request.promocje);
    out.sort = sortValue(request.sort, q !== '', out.nowosci);
    out.page = Math.max(1, parseInt(request.page !== undefined ? request.page : request.paged || 1, 10) || 1);
    out.per_page = request.per_page === -1 ? -1 : D.perPage;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Zapytanie: mcs_shop_query
   * ------------------------------------------------------------------ */

  const scaleNumber = (label) => {
    const m = /1\s*:\s*(\d+)/.exec(label);
    return m ? parseInt(m[1], 10) : 9999;
  };

  let facetCatalogCache = null;

  function facetCatalog() {
    if (facetCatalogCache) return facetCatalogCache;
    const catalog = {};
    for (const key of SHOP_FACETS) catalog[key] = new Map();
    for (const row of rowsList) {
      if (row.in_catalog !== 1) continue;
      for (const key of SHOP_FACETS) {
        const values = row['v_' + key];
        if (!values.length) continue;
        const def = FACET_DEFS[key];
        const names = def.name ? String(row[def.name]).split(',').map((s) => s.trim()) : [];
        values.forEach((value, i) => {
          if (!catalog[key].has(value)) {
            const fixed = VALUE_LABELS[key] ? VALUE_LABELS[key][value] : undefined;
            const label = fixed !== undefined ? fixed : names[i] !== undefined ? names[i] : value;
            catalog[key].set(value, { value, label, total: 0 });
          }
          catalog[key].get(value).total++;
        });
      }
    }
    const reorder = (key, compare) => {
      catalog[key] = new Map([...catalog[key].entries()].sort((a, b) => compare(a[1], b[1])));
    };
    for (const key of ['marka', 'producent', 'material']) {
      reorder(key, (a, b) => cmp([b.total, a.label], [a.total, b.label]));
    }
    reorder('skala', (a, b) => scaleNumber(a.label) - scaleNumber(b.label));
    for (const key of ['dostepnosc', 'otwierane']) {
      const order = Object.keys(VALUE_LABELS[key]);
      catalog[key] = new Map([...catalog[key].entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])));
    }
    facetCatalogCache = catalog;
    return catalog;
  }

  function priceBounds() {
    let min = null;
    let max = null;
    for (const row of rowsList) {
      if (row.in_catalog !== 1 || row.price <= 0) continue;
      min = min === null ? row.price : Math.min(min, row.price);
      max = max === null ? row.price : Math.max(max, row.price);
    }
    return { min: Math.floor(min === null ? 0 : min), max: Math.ceil(max === null ? 0 : max) };
  }

  function priceLabel(from, to) {
    const fmt = (v) => numberFormat(v, Number.isInteger(v) ? 0 : 2);
    if (from !== null && to !== null) return fmt(from) + '–' + fmt(to) + NBSP + 'zł';
    if (from !== null) return 'od ' + fmt(from) + NBSP + 'zł';
    return 'do ' + fmt(to) + NBSP + 'zł';
  }

  function numberFormat(value, decimals) {
    const fixed = Math.abs(value).toFixed(decimals);
    const [whole, frac] = fixed.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return (value < 0 ? '-' : '') + grouped + (frac ? ',' + frac : '');
  }

  function activeList(req, catalog) {
    const active = [];
    if (req.q !== '') active.push({ key: 'q', value: req.q, group: 'Szukane', label: '„' + req.q + '”' });
    for (const key of SHOP_FACETS) {
      for (const value of req[key]) {
        const entry = catalog[key].get(value);
        active.push({ key, value, group: FACET_DEFS[key].short, label: entry ? entry.label : value });
      }
    }
    for (const slug of req.kolekcja) {
      active.push({ key: 'kolekcja', value: slug, group: 'Kolekcja', label: collectionNames[slug] || slug });
    }
    if (req.cena_od !== null || req.cena_do !== null) {
      active.push({ key: 'cena', value: '', group: 'Cena', label: priceLabel(req.cena_od, req.cena_do) });
    }
    if (req.nowosci) active.push({ key: 'nowosci', value: '1', group: 'Oferta', label: 'Nowości' });
    if (req.promocje) active.push({ key: 'promocje', value: '1', group: 'Oferta', label: 'W promocji' });
    return active;
  }

  function shopQuery(request) {
    const req = normalizeRequest(request);
    let search = null;
    let pool = [];
    if (req.q !== '') {
      search = runSearch(req.q, false);
      for (const id of search.hits.keys()) pool.push(rowsById.get(id));
    } else {
      pool = rowsList.filter((r) => r.in_catalog === 1);
    }

    const catalog = facetCatalog();
    const filters = {};
    for (const key of SHOP_FACETS) {
      const valid = req[key].filter((v) => catalog[key].has(v));
      req[key] = valid;
      if (valid.length) filters[key] = new Set(valid);
    }
    if (req.kolekcja.length) {
      const terms = req.kolekcja.filter((slug) => Object.prototype.hasOwnProperty.call(collectionNames, slug));
      req.kolekcja = terms;
      if (terms.length) filters.kolekcja = new Set(terms);
    }

    const from = req.cena_od;
    const to = req.cena_do;
    const counts = {};
    for (const key of SHOP_FACETS) counts[key] = new Map();
    const tally = { marka: new Map(), producent: new Map(), skala: new Map() };
    const matched = [];
    let priceMin = null;
    let priceMax = null;
    const inc = (map, value) => map.set(value, (map.get(value) || 0) + 1);

    for (const row of pool) {
      const failed = [];
      for (const key of Object.keys(filters)) {
        const allowed = filters[key];
        if (!row['v_' + key].some((v) => allowed.has(v))) failed.push(key);
      }
      if ((from !== null && row.price < from) || (to !== null && row.price > to)) failed.push('cena');
      if (req.nowosci && !row.is_new) failed.push('nowosci');
      if (req.promocje && !row.on_sale) failed.push('promocje');

      const n = failed.length;
      if (n === 0) {
        matched.push(row.id);
        for (const key of Object.keys(tally)) {
          for (const value of row['v_' + key]) inc(tally[key], value);
        }
      }
      if (n <= 1) {
        for (const key of SHOP_FACETS) {
          if (n === 0 || failed[0] === key) {
            for (const value of row['v_' + key]) inc(counts[key], value);
          }
        }
        if (n === 0 || failed[0] === 'cena') {
          priceMin = priceMin === null ? row.price : Math.min(priceMin, row.price);
          priceMax = priceMax === null ? row.price : Math.max(priceMax, row.price);
        }
      }
    }

    const facets = {};
    for (const key of SHOP_FACETS) {
      const selected = new Set(req[key]);
      const options = [];
      for (const [value, option] of catalog[key]) {
        options.push({
          value: String(value),
          label: option.label,
          count: counts[key].get(value) || 0,
          total: option.total,
          active: selected.has(value),
        });
      }
      facets[key] = { label: FACET_DEFS[key].label, short: FACET_DEFS[key].short, selected: req[key].length, options };
    }

    const summary = {};
    for (const key of Object.keys(tally)) {
      const list = [];
      for (const [value, count] of tally[key]) {
        const entry = catalog[key].get(value);
        list.push({ value: String(value), label: entry ? entry.label : String(value), count });
      }
      if (key === 'skala') list.sort((a, b) => scaleNumber(a.label) - scaleNumber(b.label));
      else list.sort((a, b) => cmp([b.count, a.label], [a.count, b.label]));
      summary[key] = list;
    }

    const bounds = priceBounds();
    facets.cena = {
      label: 'Cena',
      short: 'Cena',
      min: priceMin !== null ? Math.floor(priceMin) : bounds.min,
      max: priceMax !== null ? Math.ceil(priceMax) : bounds.max,
      catalog_min: bounds.min,
      catalog_max: bounds.max,
      from,
      to,
      selected: from !== null || to !== null ? 1 : 0,
    };

    const sorted = sortIds(matched, req.sort, search ? search.hits : null);
    const total = sorted.length;
    const perPage = req.per_page === -1 ? Math.max(1, total) : req.per_page;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(req.page, pages);
    const ids = sorted.slice((page - 1) * perPage, page * perPage);

    return {
      ids,
      total,
      pages,
      page,
      per_page: perPage,
      facets,
      active: activeList(req, catalog),
      corrected: search ? search.corrected : '',
      relaxed: search ? search.relaxed : false,
      sort: req.sort,
      sort_options: req.q !== '' ? Object.assign({ trafnosc: 'Najtrafniejsze' }, SORT_OPTIONS) : SORT_OPTIONS,
      query: req.q,
      request: req,
      price: { min: facets.cena.min, max: facets.cena.max },
      summary,
    };
  }

  /* ------------------------------------------------------------------ *
   * Widok katalogu: archive.php
   * ------------------------------------------------------------------ */

  const plural = (n, one, few, many) => {
    const abs = Math.abs(n);
    if (abs === 1) return one;
    const last = abs % 10;
    const tens = abs % 100;
    return last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? few : many;
  };
  const shopPlural = (n) => plural(n, 'model', 'modele', 'modeli');
  const countLabel = (n) => numberI18n(n) + ' ' + shopPlural(n);
  const numberI18n = (n) => numberFormat(n, 0);

  function currentArchive(path) {
    return D.archives[path] || null;
  }

  function keepsArchive(request, archive) {
    if (!archive || archive.url === '') return false;
    const values = request[archive.facet] || [];
    return values.length === 1 && values[0] === archive.slug;
  }

  const baseUrl = (request, archive) => (keepsArchive(request, archive) ? U(archive.url) : U(D.shop));

  function rawUrlEncode(s) {
    return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  function moneyQuery(v) {
    return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function shopUrl(request, archive) {
    const keeps = keepsArchive(request, archive);
    let base = keeps ? U(archive.url) : U(D.shop);
    const page = parseInt(request.page || 1, 10);
    if (page > 1) base = base.replace(/\/*$/, '/') + 'page/' + page + '/';
    const pairs = [];
    if ((request.q || '') !== '') pairs.push('q=' + rawUrlEncode(request.q));
    for (const key of LIST_KEYS) {
      if (keeps && archive.facet === key) continue;
      const values = (request[key] || []).map(rawUrlEncode);
      if (values.length) pairs.push(key + '=' + values.join(','));
    }
    for (const key of ['cena_od', 'cena_do']) {
      if (request[key] !== null && request[key] !== undefined) pairs.push(key + '=' + rawUrlEncode(moneyQuery(request[key])));
    }
    if (request.nowosci) pairs.push('nowosci=1');
    if (request.promocje) pairs.push('promocje=1');
    const def = defaultSort((request.q || '') !== '', !!request.nowosci);
    if (request.sort && request.sort !== def) pairs.push('sort=' + rawUrlEncode(request.sort));
    return pairs.length ? base + '?' + pairs.join('&') : base;
  }

  function removeUrl(request, archive, key, value) {
    const next = Object.assign({}, request);
    next.page = 1;
    switch (key) {
      case 'q':
        next.q = '';
        next.sort = next.sort === 'trafnosc' ? defaultSort(false, !!next.nowosci) : next.sort;
        break;
      case 'cena':
        next.cena_od = null;
        next.cena_do = null;
        break;
      case 'nowosci':
        next.nowosci = false;
        if ((next.sort || '') === 'nowosci') next.sort = defaultSort((next.q || '') !== '', false);
        break;
      case 'promocje':
        next.promocje = false;
        break;
      default:
        next[key] = (next[key] || []).filter((v) => v !== value);
    }
    return shopUrl(next, archive);
  }

  function clearUrl(request, archive) {
    const def = defaultSort((request.q || '') !== '', !!request.nowosci);
    const next = {
      q: request.q || '',
      page: 1,
      sort: (request.sort || '') === def ? '' : request.sort || '',
      cena_od: null,
      cena_do: null,
    };
    for (const key of LIST_KEYS) next[key] = [];
    if (archive) next[archive.facet] = [archive.slug];
    return shopUrl(next, archive);
  }

  function filterCount(ctx) {
    let count = 0;
    const own = keepsArchive(ctx.request, ctx.archive);
    for (const item of ctx.result.active) {
      if (item.key === 'q') continue;
      if (own && item.key === ctx.archive.facet && item.value === ctx.archive.slug) continue;
      count++;
    }
    return count;
  }

  function makersText(makers) {
    const count = makers.length;
    if (count === 0) return '';
    const names = makers.slice(0, 3).map((o) => o.label);
    if (count <= 3) {
      return 'od ' + (names.length > 1 ? names.slice(0, -1).join(', ') + ' i ' + names[names.length - 1] : names[0]);
    }
    const rest = count - 3;
    return 'od ' + names.join(', ') + ' i ' + rest + ' ' + plural(rest, 'innego producenta', 'innych producentów', 'innych producentów');
  }

  function heading(ctx) {
    const result = ctx.result;
    const request = ctx.request;
    const archive = ctx.archive;
    const total = result.total;
    const names = (options, limit) => options.slice(0, limit === undefined ? 3 : limit).map((o) => o.label).join(', ');
    const scales = result.summary.skala;
    const makers = result.summary.producent;
    const brands = result.summary.marka;

    let scaleText = '';
    if (scales.length === 1) scaleText = 'w skali ' + scales[0].label;
    else if (scales.length > 1) scaleText = 'w skalach ' + scales.map((o) => o.label).join(', ');
    const makerCount = makers.length;

    const head = { eyebrow: 'Katalog', title: 'Wszystkie <em>modele</em>', title_text: 'Wszystkie modele', lead: '' };

    if (request.q !== '') {
      head.eyebrow = 'Wyszukiwanie';
      if (total === 0) {
        head.title = 'Brak wyników dla <em>„' + escHtml(request.q) + '”</em>';
        head.title_text = 'Brak wyników dla „' + request.q + '”';
      } else {
        const shown = String(result.corrected) !== '' ? String(result.corrected) : request.q;
        head.title = 'Wyniki dla <em>„' + escHtml(shown) + '”</em>';
        head.title_text = 'Wyniki dla „' + shown + '”';
      }
      head.lead = '';
      return head;
    }

    let single = null;
    if (keepsArchive(request, archive)) {
      single = { facet: archive.facet, label: archive.name, value: archive.slug, description: archive.description };
    } else {
      const chosen = result.active.filter((i) => ['marka', 'producent', 'skala', 'kolekcja'].includes(i.key));
      if (chosen.length === 1) {
        single = { facet: chosen[0].key, label: chosen[0].label, value: chosen[0].value, description: '' };
      }
    }

    if (single) {
      const label = String(single.label);
      switch (single.facet) {
        case 'marka': {
          head.eyebrow = 'Marka samochodu';
          head.title = escHtml(label);
          head.title_text = label + ' – modele kolekcjonerskie';
          const parts = [scaleText, makerCount ? makersText(makers) : ''].filter(Boolean);
          head.lead = total && parts.length ? 'Modele ' + label + ' ' + parts.join(', ') + '.' : '';
          break;
        }
        case 'producent': {
          head.eyebrow = 'Producent modelu';
          head.title = escHtml(label);
          head.title_text = label + ' – modele kolekcjonerskie';
          const top = names(brands);
          head.lead = total ? ('Modele ' + label + (scaleText ? ' ' + scaleText : '') + (top ? '. Najwięcej: ' + top : '')).trim() + '.' : '';
          break;
        }
        case 'skala': {
          head.eyebrow = 'Skala';
          head.title = 'Skala <em>' + escHtml(label) + '</em>';
          head.title_text = 'Skala ' + label + ' – modele samochodów';
          const number = scaleNumber(label);
          const intro = number && number < 9999 ? 'Model w skali ' + label + ' jest ' + number + ' razy mniejszy od prawdziwego samochodu.' : '';
          head.lead = (intro + (total && makerCount > 1 ? ' W ofercie modele od ' + makerCount + ' ' + plural(makerCount, 'producenta', 'producentów', 'producentów') + '.' : '')).trim();
          break;
        }
        case 'kolekcja': {
          head.eyebrow = 'Kolekcja';
          head.title = escHtml(label);
          head.title_text = label + ' – kolekcja modeli';
          const top = names(brands, 4);
          head.lead = single.description !== '' ? single.description : total && top ? 'W kolekcji między innymi: ' + top + '.' : '';
          break;
        }
        case 'material':
          head.eyebrow = 'Materiał';
          head.title = escHtml(label);
          head.title_text = 'Modele: ' + label;
          head.lead = total && scaleText ? 'Modele ' + scaleText + (makerCount ? ', ' + makersText(makers) : '') + '.' : '';
          break;
        case 'otwierane': {
          const display = (VALUE_LABELS.otwierane[single.value] !== undefined ? VALUE_LABELS.otwierane[single.value] : label);
          head.eyebrow = 'Otwierane elementy';
          head.title = escHtml(display);
          head.title_text = 'Modele ' + display.toLowerCase();
          head.lead = total && scaleText ? 'Modele ' + scaleText + '.' : '';
          break;
        }
        default:
          head.title = escHtml(label);
          head.title_text = label;
      }
      if (single.description !== '' && single.facet !== 'kolekcja') head.lead = single.description;
      return head;
    }

    const picked = result.active.filter((i) => ['marka', 'producent', 'kolekcja'].includes(i.key));
    const pickedScales = result.active.filter((i) => i.key === 'skala');
    if (picked.length || pickedScales.length) {
      if (picked.length <= 2 && pickedScales.length <= 1) {
        const words = picked.map((i) => String(i.label)).join(' i ');
        const scale = pickedScales.length ? String(pickedScales[0].label) : '';
        head.title = (escHtml(words) + (scale !== '' ? ' <em>' + escHtml(scale) + '</em>' : '')).trim();
        head.title_text = (words + ' ' + scale).trim() + ' – modele kolekcjonerskie';
      } else {
        head.title = 'Wybrane <em>modele</em>';
        head.title_text = 'Wybrane modele';
      }
    } else if (result.active.some((i) => !['nowosci', 'promocje'].includes(i.key))) {
      head.title = 'Wybrane <em>modele</em>';
      head.title_text = 'Wybrane modele';
    }

    if (request.nowosci) {
      head.eyebrow = 'Nowości';
      head.title = 'Nowości <em>w ofercie</em>';
      head.title_text = 'Nowości';
      head.lead = total ? 'Modele z listy nowości sklepu, od najnowszych.' : '';
      return head;
    }
    if (request.promocje) {
      head.eyebrow = 'Oferta';
      head.title = 'Modele <em>w promocji</em>';
      head.title_text = 'Modele w promocji';
      return head;
    }

    if (total) {
      const bits = [];
      if (scales.length) {
        bits.push(scales.length > 1 ? 'w skalach od ' + scales[0].label + ' do ' + scales[scales.length - 1].label : 'w skali ' + scales[0].label);
      }
      if (makerCount > 1) bits.push('od ' + makerCount + ' ' + plural(makerCount, 'producenta', 'producentów', 'producentów'));
      head.lead = bits.length ? 'Modele kolekcjonerskie ' + bits.join(', ') + '.' : '';
    }
    return head;
  }

  function breadcrumbItems(ctx) {
    const items = [['Strona główna', U('/')]];
    const shop = U(D.shop);
    if (ctx.request.q !== '') {
      items.push(['Modele', shop], ['Wyszukiwanie']);
      return items;
    }
    if (ctx.archive && keepsArchive(ctx.request, ctx.archive)) {
      items.push(['Modele', shop], [ctx.archive.name]);
      return items;
    }
    if (ctx.request.nowosci) {
      items.push(['Modele', shop], ['Nowości']);
      return items;
    }
    items.push(['Modele']);
    return items;
  }

  /* ------------------------------------------------------------------ *
   * Tytuł dokumentu (moduł SEO, wycinek dla katalogu)
   * ------------------------------------------------------------------ */

  const BRAND = 'ModelCarShop';

  function seoTitle(core, paged) {
    let title = String(core).trim();
    if (paged > 1) title += ' – strona ' + paged;
    const suffix = ' | ' + BRAND;
    if (!title.toLowerCase().includes(BRAND.toLowerCase()) && Array.from(title + suffix).length <= 72) title += suffix;
    return title;
  }

  function termCopyTitle(info) {
    switch (info.taxonomy) {
      case 'pa_marka': return 'Modele ' + info.name + ' – kolekcjonerskie modele samochodów';
      case 'pa_producent': return info.name + ' – modele samochodów';
      case 'pa_skala': return 'Modele samochodów w skali ' + info.name;
      case 'pa_material': return 'Modele samochodów: ' + info.name.toLowerCase();
      case 'pa_otwierane': return info.slug === 'tak' ? 'Modele z otwieranymi elementami' : 'Modele bez otwieranych elementów';
      default: return info.name + ' – kolekcja modeli samochodów';
    }
  }

  function termBySlug(facet, slug) {
    const list = archiveByFacet[facet] || {};
    return list[slug] || null;
  }

  function documentTitle(ctx, params, paged) {
    const term = ctx.archive;
    const headingText = heading(ctx).title_text;
    const paramTerm = (key, facet) => {
      if (params[key] === undefined || String(params[key]).includes(',')) return null;
      return termBySlug(facet, sanitizeTitle(params[key]));
    };
    const brand = term && term.taxonomy === 'pa_marka' ? term : paramTerm('marka', 'marka');
    const scale = term && term.taxonomy === 'pa_skala' ? term : paramTerm('skala', 'skala');
    const taxonomy = term ? term.taxonomy : '';
    const handled = [];
    if (brand && taxonomy !== 'pa_marka') handled.push('marka');
    if (scale && taxonomy !== 'pa_skala') handled.push('skala');
    const extra = Object.keys(params).filter((k) => !handled.includes(k));
    const brandScale = brand && scale && !extra.length && (taxonomy === '' || ['pa_marka', 'pa_skala'].includes(taxonomy));

    if (!term && Object.keys(params).length === 1) {
      for (const [key, facet] of [['marka', 'marka'], ['producent', 'producent'], ['skala', 'skala'], ['kolekcja', 'kolekcja']]) {
        const alias = paramTerm(key, facet);
        if (alias) return seoTitle(termCopyTitle(alias), paged);
      }
    }
    if (brandScale) return seoTitle('Modele ' + brand.name + ' w skali ' + scale.name, paged);

    if (!term) {
      if (params.q !== undefined) return seoTitle('Wyniki wyszukiwania: ' + Array.from(String(params.q)).slice(0, 60).join(''), paged);
      if (params.nowosci !== undefined && Object.keys(params).length === 1) return seoTitle('Nowości – najnowsze modele samochodów', paged);
      if (Object.keys(params).length) return seoTitle(headingText || 'Wybrane modele samochodów', paged);
      return seoTitle('Modele samochodów – katalog dla kolekcjonerów', paged);
    }

    let core = termCopyTitle(term);
    if (Object.keys(params).length) core = headingText || core;
    return term.seo_title && !Object.keys(params).length ? term.seo_title : seoTitle(core, paged);
  }

  /* ------------------------------------------------------------------ *
   * Szablony fragmentów (shop/hero, chips, results, pagination, empty)
   * ------------------------------------------------------------------ */

  function escHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  const escAttr = escHtml;
  const escUrl = (url) => escHtml(url);
  const icon = (name) => (D.icons && D.icons[name]) || '';

  function breadcrumbsHtml(items) {
    let html = '<nav class="breadcrumbs" aria-label="Ścieżka nawigacji"><ol>';
    const last = items.length - 1;
    items.forEach((item, i) => {
      const label = escHtml(item[0]);
      if (i === last || !item[1]) html += '<li><span' + (i === last ? ' aria-current="page"' : '') + '>' + label + '</span></li>';
      else html += '<li><a href="' + escUrl(item[1]) + '">' + label + '</a></li>';
    });
    return html + '</ol></nav>';
  }

  function heroHtml(ctx) {
    const head = heading(ctx);
    const total = ctx.result.total;
    return '<header class="shop-hero">\n  <div class="container">\n    ' + breadcrumbsHtml(breadcrumbItems(ctx)) +
      '    <div class="shop-hero__grid">\n      <div class="shop-hero__text">\n        <p class="eyebrow">' + escHtml(head.eyebrow) + '</p>\n        <h1>' + head.title + '</h1>\n' +
      (head.lead !== '' ? '                  <p class="shop-hero__lead">' + escHtml(head.lead) + '</p>\n' : '') +
      '              </div>\n' +
      (total > 0 ? '              <p class="shop-hero__count"><strong class="num">' + escHtml(numberI18n(total)) + '</strong> <span>' + escHtml(shopPlural(total)) + '</span></p>\n' : '') +
      '          </div>\n    <div class="ruler shop-hero__ruler" aria-hidden="true"></div>\n  </div>\n</header>\n';
  }

  function chipsHtml(ctx) {
    const active = ctx.result.active;
    const archive = ctx.archive;
    const own = keepsArchive(ctx.request, archive);
    const visible = active.filter((item) => !(own && item.key === archive.facet && item.value === archive.slug));
    if (!visible.length) return '';
    const onlyQuery = visible.length === 1 && visible[0].key === 'q';
    let html = '<div class="shop-chips">\n  <ul class="shop-chips__list" aria-label="Aktywne filtry">\n';
    for (const item of visible) {
      html += '          <li>\n        <a class="chip shop-chip" href="' + escUrl(removeUrl(ctx.request, archive, item.key, String(item.value))) + '" data-shop-link>\n          <span class="sr-only">Usuń filtr ' + escHtml(item.group) +
        ': </span>\n          <small aria-hidden="true">' + escHtml(item.group) + '</small>\n          <span>' + escHtml(item.label) + '</span>\n          ' + icon('close') + '        </a>\n      </li>\n';
    }
    html += '      </ul>\n';
    if (!onlyQuery && visible.length > 1) {
      let clear;
      if (ctx.request.q !== '') {
        const emptied = Object.assign({}, ctx.request, { marka: [], producent: [], skala: [], material: [], dostepnosc: [], otwierane: [], kolekcja: [], cena_od: null, cena_do: null, nowosci: false, promocje: false });
        clear = removeUrl(emptied, archive, 'q', '');
      } else {
        clear = ctx.clear_url;
      }
      html += '      <a class="shop-chips__clear" href="' + escUrl(clear) + '" data-shop-link>Wyczyść wszystkie</a>\n';
    }
    return html + '  </div>\n';
  }

  function cardHtml(id, eager) {
    let html = cards[String(id)] || '';
    if (eager) {
      html = html.replace(' loading="lazy"', ' loading="eager" fetchpriority="high"').replace('sizes="auto, ', 'sizes="');
    }
    return html;
  }

  function paginationHtml(ctx) {
    const page = ctx.result.page;
    const pages = ctx.result.pages;
    if (pages < 2) return '';
    const link = (n) => shopUrl(Object.assign({}, ctx.request, { page: n }), ctx.archive);
    const numbers = Array.from(new Set([1, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages))).sort((a, b) => a - b);
    let html = '<nav class="pagination shop-pagination" aria-label="Strony wyników">\n';
    if (page > 1) html += '      <a class="page-numbers prev" rel="prev" href="' + escUrl(link(page - 1)) + '" data-shop-link data-shop-scroll aria-label="Poprzednia strona">' + icon('chevron-left') + '</a>\n';
    let prev = 0;
    for (const n of numbers) {
      if (n - prev > 1) html += '<span class="page-numbers dots" aria-hidden="true">…</span>';
      if (n === page) html += '<span class="page-numbers current" aria-current="page"><span class="sr-only">Strona </span>' + n + '</span>';
      else html += '<a class="page-numbers" href="' + escUrl(link(n)) + '" data-shop-link data-shop-scroll><span class="sr-only">Strona </span>' + n + '</a>';
      prev = n;
    }
    if (page < pages) html += '      <a class="page-numbers next" rel="next" href="' + escUrl(link(page + 1)) + '" data-shop-link data-shop-scroll aria-label="Następna strona">' + icon('chevron-right') + '</a>\n';
    return html + '</nav>\n';
  }

  function emptyHtml(ctx) {
    const result = ctx.result;
    const request = ctx.request;
    const q = String(request.q);
    const corrected = String(result.corrected);
    const filters = filterCount(ctx);
    const archive = ctx.archive;

    let withoutFilters = 0;
    if (filters > 0) {
      const base = { q, per_page: 1 };
      if (archive) base[archive.facet] = [archive.slug];
      withoutFilters = shopQuery(base).total;
    }

    let correctedUrl = '';
    if (corrected !== '') {
      let state = Object.assign({}, request, { q: corrected, page: 1, sort: 'trafnosc' });
      if (shopQuery(Object.assign({}, state, { per_page: 1 })).total === 0) state = { q: corrected, page: 1 };
      correctedUrl = shopUrl(state, archive);
    }

    const clear = ctx.clear_url;
    const brands = D.nav.brands.slice(0, 8);
    const scales = D.nav.scales;

    let html = '<section class="empty shop-empty" aria-labelledby="shop-empty-title">\n  <div class="ruler" aria-hidden="true"></div>\n  <h2 id="shop-empty-title">\n';
    if (correctedUrl !== '') html += '          Czy chodziło Ci o <a href="' + escUrl(correctedUrl) + '" data-shop-link><em>„' + escHtml(corrected) + '”</em></a>?\n';
    else if (q !== '') html += '          Nie mamy takiego <em>modelu</em>\n';
    else html += '          Żaden model nie spełnia tych <em>filtrów</em>\n';
    html += '      </h2>\n\n';
    if (q !== '' && correctedUrl !== '') {
      if (filters > 0) html += '    <p>Z wybranymi filtrami nie ma takiego modelu.</p>\n';
    } else if (q !== '') {
      html += '    <p>Sprawdź pisownię albo wpisz samą markę, model lub numer katalogowy, na przykład „Porsche 911” albo „GT435”.</p>\n';
    } else {
      html += '    <p>Usuń część zaznaczeń, aby zobaczyć więcej modeli.</p>\n';
    }
    html += '\n  <div class="empty__actions">\n';
    if (filters > 0) {
      html += '      <a class="btn btn--primary" href="' + escUrl(clear) + '" data-shop-link>\n        Wyczyść filtry' + (withoutFilters > 0 ? ' (' + escHtml(countLabel(withoutFilters)) + ')' : '') + '      </a>\n';
    }
    html += '    <a class="btn btn--ghost" href="' + escUrl(U(D.shop)) + '">Wszystkie modele</a>\n  </div>\n\n';
    if (brands.length) {
      html += '    <div class="shop-empty__group">\n      <h3>Popularne marki</h3>\n      <ul class="shop-empty__chips">\n';
      for (const t of brands) html += '          <li><a class="chip" href="' + escUrl(U(t.url)) + '">' + escHtml(t.name) + ' <small>' + t.count + '</small></a></li>\n';
      html += '      </ul>\n    </div>\n';
    }
    if (scales.length) {
      html += '      <div class="shop-empty__group">\n      <h3>Skale</h3>\n      <ul class="shop-empty__chips">\n';
      for (const t of scales) html += '          <li><a class="chip" href="' + escUrl(U(t.url)) + '">' + escHtml(t.name) + ' <small>' + t.count + '</small></a></li>\n';
      html += '      </ul>\n    </div>\n';
    }
    return html + '  </section>\n';
  }

  function resultsHtml(ctx) {
    const result = ctx.result;
    const request = ctx.request;
    if (!result.ids.length) return emptyHtml(ctx);
    let html = '';
    const corrected = String(result.corrected);
    if (request.q !== '' && (corrected !== '' || result.relaxed)) {
      html += '  <div class="notice shop-note" role="status">\n    <p>\n';
      if (corrected !== '') html += '              Poprawiliśmy pisownię: szukamy <strong>„' + escHtml(corrected) + '”</strong> zamiast „' + escHtml(request.q) + '”.\n';
      if (result.relaxed) html += '              Żaden model nie pasuje do wszystkich słów, więc pokazujemy najbliższe.\n';
      html += '          </p>\n  </div>\n';
    }
    html += '\n<div class="grid grid--products">\n';
    result.ids.forEach((id, i) => {
      html += '  ' + cardHtml(id, result.page === 1 && i < 3) + '\n';
    });
    html += '</div>\n\n';
    return html + paginationHtml(ctx);
  }

  /* ------------------------------------------------------------------ *
   * Wejście: adres strony → dane dla shop.js
   * ------------------------------------------------------------------ */

  function parseUrlInput(url) {
    const u = new URL(url, location.href);
    let path = u.pathname;
    if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
    let paged = 1;
    const pm = /^(.*\/)page\/(\d+)\/?$/.exec(path);
    if (pm) {
      path = pm[1];
      paged = parseInt(pm[2], 10) || 1;
    }
    if (!path.endsWith('/')) path += '/';
    const input = {};
    for (const [rawKey, value] of u.searchParams) {
      if (rawKey.endsWith('[]')) {
        const key = rawKey.slice(0, -2);
        if (!Array.isArray(input[key])) input[key] = [];
        input[key].push(value);
      } else {
        input[rawKey] = value;
      }
    }
    return { path, paged, input };
  }

  function buildContext(url) {
    const { path, paged, input } = parseUrlInput(url);
    const archive = currentArchive(path);
    const req = Object.assign({}, input);
    delete req.per_page;
    delete req.only_ids;
    delete req._mcs;
    if (!req.q && req.s && !Array.isArray(req.s)) req.q = String(req.s);
    if (archive && !req.f) {
      const values = listParam(req[archive.facet]);
      if (!values.includes(archive.slug)) values.push(archive.slug);
      req[archive.facet] = values;
    }
    req.page = Math.max(1, paged);
    const result = shopQuery(req);
    const request = Object.assign({}, result.request);
    request.page = result.page;
    const ctx = { archive, request, result };
    ctx.base_url = baseUrl(request, archive);
    ctx.url = shopUrl(request, archive);
    ctx.clear_url = clearUrl(request, archive);

    // Parametry jak w module SEO: bez technicznych.
    const ignored = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'fbclid', 'ref', 'v', 'paged', 'strona', 'f', '_mcs'];
    const params = {};
    for (const key of Object.keys(input)) {
      const low = key.toLowerCase();
      if (ignored.includes(low)) continue;
      const flat = Array.isArray(input[key]) ? input[key].join(',') : String(input[key]);
      if (flat.trim() !== '') params[low] = flat.trim();
    }
    ctx.seoParams = params;
    ctx.seoPaged = paged;
    return ctx;
  }

  function fragments(url) {
    const ctx = buildContext(url);
    const result = ctx.result;
    const facets = {};
    for (const key of SHOP_FACETS) {
      const options = {};
      for (const option of result.facets[key].options) options[option.value] = [option.count, option.active ? 1 : 0];
      facets[key] = { selected: result.facets[key].selected, options };
    }
    const price = result.facets.cena;
    return {
      url: ctx.url,
      base_url: ctx.base_url,
      clear_url: ctx.clear_url,
      title: documentTitle(ctx, ctx.seoParams, ctx.seoPaged),
      total: result.total,
      label: countLabel(result.total),
      filters: filterCount(ctx),
      sort: result.sort,
      sort_options: result.sort_options,
      facets,
      price: { min: price.min, max: price.max, from: price.from, to: price.to },
      state: {
        q: ctx.request.q,
        kolekcja: ctx.request.kolekcja,
        nowosci: !!ctx.request.nowosci,
        promocje: !!ctx.request.promocje,
      },
      html: { hero: heroHtml(ctx), chips: chipsHtml(ctx), results: resultsHtml(ctx) },
    };
  }

  /* ------------------------------------------------------------------ *
   * Podpowiedzi: mcs_search_suggest
   * ------------------------------------------------------------------ */

  function nameScore(queryTokens, nameTokens) {
    let best = 0;
    for (let token of queryTokens) {
      token = String(token);
      if (token === '' || token[0] === '@') continue;
      const targets = [token].concat(aliasMap.get(token) || []);
      for (let word of nameTokens) {
        word = String(word);
        for (const target of targets) {
          if (target === word) best = Math.max(best, 3);
          else if (target.length >= 2 && word.startsWith(target)) best = Math.max(best, 2);
        }
        const max = maxEdits(token.length);
        if (max > 0 && !hasDigit(token) && word.length >= 4 && word[0] === token[0] && distance(token, word, max) <= max) {
          best = Math.max(best, 1);
        }
      }
    }
    return best;
  }

  function suggestTerms(facet, nameCol, valuesCol, search, limit) {
    const toks = search.tokens;
    if (!toks.length) return [];
    const names = new Map();
    for (const row of searchable) {
      const list = String(row[nameCol]).split(',').map((s) => s.trim());
      row[valuesCol].forEach((slug, i) => {
        if (!names.has(slug)) names.set(slug, { name: list[i] !== undefined ? list[i] : slug, count: 0 });
        names.get(slug).count++;
      });
    }
    let out = [];
    for (const [slug, info] of names) {
      const nameTokens = tokens(fold(info.name));
      const score = nameScore(toks, nameTokens);
      if (score > 0) out.push({ slug: String(slug), name: info.name, count: info.count, score });
    }
    out.sort((a, b) => cmp([b.score, b.count], [a.score, a.count]));
    out = out.slice(0, limit);
    for (const item of out) {
      const term = termBySlug(facet, item.slug);
      item.url = term ? U(term.url) : U(D.shop);
      delete item.score;
    }
    return out;
  }

  function suggestScales(search) {
    const wanted = [];
    for (let token of search.tokens) {
      token = String(token);
      const m = /^@(\d{1,3})$/.exec(token);
      if (m) wanted.push('1-' + m[1]);
      else if (isDigits(token) && token.length === 3 && token[0] === '1') wanted.push('1-' + parseInt(token.slice(1), 10));
    }
    const counts = {};
    for (const row of searchable) for (const slug of row.v_skala) counts[slug] = (counts[slug] || 0) + 1;
    const out = [];
    for (const slug of Array.from(new Set(wanted))) {
      if (!counts[slug]) continue;
      const term = termBySlug('skala', slug);
      if (term) out.push({ slug, name: term.name, count: counts[slug], url: U(term.url) });
    }
    return out;
  }

  function suggest(rawQuery, limit) {
    const lim = limit || 6;
    const query = Array.from(sanitizeText(rawQuery)).slice(0, 80).join('').trim();
    const shop = U(D.shop);
    const empty = { query, corrected: '', relaxed: false, total: 0, all_url: shop, products: [], brands: [], makers: [], scales: [] };
    if (Array.from(query).length < 2) return empty;
    const search = runSearch(query, true);
    const ids = sortIds(Array.from(search.hits.keys()), 'trafnosc', search.hits);
    const products = ids.slice(0, lim).map((id) => {
      const r = rowsById.get(id);
      return {
        id: r.id,
        name: r.display !== '' ? r.display : r.title,
        maker: r.maker_name,
        scale: r.scale_name,
        sku: r.sku,
        price: r.money,
        available: r.in_stock === 1,
        url: U(r.url),
        image: r.image ? U(r.image) : '',
      };
    });
    const out = Object.assign({}, empty);
    out.corrected = search.corrected;
    out.relaxed = search.relaxed;
    out.total = ids.length;
    out.all_url = shop + '?q=' + rawUrlEncode(query);
    out.products = products;
    out.brands = suggestTerms('marka', 'brand_name', 'v_marka', search, 4);
    out.makers = suggestTerms('producent', 'maker_name', 'v_producent', search, 3);
    out.scales = suggestScales(search);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Prezenty: pages/gift.php
   * ------------------------------------------------------------------ */

  let gift = null;

  function giftQuestion(key) {
    return gift.questions.find((q) => q.key === key);
  }

  function giftRule(key, value) {
    const q = giftQuestion(key);
    if (!q) return {};
    const opt = q.options.find((o) => o.value === value);
    return opt && opt.rule && !Array.isArray(opt.rule) ? opt.rule : {};
  }

  function giftState(params) {
    const state = {};
    for (const q of gift.questions) {
      const raw = params.get ? params.get(q.key) : params[q.key];
      if (raw === null || raw === undefined) continue;
      const value = sanitizeKey(String(raw));
      if (value !== '' && q.options.some((o) => o.value === value)) state[q.key] = value;
    }
    return state;
  }

  function pagesSelect(query) {
    return gift.rows.filter((r) => {
      if (query.ready && !r.ready) return false;
      if (query.clean && !r.clean) return false;
      if (query.image && !r.thumb) return false;
      if (query.min !== undefined && r.price < query.min) return false;
      if (query.max !== undefined && r.price > query.max) return false;
      if (query.scales && query.scales.length && !query.scales.includes(r.scale)) return false;
      if (query.materials && query.materials.length && !query.materials.includes(r.material)) return false;
      if (query.opening && r.opening !== query.opening) return false;
      if (query.cats && query.cats.length && !query.cats.some((c) => r.cats.includes(c))) return false;
      if (query.brands && query.brands.length && !query.brands.some((c) => r.brand.includes(c))) return false;
      if (query.makers && query.makers.length && !query.makers.some((c) => r.maker.includes(c))) return false;
      return true;
    });
  }

  function giftRows(state) {
    let query = { ready: true, clean: true, image: true };
    for (const key of Object.keys(state)) {
      const rule = Object.assign({}, giftRule(key, state[key]));
      delete rule.sort;
      query = Object.assign(query, rule);
    }
    return pagesSelect(query);
  }

  function pagesDiverse(rows, limit) {
    const picked = [];
    const rest = [];
    const seen = new Set();
    for (const row of rows) {
      const brand = row.brand[0] !== undefined ? row.brand[0] : 'brak-' + row.id;
      if (!seen.has(brand) && picked.length < limit) {
        seen.add(brand);
        picked.push(row.id);
      } else {
        rest.push(row.id);
      }
    }
    return picked.concat(rest).slice(0, limit);
  }

  function giftShopUrl(state) {
    const filters = { dostepnosc: 'dostepne' };
    const order = ['dostepnosc'];
    const set = (k, v) => {
      if (!(k in filters)) order.push(k);
      filters[k] = v;
    };
    for (const key of Object.keys(state)) {
      const rule = giftRule(key, state[key]);
      if (rule.cats && rule.cats.length) set('kolekcja', rule.cats);
      if (rule.materials && rule.materials.length) set('material', rule.materials);
      if (rule.opening) set('otwierane', rule.opening);
      if (rule.scales && rule.scales.length) set('skala', rule.scales);
      if (rule.min !== undefined || rule.max !== undefined) {
        const min = rule.min !== undefined ? rule.min : null;
        const max = rule.max !== undefined ? rule.max : null;
        if (min !== null && min > 0) set('cena_od', Math.trunc(min));
        if (max !== null) set('cena_do', Math.trunc(max));
      }
    }
    const pairs = [];
    for (const k of order) {
      const v = filters[k];
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
      pairs.push(k + '=' + (Array.isArray(v) ? v.join(',') : v));
    }
    return U(D.shop) + (pairs.length ? '?' + pairs.join('&') : '');
  }

  function giftCompare(sort) {
    return (a, b) => {
      if (sort === 'new') {
        return cmp([a.rank === 0 ? 1 : 0, a.rank, a.photo ? 0 : 1, -a.price], [b.rank === 0 ? 1 : 0, b.rank, b.photo ? 0 : 1, -b.price]);
      }
      if (sort === 'price') return cmp([a.photo ? 0 : 1, a.price, a.id], [b.photo ? 0 : 1, b.price, b.id]);
      return cmp([a.photo ? 0 : 1, a.featured ? 0 : 1, a.rank === 0 ? 1 : 0, a.rank, a.price], [b.photo ? 0 : 1, b.featured ? 0 : 1, b.rank === 0 ? 1 : 0, b.rank, b.price]);
    };
  }

  function giftFind(state, limit) {
    const lim = limit || 8;
    let attempt = Object.assign({}, state);
    let rows = giftRows(attempt);
    let relaxed = [];
    if (!rows.length) {
      const answered = ['miejsce', 'komu', 'pasja'].filter((key) => state[key] !== undefined && Object.keys(giftRule(key, state[key])).length > 0);
      const n = answered.length;
      const sets = [];
      for (let mask = 1; mask < 1 << n; mask++) {
        const set = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) set.push(answered[i]);
        sets.push(set);
      }
      sets.sort((a, b) => a.length - b.length);
      for (const set of sets) {
        const tryState = Object.assign({}, state);
        for (const k of set) delete tryState[k];
        const found = giftRows(tryState);
        if (found.length) {
          rows = found;
          attempt = tryState;
          relaxed = set;
          break;
        }
      }
    }

    const komu = attempt.komu ? giftRule('komu', attempt.komu) : {};
    const sort = komu.sort || 'default';
    rows = rows.slice().sort(giftCompare(sort));

    const why = [];
    for (const key of Object.keys(attempt)) {
      const q = giftQuestion(key);
      const opt = q && q.options.find((o) => o.value === attempt[key]);
      const reason = opt ? String(opt.why) : '';
      if (reason !== '') why.push(reason.charAt(0).toLocaleUpperCase('pl') + reason.slice(1));
    }
    const relaxedLabels = relaxed.map((key) => ({ miejsce: 'miejsce na model', komu: 'dopasowanie do osoby', pasja: 'temat' }[key]));

    return {
      ids: pagesDiverse(rows, lim),
      total: rows.length,
      answered: Object.keys(state).length,
      state,
      relaxed: relaxedLabels,
      why,
      shop_url: giftShopUrl(attempt),
    };
  }

  const pagesModels = (n) => numberI18n(n) + NBSP + plural(n, 'model', 'modele', 'modeli');

  /** Karta bez własnego „sizes” (prezenty, lista życzeń). */
  function cardDefault(id) {
    const key = String(id);
    if (cardOverrides[key]) return cardOverrides[key];
    const html = (cards && cards[key]) || '';
    return html.split(SIZES_CATALOG).join(SIZES_DEFAULT);
  }

  function giftHtml(result) {
    if (!result || !result.answered) return '';
    const total = result.total;
    const products = result.ids;
    let html = '<div class="gift-res__head">\n  <div>\n    <p class="eyebrow">Propozycje</p>\n    <h2 class="gift-res__title" tabindex="-1" data-gift-results-title>\n';
    if (total > 0) html += '              ' + escHtml(plural(total, 'Pasuje', 'Pasują', 'Pasuje')) + ' <em>' + escHtml(pagesModels(total)) + '</em>\n';
    else html += '              Nie mamy modelu w tym budżecie\n';
    html += '          </h2>\n';
    if (result.why.length) {
      html += '          <ul class="gift-res__why" aria-label="Zastosowane filtry">\n';
      for (const reason of result.why) html += '                  <li class="spec-chip">' + escHtml(reason) + '</li>\n';
      html += '              </ul>\n';
    }
    html += '      </div>\n';
    if (total > products.length && products.length) {
      html += '      <a class="link-arrow" href="' + escUrl(result.shop_url) + '">Więcej w katalogu' + icon('arrow') + '</a>\n';
    }
    html += '  </div>\n\n';
    if (result.relaxed.length && total > 0) {
      html += '  <p class="notice gift-res__notice">Nie mamy modelu spełniającego wszystkie warunki, więc pominęliśmy: ' + escHtml(result.relaxed.join(', ')) + '.</p>\n';
    }
    html += '\n';
    if (products.length) {
      html += '  <div class="grid grid--products">\n';
      for (const id of products) html += '      ' + cardDefault(id) + '\n';
      html += '      </div>\n';
    } else {
      html += '  <div class="empty gift-res__empty">\n    <p class="muted">Zmień budżet albo napisz do nas. Podpowiemy, co może się spodobać.</p>\n    <div class="empty__actions">\n      <a class="btn btn--ghost" href="' + escUrl(U('/kontakt/')) + '">Zapytaj o model</a>\n    </div>\n  </div>\n';
    }
    return html;
  }

  function giftApi(params) {
    const state = giftState(params);
    const result = giftFind(state);
    return {
      total: result.total,
      label: pagesModels(result.total),
      answered: result.answered,
      relaxed: result.relaxed,
      html: giftHtml(result),
    };
  }

  /* ------------------------------------------------------------------ *
   * Inicjalizacja
   * ------------------------------------------------------------------ */

  function setData(data) {
    D = data;
    rowsList = data.rows.map((r) => {
      const row = Object.assign({}, r);
      const split = (v) => (v === '' ? [] : String(v).split(','));
      row.v_marka = split(r.brand);
      row.v_producent = split(r.maker);
      row.v_skala = split(r.scale);
      row.v_material = split(r.material);
      row.v_otwierane = split(r.opening);
      row.v_kolekcja = split(r.collections);
      row.v_dostepnosc = [r.availability === 'out' ? 'niedostepne' : r.availability === 'verify' ? 'do-potwierdzenia' : 'dostepne'];
      return row;
    });
    rowsById = new Map(rowsList.map((r) => [r.id, r]));
    searchable = rowsList.filter((r) => r.in_search === 1);
    stopSet = new Set(data.search.stopwords);
    aliasMap = new Map(Object.entries(data.search.aliases));
    scaleSet = new Set(data.search.scales);
    collectionNames = data.collections || {};
    archiveByFacet = {};
    for (const info of Object.values(data.archives)) {
      (archiveByFacet[info.facet] = archiveByFacet[info.facet] || {})[info.slug] = info;
    }
    corpus = null;
    displayMap = null;
    facetCatalogCache = null;
  }

  function setCards(data) {
    cards = data.cards || {};
    cardOverrides = data.defaults || {};
  }

  function setGift(data) {
    gift = data;
  }

  /* API dla preview.js i testów zgodności. */
  PV.engine = {
    setData,
    setCards,
    setGift,
    fold,
    compact,
    parse,
    suggest,
    fragments,
    giftApi,
    giftFind,
    cardDefault,
    shopQuery,
    /** Jak mcs_shop_query(['q'=>q,'per_page'=>-1]): pełna lista identyfikatorów i poprawka. */
    searchAll(q) {
      const r = shopQuery({ q, per_page: -1 });
      return { ids: r.ids, corrected: r.corrected, relaxed: r.relaxed, total: r.total };
    },
    get ready() {
      return !!D;
    },
  };
})();

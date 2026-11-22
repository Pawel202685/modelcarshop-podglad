/*
 * Podgląd „Zobacz model na swojej półce”.
 *
 * Scena, cień, model i linijka są rysowane na jednym płótnie. Skala pochodzi wyłącznie z danych:
 * potwierdzona długość modelu (mm) i skala sceny (piksele na milimetr). Pikseli modelu nie
 * zmieniamy: bez filtrów, korekt kolorów ani wyostrzania. Własne zdjęcie zostaje w przeglądarce.
 */
(function () {
  'use strict';

  const root = document.querySelector('[data-shelf-dialog]');
  const dataEl = document.getElementById('shelf-config');
  if (!root || !dataEl) return;

  let config;
  try {
    config = JSON.parse(dataEl.textContent);
  } catch (err) {
    return;
  }

  const M = window.MCS || {};
  const q = (s) => root.querySelector(s);
  const qa = (s) => Array.from(root.querySelectorAll(s));
  const el = {
    stage: q('[data-shelf-stage]'),
    canvas: q('[data-shelf-canvas]'),
    hint: q('[data-shelf-hint]'),
    overlay: q('[data-shelf-overlay]'),
    overlayText: q('[data-shelf-overlay-text]'),
    spinner: q('[data-shelf-spinner]'),
    retry: q('[data-shelf-retry]'),
    drop: q('[data-shelf-drop]'),
    fileError: q('[data-shelf-file-error]'),
    calibrate: q('[data-shelf-calibrate]'),
    calTitle: q('[data-shelf-cal-title]'),
    steps: q('[data-shelf-steps]'),
    side: q('.shelf__side'),
    measure: q('[data-shelf-measure]'),
    line: q('[data-shelf-line]'),
    form: q('[data-shelf-form]'),
    cm: q('[data-shelf-cm]'),
    cmError: q('[data-shelf-cm-error]'),
    photoActions: q('[data-shelf-photo-actions]'),
    remeasure: q('[data-shelf-remeasure]'),
    clear: q('[data-shelf-clear]'),
    ruler: q('[data-shelf-ruler]'),
    zoom: q('[data-shelf-zoom]'),
    zoomLabel: q('[data-shelf-zoom-label]'),
    save: q('[data-shelf-save]'),
    basis: q('[data-shelf-basis]'),
    live: q('[data-shelf-live]'),
  };
  const ctx = el.canvas.getContext('2d');
  const handles = { a: q('[data-shelf-handle="a"]'), b: q('[data-shelf-handle="b"]') };

  const product = config.product;
  const cutout = config.cutout;
  const [bx, , bw] = cutout.bbox;
  const FONT = "Archivo, 'Helvetica Neue', Arial, sans-serif";
  const MAX_FILE = 15 * 1024 * 1024;
  const MIME = ['image/jpeg', 'image/png', 'image/webp'];
  const PHOTO_MAX_SIDE = 2400;

  const state = {
    sceneId: config.scenes[0].id,
    positions: {},   // środek modelu w pikselach sceny
    ruler: true,
    zoom: false,
    opened: false,
    interacted: false,
    measuring: false,
  };
  let cutoutImg = null;
  let shadows = null;
  let photo = null;
  const imageCache = new Map();

  if (window.matchMedia('(pointer: coarse)').matches) el.hint.textContent = 'Przesuń model palcem';

  /* ---------- Formaty i pomocnicze ---------- */
  const cmText = (mm) => (mm / 10).toFixed(1).replace('.', ',') + ' cm';
  const cmWhole = (mm) => {
    const cm = mm / 10;
    return (Number.isInteger(cm) ? String(cm) : cm.toFixed(1).replace('.', ',')) + ' cm';
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mkCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };

  function loadImage(url) {
    if (imageCache.has(url)) return imageCache.get(url);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Nie udało się wczytać obrazu.'));
      img.src = url;
    });
    imageCache.set(url, promise);
    promise.catch(() => imageCache.delete(url));
    return promise;
  }

  /* ---------- Sceny ---------- */
  function sceneData(id) {
    if (id === 'photo') {
      if (!photo) return null;
      return {
        id: 'photo',
        isPhoto: true,
        w: photo.width,
        h: photo.height,
        img: photo.canvas,
        pxPerMm: photo.pxPerMm,
        baseline: photo.baseline,
        surface: null,
        shadow: { dx: 0.12, opacity: 0.5 },
        reflect: 0,
        frontY: photo.height,
        ink: 'light',
        name: 'Twoje zdjęcie',
      };
    }
    const s = config.scenes.find((x) => x.id === id);
    if (!s) return null;
    return {
      id: s.id,
      isPhoto: false,
      w: s.width,
      h: s.height,
      img: s.image || null,
      pxPerMm: s.pxPerMm,
      baseline: s.baseline,
      surface: s.surface,
      shadow: s.shadow,
      reflect: s.reflect,
      frontY: s.frontY || s.height,
      ink: s.ink,
      placeX: s.placeX,
      name: s.name,
      raw: s,
    };
  }

  const current = () => sceneData(state.sceneId);

  function positionOf(sc) {
    if (!state.positions[sc.id]) {
      state.positions[sc.id] = {
        x: sc.isPhoto ? photo.startX : sc.placeX || sc.w / 2,
        y: sc.isPhoto ? photo.baseline : sc.baseline,
      };
    }
    return state.positions[sc.id];
  }

  // Zakres, w którym może stać środek modelu. Model nie wychodzi poza powierzchnię.
  function travel(sc) {
    const len = product.lengthMm * sc.pxPerMm;
    let lo = len / 2 + 4;
    let hi = sc.w - len / 2 - 4;
    if (sc.surface) {
      lo = Math.max(lo, sc.surface.x0 + len / 2);
      hi = Math.min(hi, sc.surface.x1 - len / 2);
    }
    if (lo > hi) {
      const mid = sc.surface ? (Math.max(0, sc.surface.x0) + Math.min(sc.w, sc.surface.x1)) / 2 : sc.w / 2;
      lo = mid;
      hi = mid;
    }
    return { lo, hi, len };
  }

  function moveModel(sc, x, y) {
    const pos = positionOf(sc);
    const { lo, hi } = travel(sc);
    pos.x = clamp(x, lo, hi);
    if (sc.isPhoto && typeof y === 'number') {
      const rect = modelRect(sc, { x: pos.x, y });
      const minY = rect.h * 0.5;
      pos.y = clamp(y, minY, sc.h - 2);
    }
    updateAria(sc);
    render();
  }

  function modelRect(sc, pos) {
    const p = pos || positionOf(sc);
    const len = product.lengthMm * sc.pxPerMm;
    const s = len / bw;
    return {
      s,
      len,
      x: p.x - (bx + bw / 2) * s,
      y: p.y - (cutout.baseline + 1) * s,
      w: cutout.width * s,
      h: cutout.height * s,
      left: p.x - len / 2,
      right: p.x + len / 2,
      base: p.y,
    };
  }

  /* ---------- Warstwy rysowania ---------- */
  function buildShadows() {
    if (shadows || !cutoutImg) return shadows;
    const W = Math.min(800, cutout.width);
    const k = W / cutout.width;
    const H = Math.max(2, Math.round(cutout.height * k));
    // Sylwetka w czerni (osobna kopia, oryginał modelu pozostaje nietknięty).
    const sil = mkCanvas(W, H);
    const sc = sil.getContext('2d');
    sc.drawImage(cutoutImg, 0, 0, W, H);
    sc.globalCompositeOperation = 'source-in';
    sc.fillStyle = '#000';
    sc.fillRect(0, 0, W, H);

    const soft = blurred(sil, W * 0.028);
    // Pas przy podłożu: tylko opony, do ciasnego cienia styku.
    const band = mkCanvas(W, H);
    const bc = band.getContext('2d');
    bc.drawImage(sil, 0, 0);
    bc.globalCompositeOperation = 'destination-in';
    const base = (cutout.baseline + 1) * k;
    const g = bc.createLinearGradient(0, base - H * 0.12, 0, base);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.72, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    bc.fillStyle = g;
    bc.fillRect(0, 0, W, H);
    const contact = blurred(band, W * 0.006);
    shadows = { W, H, base, soft, contact, pad: soft.pad, cpad: contact.pad };
    return shadows;
  }

  // Rozmycie przez cień płótna (działa także w Safari, które nie obsługuje ctx.filter).
  function blurred(source, radius) {
    const pad = Math.ceil(radius * 2.4);
    const out = mkCanvas(source.width + pad * 2, source.height + pad * 2);
    const c = out.getContext('2d');
    const off = out.width * 2;
    c.shadowColor = '#000';
    c.shadowBlur = radius * 2;
    c.shadowOffsetX = off;
    c.drawImage(source, pad - off, pad);
    out.pad = pad;
    return out;
  }

  function drawShadows(c, sc, r) {
    const sh = buildShadows();
    if (!sh) return;
    const k = r.w / sh.W;
    const skew = sc.shadow.dx;

    // Miękki cień rzucony: spłaszczona sylwetka na płaszczyźnie podłoża.
    c.save();
    c.globalAlpha = clamp(sc.shadow.opacity * 0.85, 0, 0.9);
    c.translate(r.x + r.w / 2, r.base + r.h * 0.012);
    c.transform(1, 0, -skew, 0.16, 0, 0);
    const sw = sh.soft.width * k;
    const shh = sh.soft.height * k;
    c.drawImage(sh.soft, -sw / 2, -(sh.pad + sh.base) * k, sw, shh);
    c.restore();

    // Ciasny cień styku opon.
    c.save();
    c.globalAlpha = clamp(sc.shadow.opacity * 1.5, 0, 0.92);
    c.translate(r.x, r.base);
    c.transform(1, 0, 0, 0.32, 0, 0);
    const cw = sh.contact.width * k;
    const chh = sh.contact.height * k;
    c.drawImage(sh.contact, -sh.cpad * k, -(sh.cpad + sh.base) * k + r.h * 0.012, cw, chh);
    c.restore();
  }

  function drawReflection(c, sc, r) {
    if (!sc.reflect) return;
    const clipBottom = Math.min(sc.frontY, sc.h);
    const span = clipBottom - r.base;
    if (span <= 2) return;
    const w = Math.max(1, Math.round(r.w));
    const h = Math.max(1, Math.round(r.h));
    const off = mkCanvas(w, h);
    const oc = off.getContext('2d');
    // Odbicie w tafli: lustrzana kopia od linii podłoża.
    oc.translate(0, h);
    oc.scale(1, -1);
    oc.drawImage(cutoutImg, 0, 0, w, h);
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.globalCompositeOperation = 'destination-in';
    const baseInOff = h - (cutout.baseline + 1) * r.s;
    const g = oc.createLinearGradient(0, baseInOff, 0, baseInOff + Math.min(span, r.h * 0.55));
    g.addColorStop(0, 'rgba(0,0,0,' + sc.reflect + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    oc.fillStyle = g;
    oc.fillRect(0, 0, w, h);
    c.save();
    c.beginPath();
    c.rect(0, r.base, sc.w, span);
    c.clip();
    c.drawImage(off, r.x, r.base - baseInOff, r.w, r.h);
    c.restore();
  }

  function drawModel(c, r) {
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(cutoutImg, r.x, r.y, r.w, r.h);
  }

  function pill(c, text, cx, cy, u, opts = {}) {
    const size = (opts.size || 12) * u;
    c.font = (opts.weight || 650) + ' ' + size + 'px ' + FONT;
    const tw = c.measureText(text).width;
    const px = 7 * u;
    const w = tw + px * 2;
    const h = size + 8 * u;
    const x = clamp(cx - w / 2, opts.minX ?? 2 * u, (opts.maxX ?? c.canvas.width - 2 * u) - w);
    const y = cy;
    c.fillStyle = opts.bg || 'rgba(16,17,20,.86)';
    c.fillRect(x, y, w, h);
    c.fillStyle = opts.fg || '#fff';
    c.textBaseline = 'middle';
    c.fillText(text, x + px, y + h / 2 + u * 0.5);
    return { x, y, w, h };
  }

  // Linijka na płaszczyźnie ustawienia modelu oraz wymiar długości modelu.
  function drawRuler(c, sc, r, v, u) {
    const k = v.k;
    const toX = (x) => (x - v.x) * k;
    const toY = (y) => (y - v.y) * k;
    const ink = sc.ink === 'dark' ? '17,18,28' : '255,255,255';
    const baseY = toY(r.base);

    if (sc.surface) {
      const s = sc.surface;
      // Gdy powierzchnia wychodzi poza kadr, linijka liczy od widocznego brzegu.
      const originX = Math.max(s.x0, 0);
      const visibleMm = (Math.min(s.x1, sc.w) - originX) / sc.pxPerMm;
      const mmToX = (mm) => toX(originX + mm * sc.pxPerMm);
      const y = baseY + 1 * u;
      c.save();
      c.strokeStyle = 'rgba(' + ink + ',.5)';
      c.lineWidth = Math.max(1, u * 0.75);
      const fromX = Math.max(toX(s.x0), 0);
      const toX2 = Math.min(toX(s.x1), c.canvas.width);
      c.beginPath();
      c.moveTo(fromX, y);
      c.lineTo(toX2, y);
      const minorGapPx = 10 * sc.pxPerMm * k;
      const step = minorGapPx >= 5 * u ? 10 : 50;
      for (let mm = 0; mm <= visibleMm + 0.1; mm += step) {
        const tx = mmToX(mm);
        if (tx < -1 || tx > c.canvas.width + 1) continue;
        const major = mm % 100 === 0;
        const mid = mm % 50 === 0;
        const len = (major ? 9 : mid ? 6 : 3) * u;
        c.moveTo(tx, y);
        c.lineTo(tx, y + len);
      }
      c.stroke();

      // Opisy co 10 cm, jeśli się mieszczą.
      c.fillStyle = 'rgba(' + ink + ',.86)';
      c.font = '550 ' + 10 * u + 'px ' + FONT;
      c.textAlign = 'center';
      c.textBaseline = 'top';
      const labelStep = 100 * sc.pxPerMm * k >= 34 * u ? 100 : 200;
      for (let mm = 0; mm <= visibleMm; mm += labelStep) {
        const tx = mmToX(mm);
        if (tx < 12 * u || tx > c.canvas.width - 12 * u) continue;
        c.fillText(String(mm / 10), tx, y + 11 * u);
      }
      c.restore();
    }

    // Wymiar modelu: klamra pod kołami i etykieta.
    const left = toX(r.left);
    const right = toX(r.right);
    const dimY = baseY + (sc.surface ? 26 : 12) * u;
    c.save();
    c.strokeStyle = '#fff';
    c.lineWidth = Math.max(1.25, 1.25 * u);
    c.shadowColor = 'rgba(0,0,0,.65)';
    c.shadowBlur = 3 * u;
    c.beginPath();
    c.moveTo(left, dimY - 5 * u);
    c.lineTo(left, dimY + 5 * u);
    c.moveTo(left, dimY);
    c.lineTo(right, dimY);
    c.moveTo(right, dimY - 5 * u);
    c.lineTo(right, dimY + 5 * u);
    c.stroke();
    c.restore();
    c.save();
    c.textAlign = 'left';
    pill(c, cmText(product.lengthMm), (left + right) / 2, dimY + 8 * u, u, { size: 13 });
    c.restore();

    // Etykieta powierzchni; na wąskim ekranie tę informację podaje opis pod sceną.
    if (sc.surface && c.canvas.width / u >= 560) {
      c.save();
      c.textAlign = 'left';
      const text = sc.surface.label + ': ' + cmWhole(sc.surface.lengthMm);
      c.font = '600 ' + 11 * u + 'px ' + FONT;
      const tw = c.measureText(text).width + 14 * u;
      const anchor = clamp(toX(sc.surface.x1) - tw / 2 - 2 * u, tw / 2 + 2 * u, c.canvas.width - tw / 2 - 2 * u);
      pill(c, text, anchor, 8 * u, u, { size: 11, weight: 600 });
      c.restore();
    }
  }

  function viewFor(sc, width) {
    if (!state.zoom) {
      return { x: 0, y: 0, w: sc.w, h: sc.h, k: width / sc.w };
    }
    const zoomed = sc.pxPerMm ? modelRect(sc) : null;
    const factor = zoomed ? clamp((sc.w * 0.74) / zoomed.len, 1.15, 3.2) : 1.6;
    const w = sc.w / factor;
    const h = sc.h / factor;
    const cx = zoomed ? (zoomed.left + zoomed.right) / 2 : sc.w / 2;
    const cy = zoomed ? zoomed.base - zoomed.h * 0.35 : sc.h / 2;
    return {
      x: clamp(cx - w / 2, 0, sc.w - w),
      y: clamp(cy - h / 2, 0, sc.h - h),
      w,
      h,
      k: width / w,
    };
  }

  function paint(c, sc, v, opts) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.setTransform(v.k, 0, 0, v.k, -v.x * v.k, -v.y * v.k);
    c.drawImage(sc.img, 0, 0, sc.w, sc.h);
    if (sc.pxPerMm && cutoutImg) {
      const r = modelRect(sc);
      drawReflection(c, sc, r);
      drawShadows(c, sc, r);
      drawModel(c, r);
      if (opts.ruler) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        drawRuler(c, sc, r, v, opts.unit);
      }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    // Oznaczenie zawsze widoczne na samym obrazie, także po przewinięciu okna na telefonie.
    if (opts.badge) {
      c.save();
      c.textAlign = 'left';
      c.font = '650 ' + 11 * opts.unit + 'px ' + FONT;
      const text = product.example ? 'Przykład: długość szacunkowa' : 'Wizualizacja poglądowa';
      const tw = c.measureText(text).width + 14 * opts.unit;
      pill(c, text, tw / 2 + 6 * opts.unit, c.canvas.height - 25 * opts.unit, opts.unit, { size: 11 });
      c.restore();
    }
  }

  function render() {
    if (!state.opened) return;
    const sc = current();
    if (!sc || !sc.img || !cutoutImg) return;
    const v = viewFor(sc, el.canvas.width);
    state.view = v;
    paint(ctx, sc, v, { ruler: state.ruler, badge: true, unit: Math.max(1, el.canvas.width / el.canvas.clientWidth || 1) });
    if (photo && sc.isPhoto) layoutMeasure();
  }

  /* ---------- Układ ---------- */
  function layout() {
    if (!state.opened) return;
    const sc = current();
    if (!sc) return;
    const isPhoto = sc.isPhoto;
    // Na telefonie scena przyjmuje proporcje zdjęcia (w granicach rozsądku).
    if (window.matchMedia('(max-width: 999px) and (orientation: portrait)').matches && isPhoto) {
      el.stage.style.aspectRatio = String(clamp(sc.w / sc.h, 0.8, 1.6));
    } else {
      el.stage.style.aspectRatio = '';
    }
    const box = el.stage.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    const ratio = sc.w / sc.h;
    let w = box.width;
    let h = w / ratio;
    if (h > box.height) {
      h = box.height;
      w = h * ratio;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.style.width = Math.floor(w) + 'px';
    el.canvas.style.height = Math.floor(h) + 'px';
    const bw2 = Math.round(Math.floor(w) * dpr);
    const bh2 = Math.round(Math.floor(h) * dpr);
    if (el.canvas.width !== bw2 || el.canvas.height !== bh2) {
      el.canvas.width = bw2;
      el.canvas.height = bh2;
    }
    render();
  }

  function layoutMeasure() {
    if (!photo || !state.measuring) return;
    const sc = current();
    const v = state.view || viewFor(sc, el.canvas.width);
    const canvasBox = el.canvas.getBoundingClientRect();
    const stageBox = el.stage.getBoundingClientRect();
    const cssK = (canvasBox.width / el.canvas.width) * v.k;
    const toStage = (p) => ({
      x: canvasBox.left - stageBox.left + (p.x - v.x) * cssK,
      y: canvasBox.top - stageBox.top + (p.y - v.y) * cssK,
    });
    const a = toStage(photo.a);
    const b = toStage(photo.b);
    handles.a.style.left = a.x + 'px';
    handles.a.style.top = a.y + 'px';
    handles.b.style.left = b.x + 'px';
    handles.b.style.top = b.y + 'px';
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    el.line.style.left = a.x + 'px';
    el.line.style.top = a.y - 1 + 'px';
    el.line.style.width = dist + 'px';
    el.line.style.transform = 'rotate(' + Math.atan2(b.y - a.y, b.x - a.x) + 'rad)';
  }

  /* ---------- Opisy i dostępność ---------- */
  function basisText(sc) {
    if (!sc) return 'Wybierz zdjęcie swojej półki, a model pojawi się w skali, którą wyznaczysz.';
    const source = product.source ? ' (źródło: ' + product.source + ')' : '';
    if (product.example) {
      const calc = 'Przykład w wersji demo. Długość szacunkowa ' + cmText(product.lengthMm) + ': długość auta ' + product.example.carMm + ' mm ÷ ' + product.example.ratio + source + '. To nie jest pomiar tego modelu.';
      if (sc.isPhoto && !sc.pxPerMm) return 'Zaznacz na zdjęciu odcinek o znanej długości, aby ustawić skalę. ' + calc;
      return calc + (sc.isPhoto ? '' : ' ' + sc.surface.label + ': ' + cmWhole(sc.surface.lengthMm) + '.');
    }
    if (sc.isPhoto) {
      if (!sc.pxPerMm) {
        return 'Zaznacz na zdjęciu odcinek o znanej długości, aby ustawić skalę. Bez tego model się nie pojawi.';
      }
      return 'Skala z Twojego pomiaru: odcinek ' + cmWhole(photo.cm * 10) + ' na zdjęciu, długość modelu ' + cmText(product.lengthMm) + source + '. Perspektywa zdjęcia może zmienić proporcje.';
    }
    return 'Skala według potwierdzonej długości modelu: ' + cmText(product.lengthMm) + source + '. ' + sc.surface.label + ': ' + cmWhole(sc.surface.lengthMm) + '.';
  }

  function updateBasis() {
    el.basis.textContent = basisText(current());
  }

  function updateAria(sc) {
    if (!sc || !sc.pxPerMm) {
      el.canvas.setAttribute('aria-valuetext', 'Model nie jest jeszcze ustawiony');
      el.canvas.setAttribute('aria-valuenow', '0');
      return;
    }
    const pos = positionOf(sc);
    const { lo, hi } = travel(sc);
    const pct = hi > lo ? Math.round(((pos.x - lo) / (hi - lo)) * 100) : 50;
    el.canvas.setAttribute('aria-valuenow', String(pct));
    let text;
    if (sc.surface) {
      const fromLeft = Math.max(0, (pos.x - product.lengthMm * sc.pxPerMm * 0.5 - sc.surface.x0) / sc.pxPerMm);
      text = 'Model ' + cmText(fromLeft) + ' od lewego końca: ' + sc.surface.label;
    } else {
      text = 'Model na zdjęciu, ' + pct + ' procent od lewej';
    }
    el.canvas.setAttribute('aria-valuetext', text);
  }

  function announce(text) {
    el.live.textContent = '';
    window.setTimeout(() => {
      el.live.textContent = text;
    }, 30);
  }

  function hideHint() {
    if (state.interacted) return;
    state.interacted = true;
    el.hint.classList.add('is-hidden');
  }

  function setOverlay(mode, text) {
    if (mode === 'none') {
      el.overlay.hidden = true;
      return;
    }
    el.overlay.hidden = false;
    el.overlayText.textContent = text;
    el.spinner.hidden = mode !== 'loading';
    el.retry.hidden = mode !== 'error';
  }

  /* ---------- Sceny: przełączanie i ładowanie ---------- */
  async function ensureScene(id) {
    const s = config.scenes.find((x) => x.id === id);
    if (!s || s.image) return;
    s.image = await loadImage(s.url);
  }

  async function ensureCutout() {
    if (cutoutImg) return;
    cutoutImg = await loadImage(cutout.url);
  }

  async function showScene(id) {
    state.sceneId = id;
    const isPhoto = id === 'photo';
    el.side.classList.toggle('is-photo', isPhoto && !!photo);
    el.drop.hidden = !(isPhoto && !photo);
    el.calibrate.hidden = !(isPhoto && photo);
    el.hint.hidden = isPhoto && !(photo && photo.pxPerMm);
    setMeasuring(isPhoto && !!photo && !photo.pxPerMm);
    el.save.disabled = isPhoto && !(photo && photo.pxPerMm);
    updateBasis();
    if (isPhoto) {
      setOverlay('none');
      if (photo) {
        layout();
      }
      updateAria(current());
      return;
    }
    const scene = config.scenes.find((x) => x.id === id);
    if (!scene.image || !cutoutImg) setOverlay('loading', 'Przygotowuję scenę…');
    try {
      await Promise.all([ensureScene(id), ensureCutout()]);
      if (state.sceneId !== id) return;
      setOverlay('none');
      layout();
      updateAria(current());
    } catch (err) {
      if (state.sceneId !== id) return;
      setOverlay('error', 'Nie udało się wczytać podglądu. Sprawdź połączenie i spróbuj ponownie.');
    }
  }

  /* ---------- Otwieranie ---------- */
  function open() {
    state.opened = true;
    if (M.openLayer) M.openLayer(root);
    else root.classList.add('is-open');
    // Bez czekania na requestAnimationFrame: w karcie w tle ta funkcja może nie ruszyć.
    layout();
    showScene(state.sceneId);
    requestAnimationFrame(layout);
    if (document.fonts && document.fonts.load) {
      document.fonts.load('600 12px Archivo').then(render).catch(() => {});
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-shelf-open]');
    if (!btn) return;
    e.preventDefault();
    open();
  });

  /* Zamknięcie obsługuje wspólny kod MCS (Escape, przycisk). Tu tylko wstrzymujemy rysowanie. */
  new MutationObserver(() => {
    const isOpen = root.classList.contains('is-open');
    if (state.opened && !isOpen) state.opened = false;
    if (!state.opened && isOpen) state.opened = true;
  }).observe(root, { attributes: true, attributeFilter: ['class'] });

  if (window.ResizeObserver) {
    new ResizeObserver(() => layout()).observe(el.stage);
  } else {
    window.addEventListener('resize', layout);
  }

  el.retry.addEventListener('click', () => showScene(state.sceneId));

  qa('input[name="shelf-scene"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) showScene(input.value);
    });
  });

  el.ruler.addEventListener('change', () => {
    state.ruler = el.ruler.checked;
    render();
  });

  el.zoom.addEventListener('click', () => {
    state.zoom = !state.zoom;
    el.zoom.setAttribute('aria-pressed', state.zoom ? 'true' : 'false');
    el.zoomLabel.textContent = state.zoom ? 'Pomniejsz' : 'Przybliż';
    render();
  });

  /* ---------- Przeciąganie modelu ---------- */
  let drag = null;

  function toScene(e, sc) {
    const box = el.canvas.getBoundingClientRect();
    const v = state.view || viewFor(sc, el.canvas.width);
    const scale = v.w / box.width;
    return { x: v.x + (e.clientX - box.left) * scale, y: v.y + (e.clientY - box.top) * scale };
  }

  el.canvas.addEventListener('pointerdown', (e) => {
    const sc = current();
    if (!sc || !sc.pxPerMm || state.measuring) return;
    if (e.button !== undefined && e.button !== 0) return;
    const p = toScene(e, sc);
    const pos = positionOf(sc);
    const r = modelRect(sc);
    const onModel = p.x >= r.left && p.x <= r.right && p.y >= r.y && p.y <= r.base + 10;
    drag = { id: e.pointerId, dx: onModel ? pos.x - p.x : 0, dy: onModel ? pos.y - p.y : 0 };
    if (!onModel) moveModel(sc, p.x, p.y);
    el.canvas.setPointerCapture(e.pointerId);
    el.canvas.classList.add('is-dragging');
    hideHint();
    e.preventDefault();
  });

  el.canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const sc = current();
    const p = toScene(e, sc);
    moveModel(sc, p.x + drag.dx, p.y + drag.dy);
  });

  const endDrag = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    drag = null;
    el.canvas.classList.remove('is-dragging');
  };
  el.canvas.addEventListener('pointerup', endDrag);
  el.canvas.addEventListener('pointercancel', endDrag);

  el.canvas.addEventListener('keydown', (e) => {
    const sc = current();
    if (!sc || !sc.pxPerMm) return;
    const stepMm = e.shiftKey ? 50 : 10;
    const step = stepMm * sc.pxPerMm;
    const pos = positionOf(sc);
    let x = pos.x;
    let y = pos.y;
    switch (e.key) {
      case 'ArrowLeft': x -= step; break;
      case 'ArrowRight': x += step; break;
      // Na scenie model jedzie po powierzchni, więc góra i dół działają jak w suwaku.
      case 'ArrowUp': if (sc.isPhoto) y -= step; else x += step; break;
      case 'ArrowDown': if (sc.isPhoto) y += step; else x -= step; break;
      case 'PageUp': x += step * 5; break;
      case 'PageDown': x -= step * 5; break;
      case 'Home': x = -1e6; break;
      case 'End': x = 1e6; break;
      default: return;
    }
    e.preventDefault();
    hideHint();
    moveModel(sc, x, y);
    announce(el.canvas.getAttribute('aria-valuetext') || '');
  });

  /* ---------- Własne zdjęcie ---------- */
  function setFileError(text) {
    el.fileError.textContent = text || '';
    el.fileError.hidden = !text;
  }

  async function usePhoto(file) {
    setFileError('');
    if (!file) return;
    if (!MIME.includes(file.type)) {
      showFileProblem('Ten plik nie jest zdjęciem JPG, PNG ani WebP.');
      return;
    }
    if (file.size > MAX_FILE) {
      showFileProblem('Zdjęcie jest większe niż 15 MB. Wybierz mniejsze.');
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve(probe);
        probe.onerror = () => reject(new Error('decode'));
        probe.src = url;
      });
      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      if (naturalW < 320 || naturalH < 240) {
        showFileProblem('Zdjęcie jest za małe, by rzetelnie ustawić skalę (minimum 320 × 240 pikseli).');
        return;
      }
      // Kopia ograniczona rozmiarem: oszczędza pamięć telefonu, a plik nie opuszcza urządzenia.
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(naturalW, naturalH));
      const w = Math.round(naturalW * scale);
      const h = Math.round(naturalH * scale);
      const copy = mkCanvas(w, h);
      copy.getContext('2d').drawImage(img, 0, 0, w, h);
      photo = {
        canvas: copy,
        width: w,
        height: h,
        a: { x: w * 0.25, y: h * 0.7 },
        b: { x: w * 0.75, y: h * 0.7 },
        pxPerMm: null,
        cm: null,
        baseline: h * 0.7,
        startX: w * 0.5,
      };
      delete state.positions.photo;
      el.cm.value = '';
      setCmError('');
      el.photoActions.hidden = true;
      await ensureCutout().catch(() => {});
      await showScene('photo');
      handles.a.focus();
    } catch (err) {
      showFileProblem('Nie udało się odczytać tego zdjęcia. Spróbuj z innym plikiem.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function showFileProblem(text) {
    if (photo) {
      setCmError(text);
    } else {
      setFileError(text);
    }
  }

  function setCmError(text) {
    el.cmError.textContent = text || '';
    el.cmError.hidden = !text;
    if (text) el.cm.setAttribute('aria-invalid', 'true');
    else el.cm.removeAttribute('aria-invalid');
  }

  qa('[data-shelf-file]').forEach((input) => {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) usePhoto(file);
    });
  });

  // Upuszczenie pliku na scenę.
  ['dragenter', 'dragover'].forEach((type) => {
    el.stage.addEventListener(type, (e) => {
      if (state.sceneId === 'photo') e.preventDefault();
    });
  });
  el.stage.addEventListener('drop', (e) => {
    if (state.sceneId !== 'photo') return;
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) usePhoto(file);
  });

  function setMeasuring(on) {
    state.measuring = on;
    el.measure.hidden = !on;
    el.form.hidden = !on;
    el.steps.hidden = !on;
    el.calTitle.textContent = !on && photo && photo.pxPerMm
      ? 'Skala ustawiona: ' + cmWhole(photo.cm * 10)
      : 'Ustaw skalę zdjęcia';
    el.photoActions.hidden = on || !(photo && photo.pxPerMm);
    if (on) layoutMeasure();
  }

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!photo) return;
    const value = parseFloat(String(el.cm.value).replace(',', '.').trim());
    if (!Number.isFinite(value) || value < 1 || value > 500) {
      setCmError('Wpisz długość od 1 do 500 cm.');
      el.cm.focus();
      return;
    }
    const dist = Math.hypot(photo.b.x - photo.a.x, photo.b.y - photo.a.y);
    if (dist < 24) {
      setCmError('Punkty są zbyt blisko siebie. Rozsuń je na końce mierzonego odcinka.');
      return;
    }
    const pxPerMm = dist / (value * 10);
    const lenPx = product.lengthMm * pxPerMm;
    if (lenPx > photo.width * 1.4) {
      setCmError('W tej skali model byłby większy niż zdjęcie. Sprawdź wpisaną długość.');
      return;
    }
    if (lenPx < 18) {
      setCmError('W tej skali model byłby niewidoczny. Sprawdź wpisaną długość.');
      return;
    }
    setCmError('');
    photo.pxPerMm = pxPerMm;
    photo.cm = value;
    photo.baseline = (photo.a.y + photo.b.y) / 2;
    photo.startX = (photo.a.x + photo.b.x) / 2;
    delete state.positions.photo;
    const sc = current();
    const pos = positionOf(sc);
    moveModel(sc, pos.x, pos.y);
    setMeasuring(false);
    el.hint.hidden = false;
    el.save.disabled = false;
    updateBasis();
    render();
    announce('Model ustawiony w skali zdjęcia.');
    el.canvas.focus();
  });

  el.remeasure.addEventListener('click', () => {
    if (!photo) return;
    photo.pxPerMm = null;
    photo.cm = null;
    el.save.disabled = true;
    setMeasuring(true);
    updateBasis();
    render();
    handles.a.focus();
  });

  el.clear.addEventListener('click', () => {
    photo = null;
    delete state.positions.photo;
    el.cm.value = '';
    setCmError('');
    setMeasuring(false);
    showScene('photo');
    const input = el.drop.querySelector('input[type=file]');
    if (input) input.focus();
  });

  // Uchwyty odcinka: mysz, dotyk i klawiatura.
  Object.entries(handles).forEach(([key, node]) => {
    let active = null;
    const placeHandle = (x, y) => {
      if (!photo) return;
      photo[key] = { x: clamp(x, 0, photo.width), y: clamp(y, 0, photo.height) };
      layoutMeasure();
    };
    node.addEventListener('pointerdown', (e) => {
      active = e.pointerId;
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener('pointermove', (e) => {
      if (active !== e.pointerId) return;
      const p = toScene(e, current());
      placeHandle(p.x, p.y);
    });
    const stop = (e) => {
      if (active === e.pointerId) active = null;
    };
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
    node.addEventListener('keydown', (e) => {
      if (!photo) return;
      const step = (e.shiftKey ? 20 : 4) * (photo.width / el.canvas.clientWidth);
      const p = photo[key];
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      placeHandle(p.x + move[0], p.y + move[1]);
    });
  });

  /* ---------- Zapis obrazu z etykietą ---------- */
  function exportCanvas() {
    const sc = current();
    if (!sc || !sc.img || !sc.pxPerMm || !cutoutImg) return null;
    const longest = Math.max(sc.w, sc.h);
    const scale = longest > 2000 ? 2000 / longest : 1;
    const width = Math.round(sc.w * scale);
    const height = Math.round(sc.h * scale);
    const unit = Math.max(1.1, width / 900);
    const strip = Math.round(36 * unit);
    const out = mkCanvas(width, height + strip);
    const c = out.getContext('2d');
    const v = { x: 0, y: 0, w: sc.w, h: sc.h, k: width / sc.w };
    paint(c, sc, v, { ruler: state.ruler, unit });

    // Etykieta na stałe w obrazie.
    c.fillStyle = '#101114';
    c.fillRect(0, height, width, strip);
    const label = product.example ? 'Przykład: długość szacunkowa, nie pomiar' : 'Wizualizacja poglądowa';
    const detail = (product.example ? 'szacunkowo ' : 'długość modelu ') + cmText(product.lengthMm) + ' · ' + (sc.isPhoto
      ? 'skala z pomiaru na zdjęciu: ' + cmWhole(photo.cm * 10)
      : sc.surface.label + ' ' + cmWhole(sc.surface.lengthMm)) + ' · ' + product.name;
    const gap = 12 * unit;
    let size = 13 * unit;
    c.textBaseline = 'middle';
    const padX = 14 * unit;
    let detailText = detail;
    for (let i = 0; i < 6; i++) {
      c.font = '700 ' + size + 'px ' + FONT;
      const lw = c.measureText(label).width;
      c.font = '500 ' + size + 'px ' + FONT;
      if (lw + gap + c.measureText(detailText).width + padX * 2 <= width) break;
      size *= 0.92;
    }
    c.font = '700 ' + size + 'px ' + FONT;
    c.fillStyle = '#fff';
    c.fillText(label, padX, height + strip / 2);
    const labelWidth = c.measureText(label).width;
    c.font = '500 ' + size + 'px ' + FONT;
    c.fillStyle = '#c9ccd2';
    const available = width - padX * 2 - labelWidth - gap;
    while (c.measureText(detailText).width > available && detailText.length > 10) {
      detailText = detailText.slice(0, -2).trimEnd();
      if (c.measureText(detailText + '…').width <= available) {
        detailText += '…';
        break;
      }
    }
    c.fillText(detailText, padX + labelWidth + gap, height + strip / 2);
    return out;
  }

  el.save.addEventListener('click', () => {
    const out = exportCanvas();
    if (!out) return;
    el.save.classList.add('is-loading');
    out.toBlob((blob) => {
      el.save.classList.remove('is-loading');
      if (!blob) {
        if (M.toast) M.toast('Nie udało się zapisać obrazu.', { type: 'error' });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'modelcarshop-' + (product.slug || 'podglad').slice(0, 60) + '-' + state.sceneId + '.jpg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (M.toast) M.toast('Zapisano obraz z etykietą.');
    }, 'image/jpeg', 0.92);
  });

  /* Punkt wejścia dla testów i integracji. */
  window.MCSShelf = { open, state, exportCanvas, showScene, usePhoto };
})();

/* Karta produktu: galeria, pełnoekranowe powiększenie, zakup i pasek na telefonie. */
(function () {
  'use strict';

  const M = window.MCS || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');

  /* ---------- Galeria ---------- */
  function initGallery() {
    const root = $('[data-gallery]');
    if (!root) return;
    const track = $('[data-gallery-track]', root);
    const slides = $$('[data-slide]', root);
    const thumbs = $$('[data-thumb]', root);
    const strip = $('.pgal__thumbs', root);
    const prev = $('[data-gallery-prev]', root);
    const next = $('[data-gallery-next]', root);
    const counter = $('[data-gallery-current]', root);
    let current = 0;

    function reflect(index) {
      if (index === current && root.dataset.ready) return;
      current = index;
      root.dataset.ready = '1';
      if (counter) counter.textContent = String(index + 1);
      if (prev) prev.disabled = index === 0;
      if (next) next.disabled = index === slides.length - 1;
      thumbs.forEach((thumb, i) => {
        if (i === index) thumb.setAttribute('aria-current', 'true');
        else thumb.removeAttribute('aria-current');
      });
      const active = thumbs[index];
      if (active && strip) {
        const box = active.parentElement;
        const left = box.offsetLeft - (strip.clientWidth - box.offsetWidth) / 2;
        strip.scrollTo({ left, behavior: scrollBehavior() });
      }
    }

    function go(index) {
      const target = clamp(index, 0, slides.length - 1);
      track.scrollTo({ left: target * track.clientWidth, behavior: scrollBehavior() });
      reflect(target);
    }

    let raf = 0;
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!track.clientWidth) return;
        reflect(clamp(Math.round(track.scrollLeft / track.clientWidth), 0, slides.length - 1));
      });
    }, { passive: true });

    window.addEventListener('resize', () => {
      track.scrollTo({ left: current * track.clientWidth, behavior: 'auto' });
    });

    if (prev) prev.addEventListener('click', () => go(current - 1));
    if (next) next.addEventListener('click', () => go(current + 1));
    thumbs.forEach((thumb) => thumb.addEventListener('click', () => go(Number(thumb.dataset.thumb))));

    root.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); }
    });

    const fullscreen = $('[data-gallery-fullscreen]', root);
    if (fullscreen) fullscreen.addEventListener('click', () => openLightbox('gallery', current));

    /* Po zamknięciu powiększenia galeria zostaje na ostatnio oglądanym zdjęciu. */
    syncGallery = (index) => {
      const target = clamp(index, 0, slides.length - 1);
      track.scrollTo({ left: target * track.clientWidth, behavior: 'auto' });
      reflect(target);
      const button = $('.pgal__open', slides[target]);
      if (button) button.focus({ preventScroll: true });
    };

    /* Powiększenie po najechaniu: tylko mysz na większym ekranie. */
    const canHover = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1000px)');
    slides.forEach((slide) => {
      const image = $('img', slide);
      if (!image) return;
      const position = (e) => {
        const rect = slide.getBoundingClientRect();
        image.style.transformOrigin = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100).toFixed(1) + '% '
          + clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100).toFixed(1) + '%';
      };
      slide.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse' || !canHover.matches) return;
        position(e);
        slide.classList.add('is-zoomed');
      });
      slide.addEventListener('pointermove', (e) => {
        if (slide.classList.contains('is-zoomed')) position(e);
      });
      slide.addEventListener('pointerleave', () => slide.classList.remove('is-zoomed'));
    });
  }

  /* ---------- Powiększenie pełnoekranowe ---------- */
  const MAX_SCALE = 4;
  let openLightbox = () => {};
  let syncGallery = () => {};

  function initLightbox() {
    const box = $('[data-lightbox]');
    if (!box) return;
    const view = $('[data-lb-view]', box);
    const image = $('[data-lb-img]', box);
    const count = $('[data-lb-count]', box);
    const loading = $('[data-lb-loading]', box);
    const failure = $('[data-lb-error]', box);
    const zoomLabel = $('[data-lb-zoom-label]', box);
    const zoomIn = $('[data-lb-zoom-in]', box);
    const zoomOut = $('[data-lb-zoom-out]', box);
    const prev = $('[data-lb-prev]', box);
    const next = $('[data-lb-next]', box);
    const hint = $('[data-lb-hint]', box);

    let items = [];
    let index = 0;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let gesture = null;
    let lastTap = 0;
    const pointers = new Map();

    const isOpen = () => box.classList.contains('is-open');

    function render(animated) {
      image.classList.toggle('is-animated', Boolean(animated) && !reducedMotion.matches);
      image.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
      image.classList.toggle('is-zoomed', scale > 1.01);
      view.classList.toggle('is-zoomed', scale > 1.01);
      if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
      if (zoomOut) zoomOut.disabled = scale <= 1.01;
      if (zoomIn) zoomIn.disabled = scale >= MAX_SCALE - 0.01;
    }

    function constrain() {
      const maxX = Math.max(0, (image.offsetWidth * scale - view.clientWidth) / 2);
      const maxY = Math.max(0, (image.offsetHeight * scale - view.clientHeight) / 2);
      tx = clamp(tx, -maxX, maxX);
      ty = clamp(ty, -maxY, maxY);
    }

    function fromCenter(clientX, clientY) {
      const rect = view.getBoundingClientRect();
      return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    }

    function zoomTo(target, point, animated) {
      const next = clamp(target, 1, MAX_SCALE);
      const anchor = point || { x: 0, y: 0 };
      const k = next / scale;
      tx = anchor.x - k * (anchor.x - tx);
      ty = anchor.y - k * (anchor.y - ty);
      scale = next;
      if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; }
      constrain();
      render(animated);
    }

    function resetZoom() {
      scale = 1;
      tx = 0;
      ty = 0;
      render(false);
    }

    function load() {
      const item = items[index];
      if (!item) return;
      failure.hidden = true;
      loading.hidden = false;
      image.classList.add('is-loading');
      image.alt = item.alt;
      image.onload = () => {
        loading.hidden = true;
        image.classList.remove('is-loading');
      };
      image.onerror = () => {
        loading.hidden = true;
        failure.hidden = false;
      };
      image.removeAttribute('src');
      image.src = item.src;
    }

    function show(target) {
      if (!items.length) return;
      index = (target + items.length) % items.length;
      resetZoom();
      load();
      if (count) count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
      box.setAttribute('aria-label', `Powiększone zdjęcie ${index + 1} z ${items.length}: ${items[index].alt}`);
      [items[index + 1], items[index - 1]].forEach((item) => {
        if (item) new Image().src = item.src;
      });
    }

    let activeSet = '';
    let hintTimer = 0;

    function open(set, start, trigger) {
      items = $$(`[data-lb-set="${set}"]`).map((el) => ({
        src: el.dataset.full,
        alt: el.dataset.alt || '',
        w: Number(el.dataset.w) || 0,
        h: Number(el.dataset.h) || 0,
      }));
      if (!items.length || !M.openLayer) return;
      activeSet = set;
      const single = items.length < 2;
      prev.hidden = single;
      next.hidden = single;
      // Safari nie ustawia fokusu po kliknięciu, a openLayer zapamiętuje element, do którego ma wrócić.
      if (trigger) trigger.focus({ preventScroll: true });
      M.openLayer(box);
      show(clamp(start, 0, items.length - 1));
      if (hint) {
        hint.textContent = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700
          ? 'Powiększ dwoma palcami. Przesuń w bok, aby zmienić zdjęcie.'
          : 'Kółko myszy powiększa, przeciągnięcie przesuwa, strzałki zmieniają zdjęcie.';
        hint.classList.remove('is-gone');
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => hint.classList.add('is-gone'), 3200);
      }
    }
    openLightbox = open;

    new MutationObserver(() => {
      if (isOpen() || !activeSet) return;
      if (activeSet === 'gallery') syncGallery(index);
      activeSet = '';
      image.removeAttribute('src');
      resetZoom();
    }).observe(box, { attributes: true, attributeFilter: ['class'] });

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-lb-set]');
      if (trigger && !trigger.closest('[data-lightbox]')) {
        e.preventDefault();
        open(trigger.dataset.lbSet, Number(trigger.dataset.lbIndex) || 0, trigger);
      }
    });

    $('[data-lb-close]', box).addEventListener('click', () => M.closeLayer(box));
    prev.addEventListener('click', () => show(index - 1));
    next.addEventListener('click', () => show(index + 1));
    zoomIn.addEventListener('click', () => zoomTo(scale * 1.6, null, true));
    zoomOut.addEventListener('click', () => zoomTo(scale / 1.6, null, true));
    $('[data-lb-retry]', box).addEventListener('click', load);

    document.addEventListener('keydown', (e) => {
      if (!isOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowLeft' && items.length > 1) { e.preventDefault(); show(index - 1); }
      else if (e.key === 'ArrowRight' && items.length > 1) { e.preventDefault(); show(index + 1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(scale * 1.4, null, true); }
      else if (e.key === '-') { e.preventDefault(); zoomTo(scale / 1.4, null, true); }
      else if (e.key === '0') { e.preventDefault(); zoomTo(1, null, true); }
    });

    view.addEventListener('wheel', (e) => {
      if (!isOpen()) return;
      e.preventDefault();
      zoomTo(scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), fromCenter(e.clientX, e.clientY), false);
    }, { passive: false });

    const pair = () => {
      const [a, b] = [...pointers.values()];
      return {
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        center: fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
    };

    view.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button')) return;
      try { view.setPointerCapture(e.pointerId); } catch (err) { /* wskaźnik mógł już zniknąć */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        gesture = { type: 'drag', x: e.clientX, y: e.clientY, tx, ty, moved: false };
        view.classList.add('is-grabbing');
      } else if (pointers.size === 2) {
        const { distance, center } = pair();
        gesture = { type: 'pinch', distance, center, scale, tx, ty };
      }
    });

    view.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !gesture) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.type === 'pinch' && pointers.size >= 2) {
        const { distance, center } = pair();
        const target = clamp(gesture.scale * (distance / gesture.distance), 1, MAX_SCALE);
        const k = target / gesture.scale;
        tx = center.x - k * (gesture.center.x - gesture.tx);
        ty = center.y - k * (gesture.center.y - gesture.ty);
        scale = target;
        if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; }
        constrain();
        render(false);
        return;
      }
      if (gesture.type === 'drag') {
        const dx = e.clientX - gesture.x;
        const dy = e.clientY - gesture.y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) gesture.moved = true;
        if (scale > 1.01) {
          tx = gesture.tx + dx;
          ty = gesture.ty + dy;
          constrain();
        } else if (items.length > 1) {
          tx = dx;
          ty = 0;
        }
        render(false);
      }
    });

    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size === 1) {
        // Po geście dwoma palcami pozostały palec kontynuuje przesuwanie.
        const [rest] = [...pointers.values()];
        gesture = { type: 'drag', x: rest.x, y: rest.y, tx, ty, moved: true };
        return;
      }
      if (pointers.size > 0) return;
      view.classList.remove('is-grabbing');
      const finished = gesture;
      gesture = null;
      if (!finished || finished.type !== 'drag') return;

      const dx = e.clientX - finished.x;
      if (!finished.moved && e.type === 'pointerup') {
        const now = Date.now();
        if (now - lastTap < 320) {
          lastTap = 0;
          zoomTo(scale > 1.01 ? 1 : 2.5, fromCenter(e.clientX, e.clientY), true);
        } else {
          lastTap = now;
        }
        return;
      }
      if (scale <= 1.01) {
        if (items.length > 1 && Math.abs(dx) > 64) {
          show(index + (dx < 0 ? 1 : -1));
        } else {
          tx = 0;
          ty = 0;
          render(true);
        }
      }
    }
    view.addEventListener('pointerup', endPointer);
    view.addEventListener('pointercancel', endPointer);

    window.addEventListener('resize', () => {
      if (!isOpen()) return;
      constrain();
      render(false);
    });
  }

  /* ---------- Zakup ---------- */
  function initBuy() {
    const form = $('[data-mcs-buy]');
    const stickBuy = $('[data-pstick-buy]');
    if (!form) return;
    // Walidację przejmuje skrypt (czytelny komunikat zamiast dymka przeglądarki). Bez JS działa „required”.
    form.noValidate = true;
    const productId = form.dataset.productId;
    const ack = form.querySelector('[data-mcs-ack]');
    const ackError = $('[data-mcs-ack-error]');
    const notice = $('#stan-produktu');
    const qty = $('[data-mcs-qty]', form);
    const cta = $('[data-mcs-cta]', form);
    const feedback = $('[data-mcs-feedback]', form);
    const labels = [$('[data-mcs-cta-label]', form), stickBuy && $('[data-mcs-cta-label]', stickBuy)].filter(Boolean);
    const defaultLabels = labels.map((label) => label.textContent);
    let busy = false;
    let resetTimer = 0;

    /* Ilość */
    $$('[data-qty-step]', form).forEach((button) => {
      button.addEventListener('click', () => {
        const min = Number(qty.min) || 1;
        const max = qty.max ? Number(qty.max) : Infinity;
        qty.value = clamp((parseInt(qty.value, 10) || min) + Number(button.dataset.qtyStep), min, max);
        syncQty();
      });
    });
    function syncQty() {
      if (!qty || qty.type === 'hidden') return;
      const min = Number(qty.min) || 1;
      const max = qty.max ? Number(qty.max) : Infinity;
      const value = clamp(parseInt(qty.value, 10) || min, min, max);
      qty.value = value;
      $$('[data-qty-step]', form).forEach((button) => {
        const step = Number(button.dataset.qtyStep);
        button.disabled = step < 0 ? value <= min : value >= max;
      });
    }
    if (qty) {
      qty.addEventListener('change', syncQty);
      syncQty();
    }

    function setFeedback(message, type) {
      if (!feedback) return;
      feedback.hidden = !message;
      feedback.textContent = message || '';
      feedback.classList.toggle('is-error', type === 'error');
      feedback.classList.toggle('is-ok', type === 'ok');
    }

    function setLoading(on) {
      [cta, stickBuy].forEach((button) => {
        if (!button) return;
        button.classList.toggle('is-loading', on);
        button.setAttribute('aria-busy', on ? 'true' : 'false');
      });
    }

    function showAdded() {
      [cta, stickBuy].forEach((button) => button && button.classList.add('is-added'));
      labels.forEach((label) => { label.textContent = 'Dodano'; });
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        [cta, stickBuy].forEach((button) => button && button.classList.remove('is-added'));
        labels.forEach((label, i) => { label.textContent = defaultLabels[i]; });
      }, 2200);
    }

    function askForAck() {
      if (ackError) ackError.hidden = false;
      if (ack) ack.setAttribute('aria-invalid', 'true');
      if (notice) {
        notice.classList.add('is-attention');
        notice.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      }
      if (ack) setTimeout(() => ack.focus({ preventScroll: true }), reducedMotion.matches ? 0 : 320);
    }

    if (ack) {
      ack.addEventListener('change', () => {
        if (ack.checked) {
          if (ackError) ackError.hidden = true;
          ack.removeAttribute('aria-invalid');
          if (notice) notice.classList.remove('is-attention');
        }
      });
    }

    async function registerAck() {
      const body = new URLSearchParams({
        product_id: productId,
        hash: form.dataset.ackHash || '',
      });
      const res = await fetch(M.wcAjax.replace('%%endpoint%%', 'mcs_ack_condition'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await res.json().catch(() => null);
      if (!data || !data.success) {
        throw new Error((data && data.data && data.data.message) || 'Nie udało się zapisać potwierdzenia. Odśwież stronę i spróbuj ponownie.');
      }
    }

    async function buy() {
      if (busy) return;
      if (ack && !ack.checked) {
        askForAck();
        return;
      }
      if (qty && qty.type !== 'hidden' && !qty.checkValidity()) syncQty();
      busy = true;
      setLoading(true);
      setFeedback('');
      try {
        if (ack) await registerAck();
        const quantity = qty ? parseInt(qty.value, 10) || 1 : 1;
        await M.addToCart(productId, quantity);
        showAdded();
        setFeedback('Dodano do koszyka.', 'ok');
        const event = new CustomEvent('mcs:added-to-cart', { cancelable: true, detail: { productId } });
        if (document.dispatchEvent(event)) {
          M.toast('Dodano do koszyka', { href: M.cartUrl, label: 'Przejdź do koszyka' });
        }
      } catch (err) {
        // Błąd sieci ma techniczną treść, więc zastępujemy ją zrozumiałym komunikatem.
        const message = err instanceof TypeError
          ? 'Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.'
          : (err && err.message) || 'Nie udało się dodać produktu. Spróbuj ponownie.';
        setFeedback(message, 'error');
        M.toast(message, { type: 'error' });
      } finally {
        busy = false;
        setLoading(false);
      }
    }

    form.addEventListener('submit', (e) => {
      // Bez wspólnego API sklepu formularz działa zwykłym wysłaniem.
      if (!M.addToCart || !M.wcAjax) return;
      e.preventDefault();
      buy();
    });
    if (stickBuy) {
      stickBuy.addEventListener('click', () => {
        if (M.addToCart && M.wcAjax) {
          buy();
        } else if (form.requestSubmit) {
          form.requestSubmit(cta);
        } else {
          cta.click();
        }
      });
    }

    if (window.location.hash === '#stan-produktu' && notice && ack) {
      notice.classList.add('is-attention');
      setTimeout(() => ack.focus({ preventScroll: true }), 300);
    }
  }

  /* ---------- Pasek zakupu na telefonie ---------- */
  function initStickyBar() {
    const bar = $('[data-pstick]');
    if (!bar) return;
    const target = $('.pbuy__row') || $('#powiadomienie');
    const phone = window.matchMedia('(max-width: 999px)');
    if (!target || !('IntersectionObserver' in window)) return;
    let targetVisible = true;

    function update() {
      const show = phone.matches && !targetVisible;
      bar.hidden = !show;
      document.body.classList.toggle('has-pstick', show);
    }
    new IntersectionObserver((entries) => {
      targetVisible = entries[entries.length - 1].isIntersecting;
      update();
    }, { rootMargin: '0px 0px -8px 0px' }).observe(target);
    if (phone.addEventListener) phone.addEventListener('change', update);
  }

  /* ---------- Przyklejona kolumna zakupu na komputerze ---------- */
  function initBuyColumn() {
    const column = $('.pdp__buy');
    if (!column) return;
    const header = $('.site-header');
    function update() {
      const top = (header ? header.offsetHeight : 0) + 16;
      document.documentElement.style.setProperty('--pdp-top', top + 'px');
      column.classList.toggle('is-tall', column.offsetHeight + top + 16 > window.innerHeight);
    }
    update();
    window.addEventListener('resize', update);
    window.addEventListener('load', update);
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(column);
  }

  function boot() {
    initLightbox();
    initGallery();
    initBuy();
    initStickyBar();
    initBuyColumn();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

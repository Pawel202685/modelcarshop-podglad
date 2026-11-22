/* Globalne zachowania sklepu. Publiczne API dla skryptów funkcji: window.MCS. */
(function () {
  'use strict';
  const M = (window.MCS = window.MCS || {});

  /* ---------- Powiadomienia ---------- */
  M.toast = function (message, opts = {}) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (opts.type === 'error' ? ' toast--err' : '');
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (opts.href) {
      const a = document.createElement('a');
      a.href = opts.href;
      a.textContent = opts.label || 'Zobacz';
      el.appendChild(a);
    }
    box.appendChild(el);
    setTimeout(() => el.remove(), opts.ms || 5000);
  };

  /* ---------- Zapytania do API sklepu ---------- */
  M.api = async function (path, options = {}) {
    const res = await fetch(M.rest + path.replace(/^\//, ''), {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || 'Nie udało się wykonać operacji. Spróbuj ponownie.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  /* ---------- Panele i okna z pułapką fokusu ---------- */
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';
  let lastFocus = null;

  M.openLayer = function (el) {
    if (!el) return;
    lastFocus = document.activeElement;
    el.inert = false;
    el.classList.add('is-open');
    document.body.classList.add('is-locked');
    const first = el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE);
    if (first) setTimeout(() => first.focus(), 40);
  };

  M.closeLayer = function (el) {
    if (!el) return;
    el.classList.remove('is-open');
    el.inert = true;
    if (!document.querySelector('.drawer.is-open, .modal.is-open')) document.body.classList.remove('is-locked');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  };

  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-drawer-open]');
    if (open) {
      e.preventDefault();
      M.openLayer(document.getElementById(open.dataset.drawerOpen));
      return;
    }
    const close = e.target.closest('[data-drawer-close]');
    if (close) {
      e.preventDefault();
      M.closeLayer(close.closest('.drawer, .modal'));
    }
  });

  document.addEventListener('keydown', (e) => {
    const layer = document.querySelector('.modal.is-open, .drawer.is-open');
    if (e.key === 'Escape') {
      if (layer) M.closeLayer(layer);
      closeMega();
      return;
    }
    if (e.key === 'Tab' && layer) {
      const items = [...layer.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  /* ---------- Menu rozwijane ---------- */
  const megaButtons = document.querySelectorAll('[data-mega]');
  function closeMega(except) {
    megaButtons.forEach((b) => {
      if (b === except) return;
      b.setAttribute('aria-expanded', 'false');
      const panel = document.getElementById(b.getAttribute('aria-controls'));
      if (panel) panel.hidden = true;
    });
  }
  megaButtons.forEach((btn) => {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    const item = btn.closest('li');
    let timer;
    const show = () => {
      clearTimeout(timer);
      closeMega(btn);
      btn.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
    };
    const hide = () => {
      timer = setTimeout(() => {
        btn.setAttribute('aria-expanded', 'false');
        panel.hidden = true;
      }, 140);
    };
    btn.addEventListener('click', () => (btn.getAttribute('aria-expanded') === 'true' ? hide() : show()));
    if (window.matchMedia('(hover: hover)').matches) {
      item.addEventListener('mouseenter', show);
      item.addEventListener('mouseleave', hide);
    }
    item.addEventListener('focusout', (e) => {
      if (!item.contains(e.relatedTarget)) hide();
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.main-nav')) closeMega();
  });

  /* ---------- Dodawanie do koszyka ---------- */
  M.updateCartCount = function (count) {
    document.querySelectorAll('.js-cart-count').forEach((n) => {
      n.textContent = count;
      n.dataset.count = count;
    });
  };

  M.addToCart = async function (productId, quantity = 1) {
    const body = new URLSearchParams({ product_id: productId, quantity });
    const res = await fetch(M.wcAjax.replace('%%endpoint%%', 'add_to_cart'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => null);
    if (!data || data.error) {
      const url = (data && data.product_url) || '';
      const err = new Error(url.endsWith('#stan-produktu')
        ? 'Ten egzemplarz ma opisany stan. Potwierdź go na karcie produktu.'
        : 'Nie udało się dodać produktu. Sprawdź dostępność i spróbuj ponownie.');
      err.productUrl = url;
      throw err;
    }
    if (data.fragments) {
      const html = data.fragments['.js-cart-count'];
      const match = typeof html === 'string' ? html.match(/data-count="(\d+)"/) : null;
      if (match) M.updateCartCount(match[1]);
    }
    document.dispatchEvent(new CustomEvent('mcs:cart-updated', { detail: { productId, quantity, data } }));
    return data;
  };

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-add-to-cart]');
    if (!btn) return;
    e.preventDefault();
    btn.classList.add('is-loading');
    try {
      await M.addToCart(btn.dataset.addToCart, Number(btn.dataset.quantity || 1));
      btn.classList.add('is-added');
      setTimeout(() => btn.classList.remove('is-added'), 1800);
      if (!document.dispatchEvent(new CustomEvent('mcs:added-to-cart', { cancelable: true, detail: { productId: btn.dataset.addToCart } }))) return;
      M.toast('Dodano do koszyka', { href: M.cartUrl, label: 'Przejdź do koszyka' });
    } catch (err) {
      M.toast(err.message, { type: 'error', href: err.productUrl, label: 'Zobacz produkt' });
    } finally {
      btn.classList.remove('is-loading');
    }
  });
})();

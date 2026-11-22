/* Artykuł: wskaźnik postępu czytania, aktywna pozycja spisu treści, wysokość przyklejonego nagłówka. */
(function () {
  'use strict';

  const root = document.documentElement;
  const header = document.querySelector('.site-header');

  const stickyOffset = () => (header ? header.getBoundingClientRect().height : 0);
  const syncOffset = () => root.style.setProperty('--mcs-sticky', Math.round(stickyOffset()) + 'px');
  syncOffset();
  window.addEventListener('resize', syncOffset, { passive: true });

  const content = document.querySelector('[data-article-content]');
  if (!content) return;

  const bar = document.querySelector('[data-article-progress]');
  const links = Array.from(document.querySelectorAll('[data-toc-link]'));
  const targets = links
    .map((link) => ({ link, heading: document.getElementById(decodeURIComponent(link.hash.slice(1))) }))
    .filter((item) => item.heading);

  let active = null;
  function setActive(item) {
    if (active === item) return;
    if (active) {
      active.link.classList.remove('is-active');
      active.link.removeAttribute('aria-current');
    }
    active = item;
    if (active) {
      active.link.classList.add('is-active');
      active.link.setAttribute('aria-current', 'location');
      const box = active.link.closest('.atoc');
      if (box && box.scrollHeight > box.clientHeight) {
        const top = active.link.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 48) {
          box.scrollTop = Math.max(0, top - box.clientHeight / 3);
        }
      }
    }
  }

  let queued = false;
  function update() {
    queued = false;
    const offset = stickyOffset();
    if (bar) {
      const rect = content.getBoundingClientRect();
      const span = rect.height - window.innerHeight + offset;
      const done = span > 0 ? Math.min(1, Math.max(0, (offset - rect.top) / span)) : rect.top < offset ? 1 : 0;
      bar.style.transform = 'scaleX(' + done.toFixed(4) + ')';
    }
    if (targets.length) {
      let current = null;
      for (const item of targets) {
        if (item.heading.getBoundingClientRect().top - offset <= 36) current = item;
        else break;
      }
      setActive(current);
    }
  }

  const request = () => {
    if (!queued) {
      queued = true;
      window.requestAnimationFrame(update);
    }
  };
  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', request, { passive: true });
  window.addEventListener('load', request);
  update();

  /* Na telefonie spis treści zwija się po wybraniu rozdziału. */
  const mobileToc = document.querySelector('.atoc-m');
  if (mobileToc) {
    mobileToc.addEventListener('click', (event) => {
      if (event.target.closest('a')) mobileToc.open = false;
    });
  }
})();

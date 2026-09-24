// Recherche instantanée : numéro de terrain, marque, habitant, panneau.

import { get } from '../api.js';
import { app } from '../app.js';
import { districtInfo } from '../state.js';
import { h, clear, avatar } from './dom.js';

export function initSearch() {
  const input = document.getElementById('search');
  const box = document.getElementById('search-results');
  let timer = null;
  let ctrl = null;
  let items = [];
  let active = -1;

  const close = () => {
    box.hidden = true;
    active = -1;
  };
  const choose = (fn) => {
    close();
    input.blur();
    fn();
  };

  function render(res, q) {
    items = [];
    const groups = [];
    if (res.plots.length) {
      groups.push(h('h4', {}, 'Terrains & immeubles'));
      for (const p of res.plots) {
        const d = districtInfo(p.district);
        const el = h('button', { class: 'result', onclick: () => choose(() => app.select({ type: 'plot', number: p.number }, { focus: true })) },
          h('span', { class: 'sw', style: { background: p.building?.color || d?.color || '#ccc' } }, p.building?.logo ? h('img', { src: p.building.logo, alt: '' }) : `#${p.number}`),
          h('span', { class: 'meta' }, h('strong', {}, p.building?.brandName || `Terrain #${p.number}`), h('small', {}, `${p.status === 'owned' ? p.owner ?? '' : p.status === 'free' ? 'Disponible' : 'Réservé'} · ${d?.name ?? ''}`)));
        items.push(el);
        groups.push(el);
      }
    }
    if (res.billboards.length) {
      groups.push(h('h4', {}, 'Panneaux'));
      for (const b of res.billboards) {
        const el = h('button', { class: 'result', onclick: () => choose(() => app.select({ type: 'billboard', number: b.number }, { focus: true })) },
          h('span', { class: 'sw', style: { background: b.ad?.color || '#f3f1ec' } }, '📣'),
          h('span', { class: 'meta' }, h('strong', {}, b.ad?.brandName || `Panneau #${b.number}`), h('small', {}, b.status === 'rented' ? 'Loué' : 'Disponible')));
        items.push(el);
        groups.push(el);
      }
    }
    if (res.users.length) {
      groups.push(h('h4', {}, 'Habitants'));
      for (const u of res.users) {
        const el = h('button', { class: 'result', onclick: () => choose(() => app.openProfile(u)) }, avatar(u, 'avatar sw'), h('span', { class: 'meta' }, h('strong', {}, u), h('small', {}, 'Voir le profil')));
        items.push(el);
        groups.push(el);
      }
    }
    clear(box, groups.length ? groups : h('p', { class: 'empty' }, `Aucun résultat pour « ${q} ».`));
    box.hidden = false;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return close();
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        render(await get(`/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal }), q);
      } catch (e) {
        if (e.name !== 'AbortError') clear(box, h('p', { class: 'empty' }, e.message));
      }
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      input.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      (items[active] || items[0])?.click();
    }
  });
  input.addEventListener('focus', () => input.value.trim() && box.childElementCount && (box.hidden = false));
  document.addEventListener('click', (e) => !e.target.closest('.search') && close());
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea')) {
      e.preventDefault();
      input.focus();
    }
  });
}

import { h, icon, clear } from './dom.js';

const panel = () => document.getElementById('panel');
let onCloseCb = null;

export function showPanel({ eyebrow, title, body = [], foot = [], onClose, onPrev, onNext }) {
  const el = panel();
  const prevCb = onCloseCb;
  onCloseCb = null;
  if (prevCb) prevCb({ replaced: true });
  onCloseCb = onClose || null;
  const nav = [];
  if (onPrev) nav.push(h('button', { class: 'icon-btn', 'aria-label': 'Précédent', title: 'Précédent', onclick: onPrev }, icon('prev')));
  if (onNext) nav.push(h('button', { class: 'icon-btn', 'aria-label': 'Suivant', title: 'Suivant', onclick: onNext }, icon('next')));
  clear(
    el,
    h(
      'div',
      { class: 'panel-head' },
      h('div', { class: 'titles' }, h('div', { class: 'eyebrow' }, eyebrow), h('h2', {}, title)),
      ...nav,
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer le panneau', onclick: () => closePanel() }, icon('close')),
    ),
    h('div', { class: 'panel-body' }, body),
    foot.length ? h('div', { class: 'panel-foot' }, foot) : null,
  );
  el.hidden = false;
  document.body.classList.add('panel-open');
  return el;
}

export function closePanel() {
  const el = panel();
  if (el.hidden) return;
  el.hidden = true;
  document.body.classList.remove('panel-open');
  const cb = onCloseCb;
  onCloseCb = null;
  cb?.({ replaced: false });
}

export function panelBody() {
  return panel().querySelector('.panel-body');
}

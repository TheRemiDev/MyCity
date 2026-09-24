// Fil d'activité en direct.

import { app } from '../app.js';
import { h, clear, timeAgo } from './dom.js';

const ICONS = { purchase: '🏗️', upgrade: '⬆️', update: '🎨', billboard: '📣', join: '👋', leave: '🚪', transfer: '🎁', demolish: '🧱', district: '🗺️', moderation: '🛡️', system: '⚙️' };
const list = () => document.getElementById('feed-list');
let events = [];

function item(ev, fresh = false) {
  const clickable = ev.targetType === 'plot' || ev.targetType === 'billboard';
  const li = h('li', { class: fresh ? 'fresh' : '', dataset: clickable ? { target: `${ev.targetType}:${ev.target}` } : undefined },
    h('span', { class: 'ico', 'aria-hidden': 'true' }, ICONS[ev.type] || '•'),
    h('span', {}, ev.message),
    h('time', { datetime: ev.at, title: new Date(ev.at).toLocaleString('fr-FR') }, timeAgo(ev.at)));
  if (clickable) li.addEventListener('click', () => app.select({ type: ev.targetType, number: ev.target }, { focus: true }));
  return li;
}

export function setEvents(list0) {
  events = list0.slice(0, 40);
  clear(list(), events.length ? events.map((e) => item(e)) : h('li', {}, 'La ville attend ses premiers habitants…'));
}

export function pushEvent(ev) {
  if (events.some((e) => e.id === ev.id)) return;
  events.unshift(ev);
  events = events.slice(0, 40);
  const el = list();
  if (el.firstChild && !el.firstChild.dataset?.target && events.length === 1) el.replaceChildren();
  el.prepend(item(ev, true));
  while (el.children.length > 40) el.lastChild.remove();
}

export function initFeed() {
  const feed = document.getElementById('feed');
  feed.querySelector('.feed-head').addEventListener('click', () => {
    const small = matchMedia('(max-width: 640px)').matches;
    if (small) feed.classList.toggle('expanded');
    else feed.classList.toggle('collapsed');
    feed.querySelector('.feed-head').setAttribute('aria-expanded', String(small ? feed.classList.contains('expanded') : !feed.classList.contains('collapsed')));
  });
  setInterval(() => {
    list().querySelectorAll('time').forEach((t) => (t.textContent = timeAgo(t.getAttribute('datetime'))));
  }, 30_000);
}

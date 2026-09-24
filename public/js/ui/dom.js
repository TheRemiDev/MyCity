// Mini-helpers DOM. Tout le texte passe par textContent : aucune injection HTML possible.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const ICONS = {
  close: 'M18 6 6 18M6 6l12 12',
  back: 'm15 18-6-6 6-6',
  prev: 'm15 18-6-6 6-6',
  next: 'm9 18 6-6-6-6',
  heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z',
  share: 'M4 12v8h16v-8M16 6l-4-4-4 4M12 2v13',
  flag: 'M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z',
  rotl: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  rotr: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  crown: 'm2 18 3-12 5 6 2-8 2 8 5-6 3 12z',
  pin: 'M20 10c0 5-8 12-8 12s-8-7-8-12a8 8 0 0 1 16 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};

export function icon(name, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

export function toast(message, type = 'info', ms = 3800) {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  root.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

let modalCleanup = null;
export function openModal({ title, wide = false, content, onClose }) {
  closeModal();
  const root = document.getElementById('modal-root');
  const previous = document.activeElement;
  const close = () => closeModal();
  const body = h('div', { class: 'modal-body' });
  const dialog = h(
    'div',
    { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: close }, icon('close'))),
    body,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => e.target === backdrop && close() }, dialog);
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  modalCleanup = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose?.();
    previous?.focus?.();
  };
  if (typeof content === 'function') content(body, close);
  else if (content) append(body, [content]);
  requestAnimationFrame(() => dialog.querySelector('input, button:not(.icon-btn)')?.focus());
  return { body, close };
}

export function closeModal() {
  const fn = modalCleanup;
  modalCleanup = null;
  fn?.();
}

export function avatarColor(name = '') {
  let hsh = 0;
  for (const ch of name) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  const colors = ['#86e3c8', '#7fb2e5', '#e2b04a', '#e79bb0', '#a99be0', '#8fae8b', '#e3b778', '#f2c94c'];
  return colors[hsh % colors.length];
}

export function avatar(name, cls = 'avatar') {
  return h('span', { class: cls, style: { background: avatarColor(name) }, 'aria-hidden': 'true' }, (name || '?').slice(0, 1).toUpperCase());
}

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `il y a ${d} j` : new Date(iso).toLocaleDateString('fr-FR');
}

export function formatNumber(n) {
  return new Intl.NumberFormat('fr-FR').format(n ?? 0);
}

export function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Redimensionne et compresse une image côté navigateur pour respecter la limite serveur.
export async function compressImage(file, { maxSide = 512, maxBytes = 270 * 1024 } = {}) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Format accepté : PNG, JPEG, WebP ou GIF.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Image illisible.'));
      i.src = url;
    });
    let side = maxSide;
    for (let attempt = 0; attempt < 6; attempt++) {
      const ratio = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * ratio));
      c.height = Math.max(1, Math.round(img.naturalHeight * ratio));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      for (const q of [0.9, 0.8, 0.65]) {
        let data = c.toDataURL('image/webp', q);
        if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/png');
        if (data.length * 0.75 <= maxBytes) return data;
      }
      side = Math.round(side * 0.75);
    }
    throw new Error('Image trop lourde, même compressée.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

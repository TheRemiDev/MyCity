// Location / modification d'un panneau publicitaire.

import { post, patch } from '../api.js';
import { app } from '../app.js';
import { state } from '../state.js';
import { MAX_BRAND_LENGTH, MAX_MESSAGE_LENGTH, PALETTE, formatMoney } from '../shared/catalog.js';
import { contrastInk } from '../sprites.js';
import { h, toast, clear, compressImage } from './dom.js';
import { showPanel } from './panel.js';

export function openBillboardEditor(number, details, mode = 'rent') {
  const isAdmin = state.me?.role === 'admin';
  const ad = details.billboard.ad || {};
  const content = { brandName: ad.brandName || '', message: ad.message || '', website: ad.website || '', color: ad.color || '#1f2a44' };
  let image; // undefined = inchangé
  const currentImage = ad.image || null;
  let months = details.offers[0]?.months ?? 1;
  let adminMonths = 1;
  let owner = '';
  let busy = false;

  const previewBox = h('div', { class: 'preview', style: { height: '160px' } });
  function renderPreview() {
    const src = image === undefined ? currentImage : image;
    previewBox.style.background = content.color;
    clear(
      previewBox,
      h(
        'div',
        { style: { display: 'grid', placeItems: 'center', gap: '6px', padding: '12px', textAlign: 'center' } },
        src ? h('img', { src, alt: '', style: { maxWidth: '100%', maxHeight: content.message ? '100px' : '130px', objectFit: 'contain' } }) : h('strong', { style: { fontFamily: 'var(--display)', fontSize: '28px', color: contrastInk(content.color) } }, content.brandName || 'Votre marque'),
        content.message ? h('span', { style: { color: contrastInk(content.color), fontWeight: 500 } }, content.message) : null,
      ),
    );
  }

  const field = (label, key, max, placeholder) => {
    const input = h('input', { maxlength: max, placeholder });
    input.value = content[key];
    input.addEventListener('input', () => {
      content[key] = input.value;
      renderPreview();
    });
    return h('label', { class: 'field' }, h('span', {}, label), input);
  };

  const swatches = h('div', { class: 'swatches' });
  const renderSwatches = () =>
    clear(
      swatches,
      PALETTE.map((c) =>
        h('button', {
          class: `swatch${content.color === c.color ? ' active' : ''}`,
          style: { background: c.color },
          'aria-label': c.label,
          title: c.label,
          onclick: () => {
            content.color = c.color;
            renderSwatches();
            renderPreview();
          },
        }),
      ),
    );
  renderSwatches();

  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      image = await compressImage(f, { maxSide: 800 });
      renderPreview();
    } catch (e) {
      toast(e.message, 'error');
    }
    file.value = '';
  });

  const offers = h('div', { class: 'offers' });
  const renderOffers = () =>
    clear(
      offers,
      details.offers.map((o) =>
        h('button', {
          class: `offer${months === o.months ? ' active' : ''}`,
          onclick: () => {
            months = o.months;
            renderOffers();
            updatePrimary();
          },
        }, h('strong', {}, `${o.months} mois`), h('span', {}, formatMoney(o.priceCents, state.currency)), o.discount ? h('span', { class: 'save' }, `−${o.discount} %`) : null),
      ),
    );
  renderOffers();

  const error = h('div', { class: 'error-box', hidden: true });
  const primary = h('button', { class: 'btn primary block' });
  function updatePrimary() {
    const offer = details.offers.find((o) => o.months === months);
    if (mode === 'edit') primary.textContent = 'Enregistrer la pub';
    else if (isAdmin) primary.textContent = 'Afficher gratuitement';
    else primary.textContent = `${state.payments === 'demo' ? 'Louer (démo)' : 'Continuer vers le paiement'} · ${formatMoney(offer?.priceCents ?? 0, state.currency)}`;
    primary.disabled = busy;
  }

  primary.addEventListener('click', async () => {
    busy = true;
    updatePrimary();
    error.hidden = true;
    const payload = { ...content };
    if (image !== undefined) payload.image = image;
    try {
      if (mode === 'edit') {
        await patch(`/billboards/${number}`, payload);
        toast('Publicité mise à jour.');
      } else {
        const res = await post('/billboards/checkout', { billboard: number, months: isAdmin ? adminMonths : months, content: payload, owner: owner || undefined });
        if (res.url) {
          location.href = res.url;
          return;
        }
        toast(mode === 'extend' ? 'Location prolongée.' : 'Votre publicité est en ligne 📣');
      }
      await app.refreshMe();
      app.select({ type: 'billboard', number });
    } catch (e) {
      error.hidden = false;
      error.textContent = e.message;
    } finally {
      busy = false;
      updatePrimary();
    }
  });

  const body = [previewBox];
  {
    body.push(
      field('Nom de marque', 'brandName', MAX_BRAND_LENGTH, 'Votre marque'),
      field('Message (optionnel)', 'message', MAX_MESSAGE_LENGTH, 'Ex. -20 % ce week-end !'),
      field('Site (optionnel)', 'website', 300, 'https://exemple.fr'),
      h('div', { class: 'field' }, h('span', {}, 'Couleur de fond'), swatches),
      h('div', { class: 'field' }, h('span', {}, 'Visuel (optionnel)'), h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => file.click() }, 'Choisir une image'), h('button', { class: 'btn ghost small', onclick: () => { image = null; renderPreview(); } }, 'Retirer')), file),
    );
  }
  if (mode !== 'edit') {
    if (isAdmin) {
      const m = h('input', { type: 'number', min: 1, max: 120, value: 1 });
      m.addEventListener('input', () => (adminMonths = Number(m.value) || 1));
      const o = h('input', { placeholder: 'Laisser vide pour la mairie (vous)' });
      o.addEventListener('input', () => (owner = o.value));
      body.push(h('label', { class: 'field' }, h('span', {}, 'Durée (mois)'), m), h('label', { class: 'field' }, h('span', {}, 'Annonceur (administration)'), o));
    } else {
      body.push(h('div', { class: 'field' }, h('span', {}, 'Durée'), offers));
      if (state.payments === 'demo') body.push(h('div', { class: 'notice' }, 'Mode démo : la location est simulée.'));
    }
  }
  body.push(error);
  updatePrimary();
  renderPreview();
  showPanel({
    eyebrow: [h('span', {}, `Panneau #${number}`)],
    title: mode === 'edit' ? 'Modifier ma pub' : mode === 'extend' ? 'Prolonger ma pub' : 'Louer ce panneau',
    body,
    foot: [primary, h('button', { class: 'btn ghost block', onclick: () => app.select({ type: 'billboard', number }) }, 'Annuler')],
    onClose: ({ replaced } = {}) => !replaced && app.select(null),
  });
}

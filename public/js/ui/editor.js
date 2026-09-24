// Éditeur d'immeuble en 3 étapes avec aperçu en direct (dans le panneau ET sur la carte).

import { post, patch } from '../api.js';
import { app } from '../app.js';
import { state, districtInfo, plotState, emit } from '../state.js';
import {
  DEFAULT_BUILDING,
  MAX_BRAND_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MIN_FLOORS,
  PALETTE,
  ROOF_COLORS,
  ROOF_STYLES,
  SHAPES,
  WINDOW_STYLES,
  formatMoney,
  maxFloorsFor,
  plotPriceCents,
  upgradePriceCents,
} from '../shared/catalog.js';
import { drawBuilding, buildingHeight, ROOF_EXTRA } from '../sprites.js';
import { h, icon, toast, clear, compressImage } from './dom.js';
import { showPanel, closePanel } from './panel.js';

export function openEditor(number) {
  const plot = plotState(number);
  const district = districtInfo(plot.district);
  const isAdmin = state.me?.role === 'admin';
  const editing = plot.status === 'owned' && plot.building;
  const initial = editing ? plot.building : DEFAULT_BUILDING;
  const design = {
    floors: initial.floors,
    shape: initial.shape,
    roofStyle: initial.roofStyle,
    windows: initial.windows,
    color: initial.color,
    roofColor: initial.roofColor,
    accentColor: initial.accentColor,
  };
  const branding = {
    brandName: editing ? plot.building.brandName : '',
    description: editing ? plot.building.description : '',
    website: editing ? plot.building.website : '',
  };
  let logo; // undefined = inchangé, null = supprimé, string = nouveau
  const currentLogo = editing ? plot.building.logo : null;
  let step = 0;
  let owner = '';
  let busy = false;
  let front = 'left';
  let previewNight = false;

  const draftBuilding = () => ({
    ...design,
    brandName: branding.brandName,
    logoPreview: logo === undefined ? currentLogo : logo,
  });
  const syncDraft = () => {
    state.draft = { number, design: draftBuilding() };
    drawPreview();
    renderPrice();
  };

  // ---------------------------------------------------------------- aperçu
  const canvas = h('canvas', { width: 720, height: 480, 'aria-label': "Aperçu de l'immeuble" });
  const logoImg = new Image();
  logoImg.onload = () => drawPreview();
  function drawPreview() {
    const b = draftBuilding();
    const src = b.logoPreview;
    if (src && logoImg.getAttribute('src') !== src) logoImg.src = src;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (previewNight) {
      ctx.fillStyle = '#0e1526';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const H = buildingHeight(b) + ROOF_EXTRA * 0.7;
    const scale = Math.min(4.2, (canvas.height - 60) / (H + 20), (canvas.width * 0.8) / 72);
    ctx.translate(canvas.width / 2, canvas.height - 40);
    ctx.scale(scale, scale);
    // socle
    ctx.fillStyle = previewNight ? '#1b2436' : 'rgba(22,26,23,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, -16 - 4);
    ctx.lineTo(40, 0);
    ctx.lineTo(0, 20);
    ctx.lineTo(-40, 0);
    ctx.closePath();
    ctx.fill();
    drawBuilding(ctx, b, { front, night: previewNight, seed: number * 7, logo: src && logoImg.complete && logoImg.naturalWidth ? logoImg : null });
  }

  // ---------------------------------------------------------------- prix
  const priceEl = h('div', { class: 'summary' });
  function priceCents() {
    if (isAdmin) return 0;
    if (editing) return upgradePriceCents(plot.building.floors, design.floors, state.pricing);
    return plotPriceCents(district, design.floors, state.pricing);
  }
  function renderPrice() {
    const pricing = state.pricing;
    const rows = [];
    if (isAdmin) {
      rows.push(h('div', {}, h('span', {}, 'Administration'), h('span', {}, 'Gratuit')));
    } else if (editing) {
      const extra = Math.max(0, design.floors - plot.building.floors);
      rows.push(h('div', {}, h('span', {}, 'Modifications esthétiques'), h('span', {}, 'Gratuit')));
      if (extra) rows.push(h('div', {}, h('span', {}, `${extra} étage(s) supplémentaire(s)`), h('span', {}, formatMoney(extra * pricing.pricePerFloorCents, state.currency))));
      if (design.floors < plot.building.floors) rows.push(h('div', { class: 'muted small' }, h('span', {}, 'Réduire la hauteur est gratuit (sans remboursement).')));
    } else {
      rows.push(h('div', {}, h('span', {}, `Terrain · ${district.name}`), h('span', {}, formatMoney(district.basePriceCents, state.currency))));
      rows.push(h('div', {}, h('span', {}, `${design.floors} étage(s) × ${formatMoney(pricing.pricePerFloorCents, state.currency)}`), h('span', {}, formatMoney(design.floors * pricing.pricePerFloorCents, state.currency))));
    }
    rows.push(h('div', { class: 'total' }, h('span', {}, 'Total'), h('span', {}, formatMoney(priceCents(), state.currency))));
    clear(priceEl, rows);
    updateFoot();
  }

  // ---------------------------------------------------------------- étapes
  const content = h('div', { style: { display: 'grid', gap: '16px' } });
  const stepsBar = h('div', { class: 'steps' }, h('span'), h('span'), h('span'));
  const error = h('div', { class: 'error-box', hidden: true });
  const primary = h('button', { class: 'btn primary block' });
  const secondary = h('button', { class: 'btn ghost block' });

  function swatches(list, key, withCustom = true) {
    const wrap = h('div', { class: 'swatches' });
    const render = () =>
      clear(
        wrap,
        list.map((c) =>
          h('button', {
            class: `swatch${design[key] === c.color ? ' active' : ''}`,
            style: { background: c.color },
            title: c.label,
            'aria-label': c.label,
            'aria-pressed': String(design[key] === c.color),
            onclick: () => {
              design[key] = c.color;
              render();
              syncDraft();
            },
          }),
        ),
        withCustom
          ? h('label', { class: 'swatch-custom', title: 'Couleur personnalisée' },
              h('input', {
                type: 'color',
                value: design[key],
                'aria-label': 'Couleur personnalisée',
                oninput: (e) => {
                  design[key] = e.target.value;
                  syncDraft();
                },
                onchange: () => render(),
              }))
          : null,
      );
    render();
    return wrap;
  }

  function pills(list, key) {
    const wrap = h('div', { class: 'pills' });
    const render = () =>
      clear(
        wrap,
        list.map((o) =>
          h('button', {
            class: `pill${design[key] === o.id ? ' active' : ''}`,
            'aria-pressed': String(design[key] === o.id),
            onclick: () => {
              design[key] = o.id;
              render();
              syncDraft();
            },
          }, o.label),
        ),
      );
    render();
    return wrap;
  }

  function stepDesign() {
    const floorsNum = h('span', { class: 'num' }, design.floors);
    const slider = h('input', { type: 'range', min: MIN_FLOORS, max: maxFloorsFor(design.shape), value: design.floors, 'aria-label': "Nombre d'étages" });
    const setFloors = (n) => {
      design.floors = Math.max(MIN_FLOORS, Math.min(maxFloorsFor(design.shape), n));
      slider.value = design.floors;
      floorsNum.textContent = design.floors;
      syncDraft();
    };
    slider.addEventListener('input', () => setFloors(Number(slider.value)));
    const shapes = h('div', { class: 'options' });
    const renderShapes = () =>
      clear(
        shapes,
        SHAPES.map((s) =>
          h('button', {
            class: `option${design.shape === s.id ? ' active' : ''}`,
            'aria-pressed': String(design.shape === s.id),
            onclick: () => {
              design.shape = s.id;
              slider.max = maxFloorsFor(s.id);
              setFloors(design.floors);
              renderShapes();
            },
          }, h('strong', {}, s.label), h('small', {}, `${s.hint} · max ${s.maxFloors} ét.`)),
        ),
      );
    renderShapes();
    return [
      h('p', { class: 'muted', style: { margin: 0 } }, 'Choisissez la hauteur, la forme, le toit, les fenêtres et les couleurs. Le prix et l\'immeuble se mettent à jour en direct.'),
      h('div', { class: 'field' }, h('span', {}, 'Hauteur'),
        h('div', { class: 'range' },
          h('button', { class: 'step-btn', 'aria-label': 'Un étage de moins', onclick: () => setFloors(design.floors - 1) }, '−'),
          slider,
          h('div', { class: 'row', style: { gap: '4px', flexWrap: 'nowrap' } }, floorsNum, h('button', { class: 'step-btn', 'aria-label': 'Un étage de plus', onclick: () => setFloors(design.floors + 1) }, '+')),
        )),
      h('div', { class: 'field' }, h('span', {}, 'Forme'), shapes),
      h('div', { class: 'field' }, h('span', {}, 'Toit'), pills(ROOF_STYLES, 'roofStyle')),
      h('div', { class: 'field' }, h('span', {}, 'Fenêtres'), pills(WINDOW_STYLES, 'windows')),
      h('div', { class: 'field' }, h('span', {}, 'Façade'), swatches(PALETTE, 'color')),
      h('div', { class: 'field' }, h('span', {}, 'Couleur du toit'), swatches(ROOF_COLORS, 'roofColor')),
      h('div', { class: 'field' }, h('span', {}, "Couleur d'accent (enseigne, porte, corniche)"), swatches(PALETTE, 'accentColor')),
    ];
  }

  function textField(label, key, max, { multiline = false, placeholder = '', type = 'text' } = {}) {
    const counter = h('span', { class: 'counter' }, `${(branding[key] || '').length}/${max}`);
    const input = h(multiline ? 'textarea' : 'input', { type: multiline ? undefined : type, maxlength: max, placeholder, rows: multiline ? 3 : undefined });
    input.value = branding[key] || '';
    input.addEventListener('input', () => {
      branding[key] = input.value;
      counter.textContent = `${input.value.length}/${max}`;
      if (key === 'brandName') syncDraft();
    });
    return h('label', { class: 'field' }, h('span', {}, label), input, counter);
  }

  function stepIdentity() {
    const thumb = h('div', { class: 'thumb' });
    const removeBtn = h('button', { class: 'btn ghost small' }, 'Retirer');
    const renderThumb = () => {
      const src = logo === undefined ? currentLogo : logo;
      clear(thumb, src ? h('img', { src, alt: 'Logo' }) : 'Aucun');
      removeBtn.hidden = !src;
    };
    removeBtn.addEventListener('click', () => {
      logo = null;
      renderThumb();
      syncDraft();
    });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        logo = await compressImage(f);
        renderThumb();
        syncDraft();
      } catch (e) {
        toast(e.message, 'error');
      }
      file.value = '';
    });
    renderThumb();
    const out = [
      textField('Nom de marque (enseigne)', 'brandName', MAX_BRAND_LENGTH, { placeholder: 'Ex. Boulangerie Dupont' }),
      textField('Description', 'description', MAX_DESCRIPTION_LENGTH, { multiline: true, placeholder: 'Ce que vous faites, en quelques mots.' }),
      textField('Site (optionnel)', 'website', 300, { placeholder: 'https://exemple.fr', type: 'url' }),
      h('div', { class: 'field' }, h('span', {}, 'Visuel (optionnel, max 280 Ko)'),
        h('div', { class: 'upload' }, thumb, h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => file.click() }, 'Choisir une image'), removeBtn), file),
        h('small', { class: 'muted' }, 'PNG, JPEG, WebP ou GIF. Les images sont redimensionnées automatiquement.')),
    ];
    if (isAdmin && !editing) {
      const ownerInput = h('input', { placeholder: 'Laisser vide pour la mairie (vous)', autocomplete: 'off' });
      ownerInput.value = owner;
      ownerInput.addEventListener('input', () => (owner = ownerInput.value));
      out.push(h('label', { class: 'field' }, h('span', {}, 'Propriétaire (administration)'), ownerInput, h('small', { class: 'muted' }, "Nom d'utilisateur d'un habitant pour lui offrir directement l'immeuble.")));
    }
    return out;
  }

  function stepSummary() {
    const out = [priceEl];
    if (!isAdmin && state.payments === 'demo') {
      out.push(h('div', { class: 'notice' }, "Mode démo : aucun paiement n'est configuré sur ce serveur, l'achat est simulé."));
    }
    if (!isAdmin && !editing) {
      out.push(h('div', { class: 'notice info' }, `Le terrain vous sera réservé pendant 15 minutes le temps du paiement sécurisé. Il est à vous, définitivement.`));
    }
    out.push(
      h('p', { class: 'muted small', style: { margin: 0 } },
        'En validant, vous acceptez les ',
        h('a', { href: '/conditions', target: '_blank' }, "conditions d'utilisation"),
        '. Les contenus illicites, trompeurs ou choquants seront retirés.'),
    );
    return out;
  }

  function updateFoot() {
    const price = priceCents();
    if (step < 2) {
      primary.textContent = step === 0 ? 'Continuer : identité' : 'Continuer : récapitulatif';
      secondary.textContent = step === 0 ? 'Annuler' : 'Retour';
    } else {
      secondary.textContent = 'Retour';
      if (isAdmin) primary.textContent = editing ? 'Enregistrer (gratuit)' : 'Construire gratuitement';
      else if (editing) primary.textContent = price > 0 ? `Enregistrer et payer ${formatMoney(price, state.currency)}` : 'Enregistrer les modifications';
      else primary.textContent = state.payments === 'demo' ? `Réclamer (démo) · ${formatMoney(price, state.currency)}` : `Continuer vers le paiement · ${formatMoney(price, state.currency)}`;
    }
    primary.disabled = busy;
  }

  function renderStep() {
    stepsBar.querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', i <= step));
    error.hidden = true;
    clear(content, step === 0 ? stepDesign() : step === 1 ? stepIdentity() : stepSummary());
    updateFoot();
    content.closest('.panel-body')?.scrollTo({ top: 0 });
  }

  primary.addEventListener('click', () => {
    if (step < 2) {
      step++;
      renderStep();
    } else submit();
  });
  secondary.addEventListener('click', () => {
    if (step === 0) cancel();
    else {
      step--;
      renderStep();
    }
  });

  function cancel() {
    state.draft = null;
    app.select({ type: 'plot', number });
  }

  async function submit() {
    busy = true;
    updateFoot();
    error.hidden = true;
    const brandingPayload = { ...branding };
    if (logo !== undefined) brandingPayload.logo = logo;
    try {
      let res;
      if (editing) {
        res = await patch(`/buildings/${number}`, { design, branding: brandingPayload });
        if (res.payment?.url) {
          location.href = res.payment.url;
          return;
        }
        toast(res.payment?.fulfilled ? 'Immeuble surélevé et mis à jour ✨' : 'Immeuble mis à jour ✨');
      } else {
        res = await post('/checkout', { plot: number, design, branding: brandingPayload, owner: owner || undefined });
        if (res.url) {
          location.href = res.url;
          return;
        }
        toast(isAdmin ? 'Immeuble construit par la mairie 🏗️' : 'Félicitations, ce terrain est à vous ! 🎉');
        if (!isAdmin) emit('celebrate', number);
      }
      state.draft = null;
      await app.refreshMe();
      app.select({ type: 'plot', number });
    } catch (e) {
      error.hidden = false;
      error.textContent = e.message;
      if (e.status === 401) app.openAuth('login');
    } finally {
      busy = false;
      updateFoot();
    }
  }

  const preview = h(
    'div',
    { class: 'preview' },
    canvas,
    h(
      'div',
      { class: 'turn' },
      h('button', { 'aria-label': 'Pivoter', title: 'Pivoter', onclick: () => { front = front === 'left' ? 'right' : 'left'; drawPreview(); } }, icon('rotr', 16)),
      h('button', { 'aria-label': 'Jour / nuit', title: 'Jour / nuit', onclick: () => { previewNight = !previewNight; drawPreview(); } }, '☾'),
    ),
  );

  showPanel({
    eyebrow: [h('span', {}, `Terrain #${number} · ${district?.name ?? ''}`)],
    title: editing ? 'Modifier mon immeuble' : isAdmin ? 'Construire (administration)' : 'Personnaliser mon immeuble',
    body: [stepsBar, preview, content, error],
    foot: [primary, secondary],
    onClose: ({ replaced } = {}) => {
      state.draft = null;
      if (!replaced && state.selection?.type === 'plot' && state.selection.number === number) app.select(null);
    },
  });
  app.renderer?.focusPlot(number, Math.max(app.renderer.cam.zoom, 1.5));
  renderStep();
  syncDraft();
  // La police des enseignes peut arriver après le premier rendu.
  document.fonts?.ready.then(drawPreview);
  void closePanel;
}

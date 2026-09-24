// Point d'entrée : charge la ville, branche le rendu, le temps réel et l'interface.

import { get, post } from './api.js';
import { app } from './app.js';
import { state, on, emit, plotState, districtInfo, loadSetting, saveSetting } from './state.js';
import { generateCity } from './shared/citygen.js';
import { formatMoney, plotPriceCents } from './shared/catalog.js';
import { createRenderer } from './renderer.js';
import { createTraffic } from './traffic.js';
import { createMinimap } from './minimap.js';
import { h, toast, clear } from './ui/dom.js';
import { closePanel } from './ui/panel.js';
import { showPlot, showBillboard, showLandmark, refreshOpenPanel } from './ui/details.js';
import { openEditor } from './ui/editor.js';
import { openBillboardEditor } from './ui/billboardEditor.js';
import { renderAccountSlot, openAuth, openAccount, openProfile, openSetup, openMobileMenu } from './ui/account.js';
import { openLeaderboard, openStats } from './ui/modals.js';
import { initFeed, setEvents, pushEvent } from './ui/feed.js';
import { initSearch } from './ui/search.js';

let renderer;
let minimap;

function applyCity(data) {
  state.seed = data.seed;
  state.currency = data.currency;
  state.payments = data.payments;
  state.pricing = data.pricing;
  state.districts = data.districts;
  state.stats = data.stats;
  state.announcement = data.announcement;
  state.plots = new Map(data.plots.map((p) => [p.number, p]));
  state.billboards = new Map(data.billboards.map((b) => [b.number, b]));
}

async function refreshMe() {
  try {
    const { user } = await get('/me');
    state.me = user;
  } catch {
    state.me = null;
  }
  renderAccountSlot();
}

function requireAuth() {
  if (state.me) return true;
  openAuth('register');
  toast('Créez un compte (gratuit) pour continuer.', 'warn');
  return false;
}

// ------------------------------------------------------------------ sélection
function select(target, { focus = false, keepPanel = false } = {}) {
  state.draft = null;
  state.selection = target;
  const params = new URLSearchParams();
  if (!target) {
    if (!keepPanel) closePanel();
    history.replaceState(null, '', location.pathname);
    return;
  }
  if (target.type === 'plot') {
    params.set('plot', target.number);
    if (focus) renderer.focusPlot(target.number);
    showPlot(target.number);
  } else if (target.type === 'billboard') {
    params.set('billboard', target.number);
    const b = state.city.billboards[target.number - 1];
    if (focus) renderer.focusTile(b.x, b.y, Math.max(renderer.cam.zoom, 1.4));
    showBillboard(target.number);
  } else if (target.type === 'landmark') {
    const lm = target.landmark;
    if (focus) renderer.focusTile(lm.x + 2, lm.y + 2);
    showLandmark(lm);
  }
  history.replaceState(null, '', params.toString() ? `/?${params}` : location.pathname);
}

// ------------------------------------------------------------------ CTA : terrain au hasard
function cheapestFree() {
  let best = null;
  for (const d of state.districts) {
    if (!d.unlocked || d.owned >= d.total) continue;
    const price = plotPriceCents(d, 1, state.pricing);
    if (!best || price < best.price) best = { price, district: d.id };
  }
  return best;
}

function updateCta() {
  const cta = document.getElementById('cta');
  const best = cheapestFree();
  cta.textContent = best ? `Réclamer un terrain dès ${formatMoney(best.price, state.currency)}` : 'Tous les terrains sont pris !';
  cta.disabled = !best;
}

function claimRandom() {
  const free = state.city.lots.filter((l) => districtInfo(l.district)?.unlocked && plotState(l.number).status === 'free');
  if (!free.length) return toast('Aucun terrain disponible pour le moment.', 'warn');
  // On privilégie les terrains proches du centre, avec un peu de hasard.
  free.sort((a, b) => a.number - b.number);
  const pick = free[Math.floor(Math.random() * Math.min(free.length, 40))];
  select({ type: 'plot', number: pick.number }, { focus: true });
}

// ------------------------------------------------------------------ infobulle
function showTooltip(hit, x, y) {
  const tip = document.getElementById('tooltip');
  if (!hit || matchMedia('(hover: none)').matches) {
    tip.hidden = true;
    return;
  }
  let title = '';
  let sub = '';
  if (hit.type === 'plot') {
    const p = plotState(hit.number);
    const d = districtInfo(p.district);
    if (p.status === 'owned') {
      title = p.building?.brandName || `Terrain #${p.number}`;
      sub = `${p.owner ?? ''} · ${p.building?.floors} étages · ${d?.name}`;
    } else if (p.status === 'reserved') {
      title = `Terrain #${p.number} · réservé`;
      sub = d?.name;
    } else {
      title = `Terrain #${p.number} · ${d?.unlocked ? 'disponible' : 'bientôt'}`;
      sub = d?.unlocked ? `dès ${formatMoney(plotPriceCents(d, 1, state.pricing), state.currency)} · ${d.name}` : `${d?.name} ouvre à ${d?.unlockAt} terrains vendus`;
    }
  } else if (hit.type === 'billboard') {
    const b = state.billboards.get(hit.number);
    title = b?.status === 'rented' ? b.ad.brandName || `Pub #${hit.number}` : `Panneau #${hit.number}`;
    sub = b?.status === 'rented' ? `Annonceur : ${b.renter ?? '—'}` : 'Emplacement publicitaire à louer';
  } else if (hit.type === 'landmark') {
    title = hit.landmark.name;
    sub = hit.landmark.blurb;
  }
  clear(tip, h('strong', {}, title), h('small', {}, sub));
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.hidden = false;
}

// ------------------------------------------------------------------ visite guidée
let tour = null;
function toggleTour(force) {
  const btn = document.querySelector('[data-action="tour"]');
  if (tour || force === false) {
    clearInterval(tour);
    tour = null;
    btn.classList.remove('active');
    return;
  }
  const owned = [...state.plots.values()].filter((p) => p.status === 'owned');
  const stops = owned.length ? owned.sort(() => Math.random() - 0.5) : [];
  const landmarks = state.city.landmarks.filter((l) => l.id !== 'park');
  let i = 0;
  const next = () => {
    if (stops.length && i % 3 !== 2) {
      const p = stops[i % stops.length];
      state.selection = { type: 'plot', number: p.number };
      renderer.focusPlot(p.number, 1.6);
      toast(`${p.building?.brandName || `Terrain #${p.number}`} — ${p.owner ?? ''}`, 'info', 3000);
    } else {
      const lm = landmarks[i % landmarks.length];
      state.selection = null;
      renderer.focusTile(lm.x + 2, lm.y + 2, 1.1, false);
      toast(lm.name, 'info', 3000);
    }
    i++;
  };
  next();
  tour = setInterval(next, 4500);
  btn.classList.add('active');
  toast('Visite guidée lancée. Touchez la carte pour l\'arrêter.');
}

// ------------------------------------------------------------------ confettis
on('celebrate', () => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#86e3c8', '#f2c94c', '#e79bb0', '#7fb2e5', '#e24a3b'];
  for (let i = 0; i < 80; i++) {
    const el = h('i', { style: { position: 'fixed', left: '50%', top: '40%', width: '8px', height: '12px', background: colors[i % colors.length], zIndex: 70, borderRadius: '2px', pointerEvents: 'none' } });
    document.body.append(el);
    const a = Math.random() * Math.PI * 2;
    const d = 150 + Math.random() * 300;
    el.animate(
      [
        { transform: 'translate(0,0) rotate(0)', opacity: 1 },
        { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d + 300}px) rotate(${Math.random() * 720}deg)`, opacity: 0 },
      ],
      { duration: 1400 + Math.random() * 800, easing: 'cubic-bezier(.2,.7,.4,1)' },
    ).onfinish = () => el.remove();
  }
});

// ------------------------------------------------------------------ temps réel
function connectLive() {
  const es = new EventSource('/api/live');
  es.addEventListener('presence', (e) => {
    const { online } = JSON.parse(e.data);
    document.getElementById('online-count').textContent = online;
    if (state.stats) state.stats.online = online;
  });
  es.addEventListener('event', (e) => pushEvent(JSON.parse(e.data)));
  es.addEventListener('plot', (e) => {
    const { plot } = JSON.parse(e.data);
    const previous = state.plots.get(plot.number);
    if (plot.status === 'free') state.plots.delete(plot.number);
    else state.plots.set(plot.number, plot);
    // Mise à jour des compteurs de quartier sans recharger
    const d = districtInfo(plot.district);
    if (d) d.owned += (plot.status === 'owned' ? 1 : 0) - (previous?.status === 'owned' ? 1 : 0);
    if (state.stats) state.stats.plotsOwned += (plot.status === 'owned' ? 1 : 0) - (previous?.status === 'owned' ? 1 : 0);
    renderer.invalidatePlot(plot.number);
    minimap.invalidate();
    updateCta();
    if (state.selection?.type === 'plot' && state.selection.number === plot.number && !state.draft) showPlot(plot.number);
  });
  es.addEventListener('billboard', (e) => {
    const { billboard } = JSON.parse(e.data);
    state.billboards.set(billboard.number, billboard);
    minimap.invalidate();
    if (state.selection?.type === 'billboard' && state.selection.number === billboard.number && !document.querySelector('.panel .preview')) showBillboard(billboard.number);
  });
  es.addEventListener('like', (e) => {
    const { number, likes } = JSON.parse(e.data);
    const p = state.plots.get(number);
    if (p) p.likes = likes;
  });
  es.addEventListener('districts', (e) => {
    state.districts = JSON.parse(e.data).districts;
    minimap.invalidate();
    updateCta();
  });
  es.addEventListener('announcement', (e) => {
    state.announcement = JSON.parse(e.data).announcement;
    renderAnnouncement();
  });
  let failures = 0;
  es.onerror = () => {
    failures++;
    if (failures === 3) toast('Connexion temps réel interrompue, nouvelle tentative…', 'warn');
  };
  es.onopen = () => {
    if (failures >= 3) {
      toast('Reconnecté.');
      resync();
    }
    failures = 0;
  };
}

async function resync() {
  try {
    applyCity(await get('/city'));
    renderer.invalidateAll();
    minimap.invalidate();
    updateCta();
  } catch {
    /* on réessaiera */
  }
}

function renderAnnouncement() {
  const el = document.getElementById('announcement');
  const a = state.announcement;
  let dismissed = null;
  try {
    dismissed = sessionStorage.getItem('mycity:dismissed-announcement');
  } catch {
    /* ignore */
  }
  if (!a || dismissed === a.at) {
    el.hidden = true;
    return;
  }
  clear(el, h('span', {}, `📢 ${a.message}`), h('button', {
    'aria-label': "Masquer l'annonce",
    onclick: () => {
      try {
        sessionStorage.setItem('mycity:dismissed-announcement', a.at);
      } catch {
        /* ignore */
      }
      el.hidden = true;
    },
  }, '×'));
  el.hidden = false;
}

// ------------------------------------------------------------------ retour de paiement
async function handleCheckoutReturn(params) {
  const status = params.get('checkout');
  if (!status) return false;
  history.replaceState(null, '', location.pathname);
  if (status === 'cancel') {
    const order = params.get('order');
    if (order && state.me) await post(`/checkout/${order}/cancel`).catch(() => {});
    toast('Paiement annulé : le terrain a été libéré.', 'warn');
    await refreshMe();
    return true;
  }
  const sessionId = params.get('session_id');
  if (!sessionId) return false;
  try {
    const res = await get(`/checkout/confirm?session_id=${encodeURIComponent(sessionId)}`);
    await refreshMe();
    if (!res.paid) {
      toast('Paiement en cours de validation… Votre bien apparaîtra dès confirmation.', 'warn', 6000);
      return true;
    }
    if (res.conflict) {
      toast("Paiement reçu, mais le bien n'était plus disponible. L'équipe va vous rembourser.", 'error', 9000);
      return true;
    }
    toast(res.kind === 'billboard' ? 'Paiement confirmé, votre pub est en ligne 📣' : 'Paiement confirmé, bienvenue chez vous ! 🎉', 'info', 6000);
    emit('celebrate');
    await resync();
    select({ type: res.kind === 'billboard' ? 'billboard' : 'plot', number: res.target }, { focus: true });
  } catch (e) {
    toast(e.message, 'error');
  }
  return true;
}

// ------------------------------------------------------------------ barre d'outils
function initToolbar() {
  const actions = {
    'zoom-in': () => renderer.zoomAt(1.3),
    'zoom-out': () => renderer.zoomAt(1 / 1.3),
    rotate: () => renderer.rotate(),
    home: () => renderer.centerOn(33, 31, 1),
    daynight: () => {
      const auto = state.settings.night === null;
      const currentlyNight = renderer.isNight();
      // cycle : auto -> inverse -> auto
      state.settings.night = auto ? !currentlyNight : null;
      toast(state.settings.night === null ? 'Cycle jour/nuit automatique (heure locale).' : state.settings.night ? 'Mode nuit.' : 'Mode jour.');
      syncToolbar();
    },
    labels: () => {
      state.settings.labels = !state.settings.labels;
      saveSetting('labels', state.settings.labels);
      syncToolbar();
    },
    heatmap: () => {
      state.settings.heatmap = !state.settings.heatmap;
      toast(state.settings.heatmap ? 'Carte des prix : vert = disponible (foncé = plus cher), rouge = construit, jaune = réservé.' : 'Vue normale.', 'info', 5000);
      syncToolbar();
    },
    tour: () => toggleTour(),
    leaderboard: () => openLeaderboard(),
    stats: () => openStats(),
    menu: () => openMobileMenu(),
    'claim-random': () => claimRandom(),
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.dataset.action === 'toggle-feed') return;
    actions[el.dataset.action]?.();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const map = { r: 'rotate', n: 'daynight', l: 'labels', p: 'heatmap', h: 'home', v: 'tour', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out' };
    const action = map[e.key.toLowerCase()];
    if (action) actions[action]();
    if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) select(null);
  });
}

function syncToolbar() {
  document.querySelector('[data-action="labels"]').classList.toggle('active', state.settings.labels);
  document.querySelector('[data-action="heatmap"]').classList.toggle('active', state.settings.heatmap);
  document.querySelector('[data-action="daynight"]').classList.toggle('active', state.settings.night !== null);
}

// ------------------------------------------------------------------ démarrage
async function boot() {
  const params = new URLSearchParams(location.search);
  let city;
  let setup;
  let events;
  try {
    [city, setup, events] = await Promise.all([get('/city'), get('/setup'), get('/events'), refreshMe()]);
  } catch (e) {
    document.querySelector('#loader p').textContent = `IMPOSSIBLE DE CHARGER LA VILLE — ${e.message}`;
    return;
  }
  applyCity(city);
  state.city = generateCity(city.seed);
  state.settings.labels = loadSetting('labels', true);

  Object.assign(app, {
    select,
    refreshMe: async () => {
      await refreshMe();
    },
    requireAuth,
    openEditor,
    openBillboardEditor,
    openProfile,
    openAccount,
    openAuth,
    openLeaderboard,
    openStats,
    claimRandom,
    closePanel,
    onAuthChange: () => refreshOpenPanel(),
  });

  renderer = createRenderer(document.getElementById('city'), {
    onSelect: (hit) => {
      if (tour) toggleTour(false);
      document.getElementById('tooltip').hidden = true;
      if (!hit) return select(null);
      if (hit.type === 'landmark') select({ type: 'landmark', landmark: hit.landmark });
      else select({ type: hit.type, number: hit.number });
    },
    onHover: showTooltip,
  });
  app.renderer = renderer;
  renderer.setTraffic(createTraffic(state.city));
  minimap = createMinimap(document.getElementById('minimap'), renderer);

  initToolbar();
  syncToolbar();
  initFeed();
  initSearch();
  if (matchMedia('(max-width: 640px)').matches) document.getElementById('search').placeholder = 'Rechercher…';
  setEvents(events.events);
  updateCta();
  renderAnnouncement();
  connectLive();
  document.getElementById('online-count').textContent = city.stats.online || 1;

  document.getElementById('loader').classList.add('done');
  setTimeout(() => document.getElementById('hint')?.remove(), 12000);

  if (setup.needed) {
    openSetup(setup);
    return;
  }
  if (await handleCheckoutReturn(params)) return;
  if (params.get('plot')) {
    const number = Number(params.get('plot'));
    if (!state.city.lots[number - 1]) return toast('Terrain introuvable.', 'error');
    select({ type: 'plot', number }, { focus: true });
    if (params.get('edit') && state.me) openEditor(number);
  }
  else if (params.get('billboard') && state.city.billboards[Number(params.get('billboard')) - 1]) select({ type: 'billboard', number: Number(params.get('billboard')) }, { focus: true });
  else if (params.get('user')) openProfile(params.get('user'));
}

boot();

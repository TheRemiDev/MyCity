// Console d'administration (la « mairie »).

import { get, post, patch, api } from './api.js';
import { DEFAULT_BUILDING, SHAPES, formatMoney } from './shared/catalog.js';
import { h, clear, toast, openModal, formatNumber, timeAgo } from './ui/dom.js';

const main = document.getElementById('admin-main');
const tabsEl = document.getElementById('admin-tabs');
let currency = 'EUR';

const TABS = [
  ['dashboard', 'Tableau de bord', dashboard],
  ['users', 'Habitants', users],
  ['plots', 'Immeubles', plots],
  ['billboards', 'Panneaux', billboards],
  ['reports', 'Signalements', reports],
  ['orders', 'Commandes', orders],
  ['settings', 'Réglages', settings],
];

function renderTabs(active) {
  clear(tabsEl, TABS.map(([id, label]) => h('button', { class: `tab${id === active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(id === active), onclick: () => go(id) }, label)));
}

async function go(id) {
  const tab = TABS.find((t) => t[0] === id) || TABS[0];
  history.replaceState(null, '', `#${tab[0]}`);
  renderTabs(tab[0]);
  clear(main, h('p', { class: 'muted' }, 'Chargement…'));
  try {
    await tab[2]();
  } catch (e) {
    clear(main, h('div', { class: 'error-box' }, e.message));
  }
}

const money = (c) => formatMoney(c || 0, currency);
const date = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const table = (headers, rows) =>
  h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: headers.length, class: 'muted' }, 'Rien à afficher.')))));

async function run(fn, success) {
  try {
    await fn();
    if (success) toast(success);
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

// ------------------------------------------------------------------ tableau de bord
async function dashboard() {
  const d = await get('/admin/overview');
  const s = d.stats;
  const tile = (label, value) => h('div', { class: 'stat' }, h('small', {}, label), h('strong', {}, value));

  // Recettes des 30 derniers jours : une barre par jour (série unique, une seule couleur).
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    days.push({ day, cents: d.revenue.daily.find((r) => r.day === day)?.cents ?? 0, n: d.revenue.daily.find((r) => r.day === day)?.n ?? 0 });
  }
  const max = Math.max(1, ...days.map((x) => x.cents));
  const chart = h('div', { class: 'chart', role: 'img', 'aria-label': 'Recettes par jour sur 30 jours' },
    days.map((x) => h('div', { class: 'col', style: { height: `${(x.cents / max) * 100}%` }, 'data-tip': `${new Date(x.day).toLocaleDateString('fr-FR')} · ${money(x.cents)} · ${x.n} commande(s)` })));

  const annInput = h('input', { maxlength: 200, placeholder: 'Ex. Le Quartier des Arts ouvre ce week-end !' });
  annInput.value = d.announcement?.message ?? '';

  clear(
    main,
    h('h1', {}, 'Tableau de bord'),
    d.conflicts ? h('div', { class: 'notice' }, `${d.conflicts} paiement(s) reçu(s) pour un bien devenu indisponible : remboursement à effectuer depuis Stripe (onglet Commandes).`) : null,
    h('div', { class: 'stat-grid four' },
      tile('Recettes totales', money(d.revenue.totalCents)),
      tile('Recettes 30 j', money(d.revenue.last30Cents)),
      tile('Commandes payées', formatNumber(d.revenue.orders)),
      tile('Signalements ouverts', formatNumber(d.openReports)),
      tile('Terrains construits', `${formatNumber(s.plotsOwned)} / ${formatNumber(s.plotsTotal)}`),
      tile('Habitants inscrits', formatNumber(s.citizens)),
      tile('Pubs affichées', `${s.billboardsRented} / ${s.billboardsTotal}`),
      tile('Visites 24 h', formatNumber(s.visits24h))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' }, h('h2', {}, 'Recettes — 30 derniers jours'), chart, h('div', { class: 'chart-axis' }, h('span', {}, new Date(days[0].day).toLocaleDateString('fr-FR')), h('span', {}, "Aujourd'hui"))),
      h('section', { class: 'card' }, h('h2', {}, 'Occupation des quartiers'),
        h('div', { class: 'bars' }, d.districts.map((x) => h('div', { class: 'bar-row', title: `${x.owned}/${x.total}` },
          h('span', { class: 'name' }, h('i', { style: { background: x.color } }), x.name),
          h('span', { class: 'track' }, h('span', { class: 'fill', style: { display: 'block', width: `${x.total ? Math.max((x.owned / x.total) * 100, x.owned ? 1 : 0) : 0}%`, background: x.color } })),
          h('span', { class: 'v' }, x.unlocked ? `${x.owned}/${x.total}` : `🔒 ${x.unlockAt}`)))))),
    h('section', { class: 'card' },
      h('h2', {}, 'Annonce publique'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Affichée en haut de la carte pour tous les visiteurs, en temps réel. Laissez vide pour la retirer.'),
      h('div', { class: 'toolbar-row' }, h('label', { class: 'field', style: { flex: 1 } }, annInput),
        h('button', { class: 'btn primary', onclick: () => run(() => post('/admin/announce', { message: annInput.value }), annInput.value ? 'Annonce publiée.' : 'Annonce retirée.') }, 'Publier'))),
  );
}

// ------------------------------------------------------------------ habitants
async function users(q = '') {
  const { users: list } = await get(`/admin/users?q=${encodeURIComponent(q)}`);
  const search = h('input', { type: 'search', placeholder: 'Rechercher par nom ou e-mail', value: q });
  search.addEventListener('change', () => users(search.value));
  clear(
    main,
    h('h1', {}, 'Habitants'),
    h('div', { class: 'toolbar-row' }, h('label', { class: 'field', style: { flex: 1 } }, search), h('button', { class: 'btn', onclick: () => users(search.value) }, 'Rechercher')),
    h('section', { class: 'card' }, table(
      ['Habitant', 'E-mail', 'Rôle', 'Terrains', 'Dépensé', 'Inscrit', 'Vu', ''],
      list.map((u) => h('tr', {},
        h('td', {}, h('a', { href: `/?user=${encodeURIComponent(u.username)}` }, u.username)),
        h('td', {}, u.email),
        h('td', {}, h('span', { class: `tag ${u.role === 'admin' ? 'admin' : ''}` }, u.role === 'admin' ? 'Admin' : 'Habitant'), u.banned ? h('span', { class: 'tag banned' }, ' Suspendu') : null),
        h('td', { class: 'num' }, u.plots),
        h('td', { class: 'num' }, money(u.spent)),
        h('td', {}, date(u.created_at)),
        h('td', {}, u.last_seen_at ? timeAgo(u.last_seen_at) : '—'),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn small ghost', onclick: async () => (await run(() => patch(`/admin/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' }), 'Rôle modifié.')) && users(q) }, u.role === 'admin' ? 'Retirer admin' : 'Promouvoir admin'),
          h('button', { class: `btn small ${u.banned ? 'ghost' : 'danger'}`, onclick: async () => (await run(() => patch(`/admin/users/${u.id}`, { banned: !u.banned }), u.banned ? 'Compte réactivé.' : 'Compte suspendu.')) && users(q) }, u.banned ? 'Réactiver' : 'Suspendre'))),
      )),
    )),
  );
}

// ------------------------------------------------------------------ immeubles
async function plots(status = 'owned') {
  const { plots: list } = await get(`/admin/plots?status=${status}`);
  const filter = h('select', {}, [['owned', 'Construits'], ['reserved', 'Réservés'], ['free', 'Libres']].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  filter.addEventListener('change', () => plots(filter.value));

  const n = h('input', { type: 'number', min: 1, placeholder: 'N° de terrain' });
  const owner = h('input', { placeholder: 'Propriétaire (vide = la mairie)' });
  const brand = h('input', { placeholder: 'Enseigne (optionnel)', maxlength: 32 });
  const floors = h('input', { type: 'number', min: 1, max: 60, value: DEFAULT_BUILDING.floors });
  const shape = h('select', {}, SHAPES.map((s) => h('option', { value: s.id }, s.label)));

  clear(
    main,
    h('h1', {}, 'Immeubles'),
    h('section', { class: 'card' },
      h('h2', {}, 'Construire gratuitement'),
      h('p', { class: 'muted', style: { margin: 0 } }, "Construit instantanément un immeuble sur un terrain libre, y compris dans un quartier fermé. Pour un design complet (toit, couleurs, logo), utilisez « Ouvrir sur la carte » puis « Construire ici »."),
      h('div', { class: 'toolbar-row' },
        h('label', { class: 'field' }, h('span', {}, 'Terrain'), n),
        h('label', { class: 'field' }, h('span', {}, 'Forme'), shape),
        h('label', { class: 'field', style: { minWidth: '90px' } }, h('span', {}, 'Étages'), floors),
        h('label', { class: 'field' }, h('span', {}, 'Enseigne'), brand),
        h('label', { class: 'field' }, h('span', {}, 'Propriétaire'), owner),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const ok = await run(() => post('/checkout', { plot: Number(n.value), owner: owner.value || undefined, design: { ...DEFAULT_BUILDING, shape: shape.value, floors: Number(floors.value) }, branding: { brandName: brand.value } }), 'Immeuble construit 🏗️');
            if (ok) plots(status);
          },
        }, 'Construire'),
        h('a', { class: 'btn ghost', href: '/', onclick: (e) => { if (n.value) e.currentTarget.href = `/?plot=${n.value}&edit=1`; } }, 'Ouvrir sur la carte'))),
    h('div', { class: 'toolbar-row' }, h('label', { class: 'field' }, h('span', {}, 'Statut'), filter)),
    h('section', { class: 'card' }, table(
      ['#', 'Quartier', 'Enseigne', 'Propriétaire', 'Étages', 'Payé', 'Acquis le', ''],
      list.map((p) => h('tr', {},
        h('td', {}, h('a', { href: `/?plot=${p.number}` }, `#${p.number}`)),
        h('td', {}, p.district),
        h('td', {}, p.brand_name || '—'),
        h('td', {}, p.username || '—'),
        h('td', { class: 'num' }, p.floors ?? '—'),
        h('td', { class: 'num' }, money(p.price_paid_cents)),
        h('td', {}, date(p.purchased_at)),
        h('td', {}, h('div', { class: 'actions' },
          h('a', { class: 'btn small ghost', href: `/?plot=${p.number}${p.status === 'owned' ? '&edit=1' : ''}` }, p.status === 'owned' ? 'Modifier' : 'Voir'),
          p.status === 'owned' ? h('button', { class: 'btn small ghost', onclick: () => transfer(p.number, status) }, 'Réattribuer') : null,
          p.status !== 'free' ? h('button', { class: 'btn small danger', onclick: async () => confirm(`Démolir et remettre en vente le terrain #${p.number} ?`) && (await run(() => post(`/admin/plots/${p.number}/reset`), 'Terrain remis en vente.')) && plots(status) }, 'Démolir') : null)),
      )),
    )),
  );
}

function transfer(number, status) {
  openModal({
    title: `Réattribuer le terrain #${number}`,
    content: (body, close) => {
      const input = h('input', { placeholder: "Nom d'utilisateur" });
      body.append(h('label', { class: 'field' }, h('span', {}, 'Nouveau propriétaire'), input),
        h('button', { class: 'btn primary block', onclick: async () => { if (await run(() => post(`/buildings/${number}/transfer`, { username: input.value }), 'Terrain réattribué.')) { close(); plots(status); } } }, 'Réattribuer'));
    },
  });
}

// ------------------------------------------------------------------ panneaux
async function billboards() {
  const city = await get('/city');
  clear(
    main,
    h('h1', {}, 'Panneaux publicitaires'),
    h('p', { class: 'muted', style: { margin: 0 } }, "Pour afficher gratuitement une pub (campagne de la mairie, partenaire), ouvrez le panneau sur la carte puis « Afficher une pub »."),
    h('section', { class: 'card' }, table(
      ['#', 'Quartier', 'Statut', 'Marque', 'Annonceur', 'Fin', ''],
      city.billboards.map((b) => h('tr', {},
        h('td', {}, h('a', { href: `/?billboard=${b.number}` }, `#${b.number}`)),
        h('td', {}, b.district),
        h('td', {}, h('span', { class: `tag ${b.status === 'rented' ? 'admin' : b.status === 'reserved' ? 'warn' : ''}` }, { rented: 'Loué', reserved: 'Réservé', free: 'Libre' }[b.status])),
        h('td', {}, b.ad?.brandName || '—'),
        h('td', {}, b.renter || '—'),
        h('td', {}, b.rentedUntil ? date(b.rentedUntil) : '—'),
        h('td', {}, h('div', { class: 'actions' },
          h('a', { class: 'btn small ghost', href: `/?billboard=${b.number}` }, 'Ouvrir'),
          b.status !== 'free' ? h('button', { class: 'btn small danger', onclick: async () => confirm(`Libérer le panneau #${b.number} ?`) && (await run(() => post(`/admin/billboards/${b.number}/reset`), 'Panneau libéré.')) && billboards() }, 'Libérer') : null)),
      )),
    )),
  );
}

// ------------------------------------------------------------------ signalements
async function reports(status = 'open') {
  const { reports: list } = await get(`/admin/reports?status=${status}`);
  const filter = h('select', {}, [['open', 'Ouverts'], ['resolved', 'Traités'], ['dismissed', 'Rejetés']].map(([v, l]) => h('option', { value: v, selected: v === status }, l)));
  filter.addEventListener('change', () => reports(filter.value));
  const link = (r) => (r.target_type === 'billboard' ? `/?billboard=${r.target}` : `/?plot=${r.target}`);
  clear(
    main,
    h('h1', {}, 'Signalements'),
    h('div', { class: 'toolbar-row' }, h('label', { class: 'field' }, h('span', {}, 'Statut'), filter)),
    h('section', { class: 'card' }, table(
      ['Date', 'Cible', 'Raison', 'Signalé par', ''],
      list.map((r) => h('tr', {},
        h('td', {}, date(r.created_at)),
        h('td', {}, h('a', { href: link(r) }, `${r.target_type === 'billboard' ? 'Panneau' : 'Terrain'} #${r.target}`)),
        h('td', { style: { maxWidth: '420px', whiteSpace: 'pre-line' } }, r.reason),
        h('td', {}, r.reporter || '—'),
        h('td', {}, h('div', { class: 'actions' },
          r.target_type === 'plot' ? h('button', { class: 'btn small ghost', onclick: () => run(() => post(`/admin/plots/${r.target}/moderate`, { clearLogo: true, clearText: true }), 'Contenu effacé.') }, 'Effacer le contenu') : null,
          status !== 'resolved' ? h('button', { class: 'btn small', onclick: async () => (await run(() => patch(`/admin/reports/${r.id}`, { status: 'resolved' }))) && reports(status) }, 'Traité') : null,
          status !== 'dismissed' ? h('button', { class: 'btn small ghost', onclick: async () => (await run(() => patch(`/admin/reports/${r.id}`, { status: 'dismissed' }))) && reports(status) }, 'Rejeter') : null)),
      )),
    )),
  );
}

// ------------------------------------------------------------------ commandes
async function orders() {
  const { orders: list } = await get('/admin/orders');
  clear(
    main,
    h('h1', {}, 'Commandes'),
    h('section', { class: 'card' }, table(
      ['Date', 'Commande', 'Type', 'Cible', 'Client', 'Montant', 'Statut', 'Paiement'],
      list.map((o) => h('tr', {},
        h('td', {}, date(o.created_at)),
        h('td', {}, h('code', {}, o.id)),
        h('td', {}, { plot: 'Terrain', upgrade: 'Surélévation', billboard: 'Panneau' }[o.kind]),
        h('td', {}, h('a', { href: o.kind === 'billboard' ? `/?billboard=${o.target}` : `/?plot=${o.target}` }, `#${o.target}`)),
        h('td', {}, o.username || '—'),
        h('td', { class: 'num' }, money(o.amount_cents)),
        h('td', {}, h('span', { class: `tag ${o.status === 'paid' ? 'admin' : o.status === 'pending' ? 'warn' : ''}` }, { paid: 'Payée', pending: 'En attente', cancelled: 'Annulée', expired: 'Expirée' }[o.status]), o.conflict ? h('span', { class: 'tag banned' }, ' À rembourser') : null),
        h('td', {}, o.provider === 'stripe' && o.provider_ref ? h('code', { title: o.provider_ref }, o.provider_ref.slice(0, 14) + '…') : o.provider),
      )),
    )),
  );
}

// ------------------------------------------------------------------ réglages
async function settings() {
  const d = await get('/admin/overview');
  const perFloor = h('input', { type: 'number', min: 0, step: 1, value: d.pricing.pricePerFloorCents });
  const rows = d.districts.map((x) => {
    const unlock = h('select', {}, [['auto', `Automatique (${x.unlockAt} vendus)`], ['open', 'Ouvert'], ['closed', 'Fermé']].map(([v, l]) => h('option', { value: v, selected: (x.forced ? (x.unlocked ? 'open' : 'closed') : 'auto') === v }, l)));
    const base = h('input', { type: 'number', min: 50, value: x.basePriceCents, style: { width: '110px' } });
    const board = h('input', { type: 'number', min: 50, value: x.billboardMonthCents, style: { width: '110px' } });
    return { x, unlock, base, board };
  });
  clear(
    main,
    h('h1', {}, 'Réglages'),
    h('section', { class: 'card' },
      h('h2', {}, 'Prix'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Montants en centimes. Prix d\'un terrain = prix du quartier + étages × prix par étage.'),
      h('label', { class: 'field', style: { maxWidth: '240px' } }, h('span', {}, 'Prix par étage (centimes)'), perFloor),
      table(['Quartier', 'Ouverture', 'Terrain (centimes)', 'Panneau / mois (centimes)', 'Occupation'],
        rows.map(({ x, unlock, base, board }) => h('tr', {}, h('td', {}, x.name), h('td', {}, unlock), h('td', {}, base), h('td', {}, board), h('td', { class: 'num' }, `${x.owned}/${x.total}`)))),
      h('div', {}, h('button', {
        class: 'btn primary',
        onclick: () => run(async () => {
          const districts = Object.fromEntries(rows.map(({ x, unlock, base, board }) => [x.id, {
            unlocked: unlock.value === 'auto' ? null : unlock.value === 'open',
            basePriceCents: Number(base.value),
            billboardMonthCents: Number(board.value),
          }]));
          await api('/admin/settings', { method: 'PUT', body: { pricePerFloorCents: Number(perFloor.value), districts } });
        }, 'Réglages enregistrés.'),
      }, 'Enregistrer'))),
  );
}

// ------------------------------------------------------------------ démarrage
(async () => {
  let me;
  try {
    ({ user: me } = await get('/me'));
    currency = (await get('/city')).currency;
  } catch (e) {
    clear(main, h('div', { class: 'error-box' }, e.message));
    return;
  }
  if (!me || me.role !== 'admin') {
    clear(main, h('section', { class: 'card' }, h('h1', {}, 'Accès réservé'), h('p', { class: 'muted' }, "Cette page est réservée aux administrateurs. Connectez-vous depuis la ville avec un compte administrateur."), h('a', { class: 'btn primary', href: '/' }, 'Retour à la ville')));
    tabsEl.hidden = true;
    return;
  }
  go(location.hash.slice(1) || 'dashboard');
})();

// Classement et statistiques de la ville.

import { get } from '../api.js';
import { app } from '../app.js';
import { state, districtInfo } from '../state.js';
import { formatMoney } from '../shared/catalog.js';
import { h, clear, openModal, closeModal, formatNumber, avatar, timeAgo } from './dom.js';

export function openLeaderboard() {
  openModal({
    title: 'Classement',
    wide: true,
    content: async (body) => {
      const tabs = h('div', { class: 'tabs', role: 'tablist' });
      const pane = h('div', { class: 'list' }, h('p', { class: 'muted' }, 'Chargement…'));
      body.append(tabs, pane);
      let data;
      try {
        data = await get('/leaderboard');
      } catch (e) {
        clear(pane, h('p', { class: 'error-box' }, e.message));
        return;
      }
      const defs = [
        ['tallest', 'Plus hauts', (r) => `${r.value} étages`],
        ['liked', 'Plus aimés', (r) => `${formatNumber(r.value)} ❤`],
        ['visited', 'Plus visités (7 j)', (r) => `${formatNumber(r.value)} visites`],
        ['owners', 'Propriétaires', (r) => `${r.value} terrain${r.value > 1 ? 's' : ''}`],
        ['newest', 'Nouveaux', (r) => timeAgo(r.at)],
      ];
      const render = (id) => {
        clear(tabs, defs.map(([k, label]) => h('button', { class: `tab${k === id ? ' active' : ''}`, role: 'tab', 'aria-selected': String(k === id), onclick: () => render(k) }, label)));
        const [, , fmt] = defs.find((d) => d[0] === id);
        const rows = data[id];
        clear(
          pane,
          rows.length
            ? rows.map((r, i) => {
                if (id === 'owners') {
                  return h('button', { class: 'list-item', onclick: () => { closeModal(); app.openProfile(r.owner); } },
                    h('span', { class: 'rank' }, i + 1), avatar(r.owner),
                    h('span', { class: 'meta' }, h('strong', {}, r.owner), h('small', {}, `${formatNumber(r.floors)} étages au total`)),
                    h('span', { class: 'value' }, fmt(r)));
                }
                const d = districtInfo(r.district);
                return h('button', { class: 'list-item', onclick: () => { closeModal(); app.select({ type: 'plot', number: r.number }, { focus: true }); } },
                  h('span', { class: 'rank' }, i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1),
                  h('span', { class: 'meta' }, h('strong', {}, r.brandName || `Terrain #${r.number}`), h('small', {}, `${r.owner ?? '—'} · ${d?.name ?? ''} · #${r.number}`)),
                  h('span', { class: 'value' }, fmt(r)));
              })
            : h('p', { class: 'empty' }, 'Personne pour le moment… la place est à prendre !'),
        );
      };
      render('tallest');
    },
  });
}

export function openStats() {
  openModal({
    title: 'MyCity en chiffres',
    wide: true,
    content: async (body) => {
      let data;
      try {
        data = await get('/stats');
      } catch (e) {
        body.append(h('p', { class: 'error-box' }, e.message));
        return;
      }
      const s = data.stats;
      const tile = (label, value) => h('div', { class: 'stat' }, h('small', {}, label), h('strong', {}, value));
      body.append(
        h('div', { class: 'stat-grid' },
          tile('Habitants', formatNumber(s.inhabitants)),
          tile('Terrains construits', `${formatNumber(s.plotsOwned)} / ${formatNumber(s.plotsTotal)}`),
          tile('Propriétaires', formatNumber(s.owners)),
          tile('Étages bâtis', formatNumber(s.floors)),
          tile('Plus haut immeuble', `${s.tallest} ét.`),
          tile('Pubs affichées', `${s.billboardsRented} / ${s.billboardsTotal}`),
          tile('Citoyens inscrits', formatNumber(s.citizens)),
          tile('Visites (24 h)', formatNumber(s.visits24h)),
          tile('En ligne', formatNumber(s.online))),
        h('p', { class: 'section-title', style: { marginTop: '6px' } }, 'Occupation par quartier'),
        h('div', { class: 'bars', role: 'table', 'aria-label': 'Occupation par quartier' },
          data.districts.map((d) => {
            const pct = d.total ? (d.owned / d.total) * 100 : 0;
            return h('div', { class: 'bar-row', role: 'row', title: `${d.name} : ${d.owned} terrains construits sur ${d.total} (${pct.toFixed(1)} %) · terrain ${formatMoney(d.basePriceCents, state.currency)}` },
              h('span', { class: 'name', role: 'cell' }, h('i', { style: { background: d.color } }), d.name),
              h('span', { class: 'track', role: 'cell' }, h('span', { class: 'fill', style: { width: `${Math.max(pct, d.owned ? 1 : 0)}%`, background: d.color, display: 'block' } })),
              h('span', { class: 'v', role: 'cell' }, d.unlocked ? `${d.owned}/${d.total}` : h('span', { class: 'lock' }, `🔒 ${d.unlockAt}`)));
          })),
        h('p', { class: 'muted small', style: { margin: 0 } }, 'Les quartiers fermés ouvrent automatiquement quand la ville atteint le nombre de terrains vendus indiqué.'),
      );
    },
  });
}

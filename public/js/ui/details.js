// Panneaux de détail : terrain, panneau publicitaire, monument.

import { get, post, del } from '../api.js';
import { app } from '../app.js';
import { state, districtInfo, plotState } from '../state.js';
import { formatMoney, remainingLabel, SHAPES, ROOF_STYLES } from '../shared/catalog.js';
import { h, icon, toast, avatar, timeAgo, formatNumber, safeUrl, displayHost, clear, openModal } from './dom.js';
import { showPanel, closePanel, panelBody } from './panel.js';

const visited = new Set();
function recordVisit(type, number) {
  const key = `${type}:${number}`;
  if (visited.has(key)) return;
  visited.add(key);
  post('/visit', { type, number }).catch(() => {});
}

function districtChip(id) {
  const d = districtInfo(id);
  return h('span', { class: 'chip district' }, h('i', { style: { background: d?.color || '#999' } }), d?.name || '');
}

function shareLink(type, number) {
  const url = `${location.origin}/?${type}=${number}`;
  if (navigator.share) {
    navigator.share({ title: 'MyCity', url }).catch(() => {});
    return;
  }
  navigator.clipboard?.writeText(url).then(
    () => toast('Lien copié dans le presse-papiers.'),
    () => toast(url),
  );
}

export function reportDialog(type, target) {
  if (!app.requireAuth()) return;
  openModal({
    title: 'Signaler un contenu',
    content: (body, close) => {
      const reason = h('textarea', { maxlength: 300, placeholder: 'Contenu choquant, arnaque, usurpation de marque…', rows: 4 });
      const err = h('div', { class: 'error-box', hidden: true });
      body.append(
        h('p', { class: 'muted' }, "Notre équipe examinera votre signalement rapidement. Merci d'aider à garder MyCity agréable."),
        h('label', { class: 'field' }, h('span', {}, 'Raison'), reason),
        err,
        h('button', {
          class: 'btn primary block',
          onclick: async () => {
            try {
              await post('/reports', { type, target, reason: reason.value });
              toast('Merci, votre signalement a été transmis.');
              close();
            } catch (e) {
              err.hidden = false;
              err.textContent = e.message;
            }
          },
        }, 'Envoyer le signalement'),
      );
    },
  });
}

// ------------------------------------------------------------------ terrain
export async function showPlot(number) {
  const lot = state.city.lots[number - 1];
  if (!lot) return;
  recordVisit('plot', number);
  const base = plotState(number);
  // Affichage immédiat avec l'état connu, puis enrichissement.
  renderPlot(number, { plot: base, district: districtInfo(base.district), loading: true });
  try {
    const details = await get(`/plots/${number}`);
    if (state.selection?.type === 'plot' && state.selection.number === number && !state.draft) renderPlot(number, details);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function navFor(number) {
  const total = state.city.lots.length;
  return {
    onPrev: () => app.select({ type: 'plot', number: number > 1 ? number - 1 : total }, { focus: true }),
    onNext: () => app.select({ type: 'plot', number: number < total ? number + 1 : 1 }, { focus: true }),
  };
}

function renderPlot(number, d) {
  const plot = d.plot;
  const district = d.district || districtInfo(plot.district);
  const isAdmin = state.me?.role === 'admin';
  const nav = navFor(number);

  if (plot.status === 'owned' && plot.building) return renderOwned(number, d, nav, isAdmin);

  const body = [];
  const foot = [];
  const locked = !district?.unlocked;
  const floorsDefault = 4;
  const priceFrom = (district?.basePriceCents ?? 1000) + (state.pricing?.pricePerFloorCents ?? 100) * 1;

  if (plot.status === 'reserved') {
    body.push(
      h('div', { class: 'row' }, h('span', { class: 'chip reserved' }, d.reservedByMe ? 'Terrain tenu pour vous' : 'Terrain réservé'), districtChip(plot.district)),
      h(
        'p',
        { class: 'desc' },
        d.reservedByMe
          ? `Ce terrain vous est réservé pendant le paiement (${remainingLabel(plot.reservedUntil)}).`
          : `Quelqu'un est en train de finaliser son achat. S'il abandonne, le terrain sera libéré ${plot.reservedUntil ? `dans ${Math.max(1, Math.round((new Date(plot.reservedUntil) - Date.now()) / 60000))} min` : 'bientôt'}.`,
      ),
    );
    if (d.reservedByMe) {
      const pending = state.me?.pendingOrders?.find((o) => o.kind === 'plot' && o.target === number);
      if (pending) {
        foot.push(
          h('button', {
            class: 'btn ghost block',
            onclick: async () => {
              await post(`/checkout/${pending.id}/cancel`).catch((e) => toast(e.message, 'error'));
              await app.refreshMe();
              toast('Réservation annulée.');
            },
          }, 'Annuler ma réservation'),
        );
      }
      foot.push(h('button', { class: 'btn primary block', onclick: () => app.openEditor(number) }, 'Reprendre la personnalisation'));
    }
  } else {
    body.push(
      h('div', { class: 'row' }, h('span', { class: locked ? 'chip locked' : 'chip free' }, locked ? 'Quartier en travaux' : 'Terrain disponible'), districtChip(plot.district)),
      h('div', {}, h('p', { class: 'section-title' }, locked ? 'Bientôt disponible' : 'À partir de'), h('div', { class: 'price-big' }, formatMoney(priceFrom, state.currency))),
      h(
        'p',
        { class: 'desc' },
        locked
          ? `${district?.name} ouvrira quand ${district?.unlockAt} terrains auront trouvé preneur dans la ville (${state.stats?.plotsOwned ?? 0} aujourd'hui). ${district?.description ?? ''}`
          : `${district?.description ?? ''} Le prix comprend le terrain (${formatMoney(district?.basePriceCents ?? 0, state.currency)}) et ${formatMoney(state.pricing?.pricePerFloorCents ?? 100, state.currency)} par étage. À vous, définitivement.`,
      ),
      h(
        'div',
        { class: 'kv' },
        h('div', {}, h('small', {}, 'Terrain'), h('strong', {}, `#${number}`)),
        h('div', {}, h('small', {}, 'Coordonnées'), h('strong', {}, `${plot.x}·${plot.y}`)),
        h('div', {}, h('small', {}, 'Façade'), h('strong', {}, { S: 'Sud', E: 'Est', N: 'Nord', W: 'Ouest' }[plot.facing] || '—')),
      ),
    );
    if (!locked || isAdmin) {
      foot.push(
        h(
          'button',
          { class: 'btn primary block', onclick: () => (isAdmin || app.requireAuth()) && app.openEditor(number) },
          isAdmin ? 'Construire ici (administration, gratuit)' : 'Personnaliser mon immeuble',
        ),
      );
      if (!isAdmin) foot.push(h('p', { class: 'muted small', style: { margin: 0, textAlign: 'center' } }, `Design avant paiement · ${floorsDefault} étages par défaut`));
    }
  }

  showPanel({
    eyebrow: [h('span', {}, `Terrain #${number}`)],
    title: plot.status === 'reserved' ? 'Terrain réservé' : locked ? 'Bientôt constructible' : 'Terrain à vendre',
    body,
    foot,
    ...nav,
    onClose: ({ replaced } = {}) => !replaced && app.select(null),
  });
}

function renderOwned(number, d, nav, isAdmin) {
  const { plot } = d;
  const b = plot.building;
  const mine = d.mine;
  const canManage = mine || isAdmin;
  const shape = SHAPES.find((s) => s.id === b.shape)?.label ?? b.shape;
  const roof = ROOF_STYLES.find((s) => s.id === b.roofStyle)?.label ?? b.roofStyle;
  const website = safeUrl(b.website);

  let liked = d.liked;
  let likes = plot.likes;
  const likeBtn = h('button', { class: 'btn ghost', 'aria-pressed': String(liked) });
  const renderLike = () => clear(likeBtn, icon('heart'), ` ${liked ? 'Aimé' : "J'aime"} · ${likes}`);
  renderLike();
  likeBtn.style.color = liked ? '#ff9d92' : '';
  likeBtn.addEventListener('click', async () => {
    if (!app.requireAuth()) return;
    if (mine) return toast("Vous ne pouvez pas aimer votre propre immeuble 😉", 'warn');
    try {
      const res = await post(`/plots/${number}/like`, { like: !liked });
      liked = res.liked;
      likes = res.likes;
      likeBtn.style.color = liked ? '#ff9d92' : '';
      renderLike();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  const body = [
    h('div', { class: 'row' }, h('span', { class: 'chip owned' }, mine ? 'Votre immeuble' : 'Propriété privée'), districtChip(plot.district)),
    b.logo ? h('div', { class: 'upload' }, h('div', { class: 'thumb', style: { background: '#fff' } }, h('img', { src: b.logo, alt: `Logo ${b.brandName || ''}` })), b.description ? h('p', { class: 'desc' }, b.description) : null) : b.description ? h('p', { class: 'desc' }, b.description) : null,
    plot.owner
      ? h(
          'button',
          { class: 'list-item', onclick: () => app.openProfile(plot.owner) },
          avatar(plot.owner),
          h('span', { class: 'meta' }, h('strong', {}, plot.owner), h('small', {}, `Propriétaire depuis ${timeAgo(plot.purchasedAt)}`)),
          d.ownerBadges?.length ? h('span', { title: d.ownerBadges.map((x) => x.label).join(', ') }, d.ownerBadges.map((x) => x.icon).join(' ')) : null,
        )
      : null,
    h(
      'div',
      { class: 'kv' },
      h('div', {}, h('small', {}, 'Étages'), h('strong', {}, b.floors)),
      h('div', {}, h('small', {}, "J'aime"), h('strong', {}, formatNumber(likes))),
      h('div', {}, h('small', {}, 'Visites 24 h'), h('strong', {}, d.loading ? '…' : formatNumber(d.visits24h))),
    ),
    h('p', { class: 'muted small', style: { margin: 0 } }, `${shape} · ${roof} · terrain #${number}`),
    h('div', { class: 'row' }, likeBtn, h('button', { class: 'btn ghost', onclick: () => shareLink('plot', number) }, icon('share'), ' Partager')),
  ];

  // Livre d'or
  const list = h('div', { class: 'guestbook' });
  const renderGuestbook = (items) => {
    clear(
      list,
      items.length
        ? items.map((m) =>
            h(
              'div',
              { class: 'gb-item' },
              h(
                'header',
                {},
                h('strong', {}, m.author),
                h('span', {}, timeAgo(m.at)),
                state.me && (state.me.username === m.author || mine || isAdmin)
                  ? h('button', {
                      onclick: async () => {
                        await del(`/guestbook/${m.id}`).catch((e) => toast(e.message, 'error'));
                        renderGuestbook(items.filter((x) => x.id !== m.id));
                      },
                    }, 'Supprimer')
                  : null,
              ),
              h('p', {}, m.body),
            ),
          )
        : h('p', { class: 'muted small', style: { margin: 0 } }, 'Soyez le premier à laisser un mot !'),
    );
  };
  renderGuestbook(d.guestbook || []);
  const input = h('textarea', { rows: 2, maxlength: 280, placeholder: state.me ? 'Un mot pour le propriétaire…' : 'Connectez-vous pour écrire' });
  const sendBtn = h('button', {
    class: 'btn small',
    onclick: async () => {
      if (!app.requireAuth()) return;
      try {
        const { message } = await post(`/plots/${number}/guestbook`, { body: input.value });
        input.value = '';
        d.guestbook = [message, ...(d.guestbook || [])];
        renderGuestbook(d.guestbook);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  }, 'Publier');
  body.push(h('section', {}, h('p', { class: 'section-title' }, "Livre d'or"), list, h('div', { class: 'field', style: { marginTop: '8px' } }, input, h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, sendBtn))));

  if (canManage) {
    const tools = [
      h('button', { class: 'btn', onclick: () => app.openEditor(number) }, icon('edit'), mine ? ' Modifier mon immeuble' : ' Modifier (admin)'),
      h('button', { class: 'btn ghost', onclick: () => transferDialog(number) }, icon('gift'), isAdmin && !mine ? ' Changer de propriétaire' : ' Offrir'),
    ];
    const admin = isAdmin
      ? h(
          'div',
          { class: 'row' },
          b.logo ? h('button', { class: 'btn ghost small', onclick: () => moderate(number, { clearLogo: true }) }, 'Retirer le logo') : null,
          h('button', { class: 'btn ghost small', onclick: () => moderate(number, { clearText: true }) }, 'Effacer les textes'),
        )
      : null;
    body.push(
      h('section', {}, h('p', { class: 'section-title' }, isAdmin && !mine ? 'Administration' : 'Gestion'), h('div', { class: 'row' }, tools), admin),
      h('button', { class: 'btn danger block', onclick: () => demolish(number, b.brandName) }, icon('trash'), ' Démolir et remettre en vente'),
    );
  } else if (state.me) {
    body.push(h('button', { class: 'link small', style: { justifySelf: 'start' }, onclick: () => reportDialog('plot', number) }, 'Signaler cet immeuble'));
  }

  const foot = website
    ? [h('a', { class: 'btn primary block', href: website, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, icon('link'), ` Visiter ${displayHost(website)}`)]
    : [];

  showPanel({
    eyebrow: [h('span', {}, `Terrain #${number}`)],
    title: b.brandName || `Immeuble de ${plot.owner ?? 'la ville'}`,
    body,
    foot,
    ...nav,
    onClose: ({ replaced } = {}) => !replaced && app.select(null),
  });
}

async function moderate(number, body) {
  try {
    await post(`/admin/plots/${number}/moderate`, body);
    toast('Contenu modéré.');
    showPlot(number);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function demolish(number, name) {
  openModal({
    title: 'Démolir cet immeuble ?',
    content: (body, close) => {
      body.append(
        h('p', { class: 'muted' }, `${name ? `« ${name} »` : `L'immeuble du terrain #${number}`} sera démoli et le terrain remis en vente. Les « j'aime » et le livre d'or seront effacés. Cette action est définitive et ne donne lieu à aucun remboursement.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: close }, 'Annuler'),
          h('button', {
            class: 'btn danger',
            onclick: async () => {
              try {
                await del(`/buildings/${number}`);
                toast('Immeuble démoli.');
                close();
                await app.refreshMe();
                showPlot(number);
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          }, 'Démolir définitivement'),
        ),
      );
    },
  });
}

function transferDialog(number) {
  openModal({
    title: 'Offrir ce terrain',
    content: (body, close) => {
      const input = h('input', { placeholder: "Nom d'utilisateur du bénéficiaire", autocomplete: 'off' });
      const err = h('div', { class: 'error-box', hidden: true });
      body.append(
        h('p', { class: 'muted' }, "Le terrain et son immeuble seront transférés immédiatement et définitivement à cet habitant."),
        h('label', { class: 'field' }, h('span', {}, 'Bénéficiaire'), input),
        err,
        h('button', {
          class: 'btn primary block',
          onclick: async () => {
            try {
              await post(`/buildings/${number}/transfer`, { username: input.value });
              toast('Terrain transféré 🎁');
              close();
              await app.refreshMe();
              showPlot(number);
            } catch (e) {
              err.hidden = false;
              err.textContent = e.message;
            }
          },
        }, 'Transférer'),
      );
    },
  });
}

// ------------------------------------------------------------------ panneau publicitaire
export async function showBillboard(number) {
  recordVisit('billboard', number);
  let d;
  try {
    d = await get(`/billboards/${number}`);
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (state.selection?.type !== 'billboard' || state.selection.number !== number) return;
  const bb = d.billboard;
  const isAdmin = state.me?.role === 'admin';
  const locked = !d.district?.unlocked;
  const body = [];
  const foot = [];
  const rented = bb.status === 'rented';
  body.push(h('div', { class: 'row' }, h('span', { class: `chip ${rented ? 'owned' : bb.status === 'reserved' ? 'reserved' : locked ? 'locked' : 'free'}` }, rented ? 'Loué' : bb.status === 'reserved' ? 'Réservé' : locked ? 'Bientôt' : 'Disponible'), districtChip(bb.district)));

  if (rented) {
    const ad = bb.ad;
    body.push(
      h(
        'div',
        { class: 'preview', style: { height: '150px', background: ad.color } },
        ad.image ? h('img', { src: ad.image, alt: ad.brandName, style: { maxWidth: '90%', maxHeight: '120px', objectFit: 'contain' } }) : h('strong', { style: { fontFamily: 'var(--display)', fontSize: '26px', color: '#fff' } }, ad.brandName),
      ),
      ad.message ? h('p', { class: 'desc' }, `« ${ad.message} »`) : null,
      h(
        'div',
        { class: 'kv' },
        h('div', {}, h('small', {}, 'Panneau'), h('strong', {}, `#${number}`)),
        h('div', {}, h('small', {}, 'Visites 24 h'), h('strong', {}, formatNumber(d.visits24h))),
        h('div', {}, h('small', {}, 'Fin'), h('strong', { style: { fontSize: '14px' } }, remainingLabel(bb.rentedUntil))),
      ),
      bb.renter ? h('button', { class: 'list-item', onclick: () => app.openProfile(bb.renter) }, avatar(bb.renter), h('span', { class: 'meta' }, h('strong', {}, bb.renter), h('small', {}, 'Annonceur'))) : null,
    );
    const site = safeUrl(ad.website);
    if (site) foot.push(h('a', { class: 'btn primary block', href: site, target: '_blank', rel: 'noopener noreferrer nofollow sponsored' }, icon('link'), ` Voir le site ${displayHost(site)}`));
    if (d.mine || isAdmin) {
      body.push(
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => app.openBillboardEditor(number, d, 'edit') }, icon('edit'), ' Modifier la pub'),
          d.mine ? h('button', { class: 'btn ghost', onclick: () => app.openBillboardEditor(number, d, 'extend') }, 'Prolonger') : null,
        ),
        h('button', {
          class: 'btn danger block',
          onclick: async () => {
            if (!confirm('Libérer ce panneau ? La location en cours sera perdue.')) return;
            try {
              await del(`/billboards/${number}`);
              toast('Panneau libéré.');
              showBillboard(number);
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        }, 'Libérer ce panneau'),
      );
    } else if (state.me) {
      body.push(h('button', { class: 'link small', style: { justifySelf: 'start' }, onclick: () => reportDialog('billboard', number) }, 'Signaler cette publicité'));
    }
  } else {
    body.push(
      h('p', { class: 'desc' }, `Affichez votre marque en plein ${d.district.name} : ce panneau est vu par tous les visiteurs qui passent dans le quartier. Location mensuelle, sans engagement.`),
      h('div', { class: 'offers' }, d.offers.map((o) => h('div', { class: 'offer' }, h('strong', {}, `${o.months} mois`), h('span', {}, formatMoney(o.priceCents, state.currency)), o.discount ? h('span', { class: 'save' }, `−${o.discount} %`) : h('small', { class: 'muted' }, 'sans engagement')))),
    );
    if (bb.status === 'free' && (!locked || isAdmin)) {
      foot.push(h('button', { class: 'btn primary block', onclick: () => (isAdmin || app.requireAuth()) && app.openBillboardEditor(number, d, 'rent') }, isAdmin ? 'Afficher une pub (administration, gratuit)' : `Louer · dès ${formatMoney(d.offers[0].priceCents, state.currency)}`));
    }
  }
  const total = state.city.billboards.length;
  showPanel({
    eyebrow: [h('span', {}, `Panneau #${number}`)],
    title: rented ? bb.ad.brandName || `Pub #${number}` : `Panneau #${number}`,
    body,
    foot,
    onPrev: () => app.select({ type: 'billboard', number: number > 1 ? number - 1 : total }, { focus: true }),
    onNext: () => app.select({ type: 'billboard', number: number < total ? number + 1 : 1 }, { focus: true }),
    onClose: ({ replaced } = {}) => !replaced && app.select(null),
  });
}

// ------------------------------------------------------------------ monument
export function showLandmark(lm) {
  const d = districtInfo(lm.district);
  showPanel({
    eyebrow: [h('span', {}, lm.id === 'park' ? 'Espace vert' : 'Monument')],
    title: lm.name,
    body: [
      h('div', { class: 'row' }, districtChip(lm.district)),
      h('p', { class: 'desc' }, lm.blurb),
      h('p', { class: 'muted small' }, `Les monuments appartiennent à la ville et ne sont pas à vendre. Les terrains autour de ${lm.name} font partie des plus recherchés de ${d?.name ?? 'MyCity'}.`),
    ],
    onClose: ({ replaced } = {}) => !replaced && app.select(null),
  });
}

export function refreshOpenPanel() {
  const sel = state.selection;
  if (!sel || !panelBody()) return;
  if (sel.type === 'plot' && !state.draft) showPlot(sel.number);
  if (sel.type === 'billboard') showBillboard(sel.number);
}

export { closePanel };

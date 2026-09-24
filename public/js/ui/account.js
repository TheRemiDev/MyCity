// Comptes : connexion, inscription, configuration initiale, espace personnel, profils publics.

import { get, post, patch, del } from '../api.js';
import { app } from '../app.js';
import { state } from '../state.js';
import { formatMoney } from '../shared/catalog.js';
import { h, icon, toast, clear, openModal, closeModal, avatar, timeAgo, formatNumber } from './dom.js';
import { showPanel } from './panel.js';

// ------------------------------------------------------------------ barre du haut
export function renderAccountSlot() {
  const slot = document.getElementById('account-slot');
  if (!state.me) {
    clear(
      slot,
      h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '6px' } },
        h('button', { class: 'btn ghost hide-xs', onclick: () => openAuth('login') }, 'Se connecter'),
        h('button', { class: 'btn primary hide-sm', onclick: () => openAuth('register') }, 'Créer un compte')),
    );
    return;
  }
  const av = avatar(state.me.username, 'avatar');
  const button = h('button', { class: 'btn ghost icon-only', style: { padding: '2px', borderColor: 'transparent' }, 'aria-label': 'Mon compte', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, av);
  clear(slot, button);
}

let menuEl = null;
function toggleMenu() {
  if (menuEl) return closeMenu();
  const me = state.me;
  menuEl = h(
    'div',
    { class: 'menu', role: 'menu' },
    h('div', { class: 'who' }, `Connecté en tant que ${me.username}${me.role === 'admin' ? ' · administrateur' : ''}`),
    h('button', { role: 'menuitem', onclick: () => { closeMenu(); openProfile(me.username); } }, icon('user'), 'Mon profil public'),
    h('button', { role: 'menuitem', onclick: () => { closeMenu(); openAccount(); } }, icon('pin'), `Mes biens (${me.plots.length + me.billboards.length})`),
    h('button', { role: 'menuitem', onclick: () => { closeMenu(); openAccount('settings'); } }, icon('edit'), 'Paramètres du compte'),
    me.role === 'admin' ? h('a', { role: 'menuitem', href: '/admin' }, icon('crown'), 'Administration') : null,
    h('hr'),
    h('button', { role: 'menuitem', class: 'show-sm', onclick: () => { closeMenu(); app.openLeaderboard(); } }, 'Classement'),
    h('button', { role: 'menuitem', class: 'show-sm', onclick: () => { closeMenu(); app.openStats(); } }, 'Statistiques'),
    h('button', {
      role: 'menuitem',
      onclick: async () => {
        closeMenu();
        await post('/auth/logout');
        state.me = null;
        renderAccountSlot();
        toast('À bientôt dans MyCity !');
        app.onAuthChange?.();
      },
    }, 'Se déconnecter'),
  );
  document.body.append(menuEl);
  setTimeout(() => document.addEventListener('click', outside), 0);
}
function outside(e) {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  document.removeEventListener('click', outside);
}

// Menu mobile (visiteur non connecté ou connecté)
export function openMobileMenu() {
  if (state.me) return toggleMenu();
  menuEl?.remove();
  menuEl = h(
    'div',
    { class: 'menu', role: 'menu' },
    h('button', { onclick: () => { closeMenu(); app.openLeaderboard(); } }, 'Classement'),
    h('button', { onclick: () => { closeMenu(); app.openStats(); } }, 'Statistiques'),
    h('hr'),
    h('button', { onclick: () => { closeMenu(); openAuth('register'); } }, 'Créer un compte'),
    h('button', { onclick: () => { closeMenu(); openAuth('login'); } }, 'Se connecter'),
  );
  document.body.append(menuEl);
  setTimeout(() => document.addEventListener('click', outside), 0);
}

// ------------------------------------------------------------------ authentification
export function openAuth(mode = 'login') {
  openModal({
    title: mode === 'login' ? 'Se connecter' : 'Rejoindre MyCity',
    content: (body, close) => {
      const err = h('div', { class: 'error-box', hidden: true });
      const fields = {};
      const input = (name, label, attrs) => {
        fields[name] = h('input', { name, ...attrs });
        return h('label', { class: 'field' }, h('span', {}, label), fields[name]);
      };
      const terms = h('input', { type: 'checkbox' });
      const submit = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? 'Se connecter' : 'Créer mon compte');
      const form = h(
        'form',
        { style: { display: 'grid', gap: '12px' }, novalidate: true },
        mode === 'register' ? input('username', "Nom d'utilisateur", { autocomplete: 'username', required: true, minlength: 3, maxlength: 20, placeholder: 'ex. marie_dupont' }) : null,
        mode === 'register'
          ? input('email', 'E-mail', { type: 'email', autocomplete: 'email', required: true })
          : input('login', "E-mail ou nom d'utilisateur", { autocomplete: 'username', required: true }),
        input('password', 'Mot de passe', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: 8 }),
        mode === 'register'
          ? h('label', { class: 'checkbox' }, terms, h('span', {}, "J'accepte les ", h('a', { href: '/conditions', target: '_blank' }, 'conditions'), ' et la ', h('a', { href: '/confidentialite', target: '_blank' }, 'politique de confidentialité'), '.'))
          : null,
        err,
        submit,
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.hidden = true;
        submit.disabled = true;
        try {
          const payload = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
          if (mode === 'register') payload.acceptTerms = terms.checked;
          const res = await post(mode === 'login' ? '/auth/login' : '/auth/register', payload);
          state.me = res.user;
          renderAccountSlot();
          close();
          toast(mode === 'login' ? `Bon retour, ${res.user.username} !` : `Bienvenue dans MyCity, ${res.user.username} ! 🏙️`);
          app.onAuthChange?.();
        } catch (e2) {
          err.hidden = false;
          err.textContent = e2.message;
        } finally {
          submit.disabled = false;
        }
      });
      body.append(
        form,
        h('p', { class: 'muted small', style: { margin: 0, textAlign: 'center' } },
          mode === 'login' ? 'Pas encore de compte ? ' : 'Déjà un compte ? ',
          h('button', { class: 'link', onclick: () => openAuth(mode === 'login' ? 'register' : 'login') }, mode === 'login' ? 'Créer un compte' : 'Se connecter')),
      );
    },
  });
}

// Premier accès : création du compte administrateur.
export function openSetup({ tokenRequired }) {
  const token = new URLSearchParams(location.search).get('setup') || '';
  openModal({
    title: 'Bienvenue, Monsieur le Maire',
    content: (body, close) => {
      const err = h('div', { class: 'error-box', hidden: true });
      const f = {
        username: h('input', { autocomplete: 'username', placeholder: 'admin', maxlength: 20 }),
        email: h('input', { type: 'email', autocomplete: 'email' }),
        password: h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 }),
        token: h('input', { autocomplete: 'off', value: token }),
      };
      const submit = h('button', { class: 'btn primary block', type: 'submit' }, "Créer le compte administrateur");
      const form = h(
        'form',
        { style: { display: 'grid', gap: '12px' } },
        h('p', { class: 'muted', style: { margin: 0 } }, "MyCity vient d'être installée. Créez le compte administrateur : il pourra construire, modifier et démolir tous les bâtiments gratuitement, gérer les habitants, les prix et les quartiers."),
        h('label', { class: 'field' }, h('span', {}, "Nom d'utilisateur"), f.username),
        h('label', { class: 'field' }, h('span', {}, 'E-mail'), f.email),
        h('label', { class: 'field' }, h('span', {}, 'Mot de passe (8 caractères min.)'), f.password),
        tokenRequired ? h('label', { class: 'field' }, h('span', {}, "Code d'installation"), f.token, h('small', { class: 'muted' }, "Affiché à la fin du script d'installation (fichier /etc/mycity/mycity.env).")) : null,
        err,
        submit,
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submit.disabled = true;
        err.hidden = true;
        try {
          const res = await post('/setup', { username: f.username.value, email: f.email.value, password: f.password.value, token: f.token.value });
          state.me = res.user;
          renderAccountSlot();
          history.replaceState(null, '', location.pathname);
          close();
          toast('Votre ville est prête. Bonne construction ! 🏗️');
          app.onAuthChange?.();
        } catch (e2) {
          err.hidden = false;
          err.textContent = e2.message;
        } finally {
          submit.disabled = false;
        }
      });
      body.append(form);
    },
  });
}

// ------------------------------------------------------------------ espace personnel
export function openAccount(tab = 'assets') {
  if (!app.requireAuth()) return;
  openModal({
    title: 'Mon compte',
    wide: true,
    content: (body) => {
      const tabs = h('div', { class: 'tabs', role: 'tablist' });
      const pane = h('div', { style: { display: 'grid', gap: '14px' } });
      const defs = [
        ['assets', 'Mes biens'],
        ['settings', 'Profil & sécurité'],
        ['data', 'Mes données'],
      ];
      const render = (id) => {
        clear(tabs, defs.map(([k, label]) => h('button', { class: `tab${k === id ? ' active' : ''}`, role: 'tab', 'aria-selected': String(k === id), onclick: () => render(k) }, label)));
        clear(pane, id === 'assets' ? assetsPane() : id === 'settings' ? settingsPane() : dataPane());
      };
      body.append(tabs, pane);
      render(tab);
    },
  });
}

function assetsPane() {
  const me = state.me;
  const out = [];
  if (me.badges?.length) out.push(h('div', { class: 'badges' }, me.badges.map((b) => h('span', { class: 'badge', title: b.hint }, `${b.icon} ${b.label}`))));
  out.push(h('p', { class: 'section-title' }, `Mes immeubles (${me.plots.length})`));
  out.push(
    me.plots.length
      ? h('div', { class: 'list' }, me.plots.map((p) =>
          h('button', { class: 'list-item', onclick: () => { closeModal(); app.select({ type: 'plot', number: p.number }, { focus: true }); } },
            h('span', { class: 'rank' }, `#${p.number}`),
            h('span', { class: 'meta' }, h('strong', {}, p.building?.brandName || `Terrain #${p.number}`), h('small', {}, `${p.building?.floors} étages · ${p.likes} j'aime`)),
          )))
      : h('div', {}, h('p', { class: 'muted' }, "Vous n'avez pas encore de terrain."), h('button', { class: 'btn primary', onclick: () => { closeModal(); app.claimRandom(); } }, 'Trouver un terrain')),
  );
  out.push(h('p', { class: 'section-title' }, `Mes panneaux publicitaires (${me.billboards.length})`));
  out.push(
    me.billboards.length
      ? h('div', { class: 'list' }, me.billboards.map((b) =>
          h('button', { class: 'list-item', onclick: () => { closeModal(); app.select({ type: 'billboard', number: b.number }, { focus: true }); } },
            h('span', { class: 'rank' }, `#${b.number}`),
            h('span', { class: 'meta' }, h('strong', {}, b.ad?.brandName || `Panneau #${b.number}`), h('small', {}, `Jusqu'au ${new Date(b.rentedUntil).toLocaleDateString('fr-FR')}`)),
          )))
      : h('p', { class: 'muted' }, 'Aucune location en cours.'),
  );
  if (me.pendingOrders?.length) {
    out.push(h('p', { class: 'section-title' }, 'Paiements en attente'));
    out.push(h('div', { class: 'list' }, me.pendingOrders.map((o) =>
      h('div', { class: 'list-item' },
        h('span', { class: 'meta' }, h('strong', {}, `${o.kind === 'billboard' ? 'Panneau' : 'Terrain'} #${o.target}`), h('small', {}, `${formatMoney(o.amountCents, state.currency)} · ${timeAgo(o.createdAt)}`)),
        h('button', { class: 'btn ghost small', onclick: async (e) => { await post(`/checkout/${o.id}/cancel`).catch(() => {}); await app.refreshMe(); e.target.closest('.list-item').remove(); toast('Commande annulée.'); } }, 'Annuler'),
      ))));
  }
  return out;
}

function settingsPane() {
  const bio = h('textarea', { maxlength: 200, rows: 3, placeholder: 'Quelques mots sur vous, visibles sur votre profil public.' });
  bio.value = state.me.bio || '';
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  return [
    h('label', { class: 'field' }, h('span', {}, 'Bio'), bio),
    h('button', { class: 'btn', style: { justifySelf: 'start' }, onclick: async () => { try { const r = await patch('/me', { bio: bio.value }); state.me = r.user; toast('Profil mis à jour.'); } catch (e) { toast(e.message, 'error'); } } }, 'Enregistrer la bio'),
    h('p', { class: 'section-title', style: { marginTop: '10px' } }, 'Changer de mot de passe'),
    h('label', { class: 'field' }, h('span', {}, 'Mot de passe actuel'), cur),
    h('label', { class: 'field' }, h('span', {}, 'Nouveau mot de passe'), next),
    h('button', { class: 'btn', style: { justifySelf: 'start' }, onclick: async () => { try { await post('/me/password', { current: cur.value, next: next.value }); cur.value = ''; next.value = ''; toast('Mot de passe modifié. Vos autres sessions ont été déconnectées.'); } catch (e) { toast(e.message, 'error'); } } }, 'Changer le mot de passe'),
    h('p', { class: 'muted small' }, `Compte créé le ${new Date(state.me.createdAt).toLocaleDateString('fr-FR')} · ${state.me.email}`),
  ];
}

function dataPane() {
  const pwd = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Confirmez avec votre mot de passe' });
  return [
    h('p', { class: 'muted' }, 'Conformément au RGPD, vous pouvez télécharger toutes vos données ou supprimer votre compte.'),
    h('a', { class: 'btn', href: '/api/me/export', download: true, style: { justifySelf: 'start' } }, 'Télécharger mes données (JSON)'),
    h('p', { class: 'section-title', style: { marginTop: '10px' } }, 'Supprimer mon compte'),
    h('p', { class: 'muted small' }, 'Vos immeubles seront démolis et vos terrains et panneaux remis en vente. Action irréversible, sans remboursement.'),
    pwd,
    h('button', {
      class: 'btn danger',
      style: { justifySelf: 'start' },
      onclick: async () => {
        if (!confirm('Supprimer définitivement votre compte ?')) return;
        try {
          await del('/me', { password: pwd.value });
          state.me = null;
          closeModal();
          renderAccountSlot();
          toast('Votre compte a été supprimé.');
          app.onAuthChange?.();
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    }, 'Supprimer mon compte'),
  ];
}

// ------------------------------------------------------------------ profil public
export async function openProfile(username) {
  let p;
  try {
    ({ profile: p } = await get(`/users/${encodeURIComponent(username)}`));
  } catch (e) {
    return toast(e.message, 'error');
  }
  app.select(null, { keepPanel: true });
  showPanel({
    eyebrow: [h('span', {}, p.role === 'admin' ? 'Mairie · administrateur' : 'Habitant')],
    title: p.username,
    body: [
      h('div', { class: 'owner-line' }, avatar(p.username), h('span', { class: 'muted' }, `Membre ${timeAgo(p.memberSince).replace('il y a', 'depuis')}`)),
      p.bio ? h('p', { class: 'desc' }, p.bio) : null,
      p.badges.length ? h('div', { class: 'badges' }, p.badges.map((b) => h('span', { class: 'badge', title: b.hint }, `${b.icon} ${b.label}`))) : null,
      h('div', { class: 'kv' },
        h('div', {}, h('small', {}, 'Immeubles'), h('strong', {}, p.plots.length)),
        h('div', {}, h('small', {}, 'Étages'), h('strong', {}, formatNumber(p.floors))),
        h('div', {}, h('small', {}, "J'aime reçus"), h('strong', {}, formatNumber(p.likesReceived)))),
      p.plots.length ? h('p', { class: 'section-title' }, 'Ses immeubles') : null,
      h('div', { class: 'list' }, p.plots.map((pl) =>
        h('button', { class: 'list-item', onclick: () => app.select({ type: 'plot', number: pl.number }, { focus: true }) },
          h('span', { class: 'rank' }, `#${pl.number}`),
          h('span', { class: 'meta' }, h('strong', {}, pl.building?.brandName || `Terrain #${pl.number}`), h('small', {}, `${pl.building?.floors} étages`))))),
      p.billboards.length ? h('p', { class: 'section-title' }, 'Ses publicités') : null,
      h('div', { class: 'list' }, p.billboards.map((b) =>
        h('button', { class: 'list-item', onclick: () => app.select({ type: 'billboard', number: b.number }, { focus: true }) },
          h('span', { class: 'rank' }, `#${b.number}`),
          h('span', { class: 'meta' }, h('strong', {}, b.ad?.brandName || `Panneau #${b.number}`))))),
    ],
  });
  history.replaceState(null, '', `/?user=${encodeURIComponent(p.username)}`);
}

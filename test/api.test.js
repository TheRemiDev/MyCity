import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Petit client HTTP avec gestion des cookies (un « navigateur » par utilisateur).
function client(base) {
  let cookies = {};
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}

function start(env = {}, opts = {}) {
  const config = loadConfig({ DB_PATH: ':memory:', DISABLE_RATE_LIMIT: '1', PORT: '0', ...env });
  const instance = createApp(config, { logger: { error() {} }, ...opts });
  return new Promise((resolve) => {
    const server = instance.app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      config.baseUrl = base;
      resolve({ base, server, instance, config });
    });
  });
}

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('MyCity API (mode démo)', () => {
  let ctx;
  let admin;
  let alice;
  let bob;
  before(async () => {
    ctx = await start({ SETUP_TOKEN: 'secret-setup' });
    admin = client(ctx.base);
    alice = client(ctx.base);
    bob = client(ctx.base);
  });
  after(() => {
    ctx.server.closeAllConnections();
    ctx.server.close();
    ctx.instance.close();
  });

  test("l'inscription est fermée tant que l'admin n'est pas créé", async () => {
    const setup = await alice('GET', '/api/setup');
    assert.deepEqual(setup.data, { needed: true, tokenRequired: true });
    const r = await alice('POST', '/api/auth/register', { email: 'a@x.fr', username: 'alice', password: 'motdepasse', acceptTerms: true });
    assert.equal(r.status, 503);
  });

  test('configuration initiale : code requis, puis compte admin', async () => {
    const bad = await admin('POST', '/api/setup', { email: 'maire@x.fr', username: 'maire', password: 'motdepasse', token: 'nope' });
    assert.equal(bad.status, 403);
    const ok = await admin('POST', '/api/setup', { email: 'maire@x.fr', username: 'maire', password: 'motdepasse', token: 'secret-setup' });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.user.role, 'admin');
    const again = await bob('POST', '/api/setup', { email: 'b@x.fr', username: 'bob', password: 'motdepasse', token: 'secret-setup' });
    assert.equal(again.status, 409);
  });

  test('inscription et connexion', async () => {
    const r = await alice('POST', '/api/auth/register', { email: 'alice@x.fr', username: 'alice', password: 'motdepasse', acceptTerms: true });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.role, 'user');
    const dup = await bob('POST', '/api/auth/register', { email: 'alice@x.fr', username: 'bobby', password: 'motdepasse', acceptTerms: true });
    assert.equal(dup.status, 409);
    const b = await bob('POST', '/api/auth/register', { email: 'bob@x.fr', username: 'bob', password: 'motdepasse', acceptTerms: true });
    assert.equal(b.status, 201);
    const wrong = await client(ctx.base)('POST', '/api/auth/login', { login: 'alice', password: 'mauvais-mdp' });
    assert.equal(wrong.status, 401);
    const good = await client(ctx.base)('POST', '/api/auth/login', { login: 'alice@x.fr', password: 'motdepasse' });
    assert.equal(good.status, 200);
  });

  test('achat d\'un terrain en mode démo', async () => {
    const r = await alice('POST', '/api/checkout', {
      plot: 1,
      design: { floors: 12, shape: 'tower', roofStyle: 'spire', windows: 'glass', color: '#123456' },
      branding: { brandName: 'Alice Studio', website: 'alice.fr', logo: PNG_1PX },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.demo, true);
    const d = await bob('GET', '/api/plots/1');
    assert.equal(d.data.plot.owner, 'alice');
    assert.equal(d.data.plot.building.floors, 12);
    assert.equal(d.data.plot.building.website, 'https://alice.fr/');
    assert.match(d.data.plot.building.logo, /^\/api\/media\/plot\/1/);
    const media = await fetch(ctx.base + d.data.plot.building.logo);
    assert.equal(media.headers.get('content-type'), 'image/png');
    // déjà vendu
    const again = await bob('POST', '/api/checkout', { plot: 1, design: {} });
    assert.equal(again.status, 409);
  });

  test('validation : étages, forme, image, lien', async () => {
    const tooHigh = await bob('POST', '/api/checkout', { plot: 2, design: { floors: 10, shape: 'house' } });
    assert.equal(tooHigh.status, 400);
    const svg = await bob('POST', '/api/checkout', { plot: 2, design: {}, branding: { logo: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64') } });
    assert.equal(svg.status, 400);
    const js = await bob('POST', '/api/checkout', { plot: 2, design: {}, branding: { website: 'javascript:alert(1)' } });
    assert.equal(js.status, 400);
    const plot = await bob('GET', '/api/plots/2');
    assert.equal(plot.data.plot.status, 'free', 'une requête invalide ne doit rien réserver');
  });

  test('quartier fermé : refus pour un habitant, construction libre pour l\'admin', async () => {
    const city = await bob('GET', '/api/city');
    const locked = city.data.districts.find((d) => !d.unlocked);
    assert.ok(locked);
    const n = (await bob('GET', `/api/search?q=`)).data; // simple appel de santé
    assert.ok(n);
    const { lots } = (await import('../public/js/shared/citygen.js')).generateCity(ctx.config.citySeed);
    const lot = lots.find((l) => l.district === locked.id);
    const r = await bob('POST', '/api/checkout', { plot: lot.number, design: {} });
    assert.equal(r.status, 400);
    const a = await admin('POST', '/api/checkout', { plot: lot.number, design: { floors: 30, shape: 'classic' }, owner: 'bob' });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(a.data.admin, true);
    const p = await bob('GET', `/api/plots/${lot.number}`);
    assert.equal(p.data.plot.owner, 'bob');
    assert.equal(p.data.mine, true);
  });

  test("modification : gratuite pour l'esthétique, payante pour les étages (démo = immédiat)", async () => {
    const r = await alice('PATCH', '/api/buildings/1', { design: { color: '#ff0000', floors: 20 }, branding: { description: 'Nouveau' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.payment.fulfilled, true);
    const p = await alice('GET', '/api/plots/1');
    assert.equal(p.data.plot.building.floors, 20);
    assert.equal(p.data.plot.building.color, '#ff0000');
    const forbidden = await bob('PATCH', '/api/buildings/1', { design: { color: '#000000' } });
    assert.equal(forbidden.status, 403);
  });

  test("l'admin modifie et surélève n'importe quel immeuble gratuitement", async () => {
    const r = await admin('PATCH', '/api/buildings/1', { design: { floors: 55 }, branding: { brandName: 'Modéré' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.payment, undefined);
    assert.equal(r.data.plot.building.floors, 55);
    const orders = await admin('GET', '/api/admin/orders');
    assert.ok(orders.data.orders.every((o) => !(o.kind === 'upgrade' && o.username === 'maire')));
  });

  test('social : j\'aime, livre d\'or, visites, signalement', async () => {
    const self = await alice('POST', '/api/plots/1/like', { like: true });
    assert.equal(self.status, 400);
    const like = await bob('POST', '/api/plots/1/like', { like: true });
    assert.equal(like.data.likes, 1);
    const gb = await bob('POST', '/api/plots/1/guestbook', { body: 'Bravo  !\u0000' });
    assert.equal(gb.status, 201);
    assert.equal(gb.data.message.body, 'Bravo !');
    const del = await alice('DELETE', `/api/guestbook/${gb.data.message.id}`);
    assert.equal(del.status, 200, 'le propriétaire peut modérer son livre d\'or');
    const v = await bob('POST', '/api/visit', { type: 'plot', number: 1 });
    assert.equal(v.data.visits24h, 1);
    const rep = await bob('POST', '/api/reports', { type: 'plot', target: 1, reason: 'Contenu douteux' });
    assert.equal(rep.status, 201);
    const reports = await admin('GET', '/api/admin/reports');
    assert.equal(reports.data.reports.length, 1);
  });

  test('panneaux publicitaires', async () => {
    const r = await bob('POST', '/api/billboards/checkout', { billboard: 1, months: 3, content: { brandName: 'Bob Bikes', message: 'Promo' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const d = await alice('GET', '/api/billboards/1');
    assert.equal(d.data.billboard.renter, 'bob');
    assert.ok(new Date(d.data.billboard.rentedUntil) > Date.now() + 80 * 86400_000);
    const taken = await alice('POST', '/api/billboards/checkout', { billboard: 1, months: 1, content: { brandName: 'X' } });
    assert.equal(taken.status, 409);
    const badMonths = await alice('POST', '/api/billboards/checkout', { billboard: 2, months: 2, content: { brandName: 'X' } });
    assert.equal(badMonths.status, 400);
  });

  test('transfert puis démolition', async () => {
    const t = await alice('POST', '/api/buildings/1/transfer', { username: 'bob' });
    assert.equal(t.status, 200);
    assert.equal(t.data.plot.owner, 'bob');
    const d = await bob('DELETE', '/api/buildings/1');
    assert.equal(d.status, 200);
    const p = await bob('GET', '/api/plots/1');
    assert.equal(p.data.plot.status, 'free');
  });

  test('sécurité : admin réservé, requêtes inter-sites refusées, en-têtes', async () => {
    assert.equal((await bob('GET', '/api/admin/overview')).status, 403);
    assert.equal((await client(ctx.base)('GET', '/api/admin/overview')).status, 401);
    const csrf = await bob('POST', '/api/plots/3/like', { like: true }, { origin: 'https://evil.example' });
    assert.equal(csrf.status, 403);
    const res = await fetch(ctx.base + '/');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  test('réglages admin : prix et ouverture forcée de quartier', async () => {
    const r = await admin('PUT', '/api/admin/settings', { pricePerFloorCents: 250, districts: { nord: { unlocked: true, basePriceCents: 500 } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const city = await bob('GET', '/api/city');
    assert.equal(city.data.pricing.pricePerFloorCents, 250);
    const nord = city.data.districts.find((d) => d.id === 'nord');
    assert.equal(nord.unlocked, true);
    assert.equal(nord.basePriceCents, 500);
  });

  test('RGPD : export puis suppression du compte', async () => {
    const exp = await bob('GET', '/api/me/export');
    assert.equal(exp.data.account.username, 'bob');
    const bad = await bob('DELETE', '/api/me', { password: 'faux' });
    assert.equal(bad.status, 401);
    const ok = await bob('DELETE', '/api/me', { password: 'motdepasse' });
    assert.equal(ok.status, 200);
    const b = await alice('GET', '/api/billboards/1');
    assert.equal(b.data.billboard.status, 'free', 'les biens sont remis en vente');
  });
});

describe('Paiements Stripe (simulés)', () => {
  let ctx;
  let user;
  const sessions = new Map();
  const fakeFetch = async (url, init) => {
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
      const params = new URLSearchParams(init.body);
      const id = `cs_test_${sessions.size + 1}`;
      sessions.set(id, { id, client_reference_id: params.get('client_reference_id'), payment_status: 'unpaid', url: `https://checkout.stripe.com/${id}`, amount: Number(params.get('line_items[0][price_data][unit_amount]')) });
      return new Response(JSON.stringify(sessions.get(id)), { status: 200 });
    }
    const id = u.pathname.split('/').pop();
    return new Response(JSON.stringify(sessions.get(id)), { status: 200 });
  };

  before(async () => {
    ctx = await start({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' }, { fetchImpl: fakeFetch });
    const admin = client(ctx.base);
    await admin('POST', '/api/setup', { email: 'm@x.fr', username: 'maire', password: 'motdepasse' });
    user = client(ctx.base);
    await user('POST', '/api/auth/register', { email: 'u@x.fr', username: 'user1', password: 'motdepasse', acceptTerms: true });
  });
  after(() => {
    ctx.server.closeAllConnections();
    ctx.server.close();
    ctx.instance.close();
  });

  test('réservation, redirection Stripe, puis webhook signé', async () => {
    const r = await user('POST', '/api/checkout', { plot: 5, design: { floors: 3 } });
    assert.equal(r.status, 200);
    assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com\//);
    const [session] = [...sessions.values()];
    assert.equal(session.amount, 2900 + 3 * 100);
    let p = await user('GET', '/api/plots/5');
    assert.equal(p.data.plot.status, 'reserved');
    assert.equal(p.data.reservedByMe, true);

    // webhook mal signé
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'paid' } } });
    const bad = await fetch(`${ctx.base}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body });
    assert.equal(bad.status, 400);

    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    const ok = await fetch(`${ctx.base}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body });
    assert.equal(ok.status, 200);
    p = await user('GET', '/api/plots/5');
    assert.equal(p.data.plot.owner, 'user1');

    // Le retour navigateur est idempotent
    session.payment_status = 'paid';
    const confirm = await user('GET', `/api/checkout/confirm?session_id=${session.id}`);
    assert.equal(confirm.data.paid, true);
    assert.equal(confirm.data.already, true);
  });

  test('annulation : le terrain est libéré', async () => {
    const r = await user('POST', '/api/checkout', { plot: 6, design: {} });
    const cancel = await user('POST', `/api/checkout/${r.data.orderId}/cancel`);
    assert.equal(cancel.data.cancelled, true);
    const p = await user('GET', '/api/plots/6');
    assert.equal(p.data.plot.status, 'free');
  });
});

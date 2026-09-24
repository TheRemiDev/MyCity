import { Router } from 'express';
import { DISTRICTS } from '../../public/js/shared/catalog.js';
import { requireAdmin } from '../middleware.js';
import { HttpError, badRequest, cleanText, parseNumber, validateBranding, validateDesign } from '../services/validation.js';

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function adminRoutes({ db, city, live, sessions }) {
  const r = Router();
  r.use(requireAdmin);

  r.get('/overview', (req, res) => {
    const revenue = db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM orders WHERE status = 'paid'")
      .get();
    const revenue30 = db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM orders WHERE status = 'paid' AND paid_at >= ?")
      .get(Date.now() - 30 * 86400_000);
    const daily = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', paid_at / 1000, 'unixepoch') AS day, SUM(amount_cents) AS cents, COUNT(*) AS n
         FROM orders WHERE status = 'paid' AND paid_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(Date.now() - 30 * 86400_000);
    const signups = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
         FROM users WHERE created_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(Date.now() - 30 * 86400_000);
    const openReports = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
    const conflicts = db
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND json_extract(payload, '$.conflict') = 1")
      .get().n;
    res.json({
      stats: city.stats(),
      districts: city.districts(),
      revenue: { totalCents: revenue.total, orders: revenue.n, last30Cents: revenue30.total, daily },
      signups,
      openReports,
      conflicts,
      pricing: city.pricing(),
      announcement: city.setting('announcement', null),
    });
  });

  // ------------------------------------------------------------ habitants
  r.get('/users', (req, res) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.email, u.role, u.banned, u.created_at, u.last_seen_at,
                (SELECT COUNT(*) FROM plots p WHERE p.owner_id = u.id AND p.status = 'owned') AS plots,
                (SELECT COALESCE(SUM(amount_cents), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS spent
         FROM users u WHERE u.username LIKE ? OR u.email LIKE ? ORDER BY u.id DESC LIMIT 100`,
      )
      .all(term, term)
      .map((u) => ({ ...u, banned: Boolean(u.banned), created_at: iso(u.created_at), last_seen_at: iso(u.last_seen_at) }));
    res.json({ users });
  });

  r.patch('/users/:id', (req, res) => {
    const id = parseNumber(req.params.id, 'Utilisateur');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'Utilisateur introuvable.');
    if (id === req.user.id) throw badRequest('Vous ne pouvez pas modifier votre propre compte ici.');
    if (req.body?.role !== undefined) {
      if (!['user', 'admin'].includes(req.body.role)) throw badRequest('Rôle invalide.');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, id);
    }
    if (req.body?.banned !== undefined) {
      const banned = Boolean(req.body.banned);
      db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, id);
      if (banned) sessions.destroyAllFor(id);
    }
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ terrains & panneaux
  r.get('/plots', (req, res) => {
    const status = ['owned', 'reserved', 'free'].includes(req.query.status) ? req.query.status : 'owned';
    const plots = db
      .prepare(
        `SELECT p.number, p.district, p.status, p.floors, p.brand_name, p.website, p.price_paid_cents, p.purchased_at, u.username
         FROM plots p LEFT JOIN users u ON u.id = p.owner_id WHERE p.status = ? ORDER BY p.number LIMIT 500`,
      )
      .all(status)
      .map((p) => ({ ...p, purchased_at: iso(p.purchased_at) }));
    res.json({ plots });
  });

  r.post('/plots/:number/reset', (req, res) => {
    const number = parseNumber(req.params.number);
    city.resetPlot(number);
    city.logEvent('moderation', null, 'plot', number, `Le terrain #${number} a été remis en vente par la mairie.`);
    res.json({ ok: true });
  });

  // Modère le contenu d'un immeuble (texte/logo) sans le retirer à son propriétaire.
  r.post('/plots/:number/moderate', (req, res) => {
    const number = parseNumber(req.params.number);
    const plot = city.getPlot(number);
    if (!plot || plot.status !== 'owned') throw new HttpError(404, 'Immeuble introuvable.');
    const branding = {};
    if (req.body?.clearLogo) branding.logo = null;
    if (req.body?.clearText) Object.assign(branding, { brandName: '', description: '', website: '' });
    city.applyBranding(number, branding);
    city.broadcastPlot(number);
    res.json({ plot: city.getPlot(number) });
  });

  // Offre un terrain à un habitant (concours, partenariat…).
  r.post('/plots/:number/grant', (req, res) => {
    const number = parseNumber(req.params.number);
    const target = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String(req.body?.username || ''));
    if (!target) throw new HttpError(404, 'Habitant introuvable.');
    const plot = city.getPlot(number);
    if (!plot) throw new HttpError(404, 'Terrain introuvable.');
    if (plot.status === 'owned') throw badRequest('Ce terrain a déjà un propriétaire.');
    const design = validateDesign(req.body?.design || {});
    const branding = validateBranding(req.body?.branding || {});
    db.prepare(
      "UPDATE plots SET status = 'owned', owner_id = ?, reserved_by = NULL, reserved_until = NULL, purchased_at = ?, price_paid_cents = 0 WHERE number = ?",
    ).run(target.id, Date.now(), number);
    city.applyDesign(number, design);
    city.applyBranding(number, branding);
    city.logEvent('purchase', target, 'plot', number, `La mairie offre le terrain #${number} à ${target.username} !`);
    city.broadcastPlot(number);
    city.checkUnlocks();
    res.json({ plot: city.getPlot(number) });
  });

  r.post('/billboards/:number/reset', (req, res) => {
    const number = parseNumber(req.params.number);
    city.resetBillboard(number);
    city.broadcastBillboard(number);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ signalements
  r.get('/reports', (req, res) => {
    const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
    const reports = db
      .prepare(
        `SELECT r.id, r.target_type, r.target, r.reason, r.status, r.created_at, u.username AS reporter
         FROM reports r LEFT JOIN users u ON u.id = r.reporter_id WHERE r.status = ? ORDER BY r.id DESC LIMIT 200`,
      )
      .all(status)
      .map((row) => ({ ...row, created_at: iso(row.created_at) }));
    res.json({ reports });
  });

  r.patch('/reports/:id', (req, res) => {
    const status = req.body?.status;
    if (!['resolved', 'dismissed', 'open'].includes(status)) throw badRequest('Statut invalide.');
    db.prepare('UPDATE reports SET status = ?, resolved_at = ? WHERE id = ?').run(status, Date.now(), parseNumber(req.params.id));
    res.json({ ok: true });
  });

  r.delete('/guestbook/:id', (req, res) => {
    res.json(city.deleteGuestbook(req.user, parseNumber(req.params.id)));
  });

  // ------------------------------------------------------------ commandes
  r.get('/orders', (req, res) => {
    const orders = db
      .prepare(
        `SELECT o.id, o.kind, o.target, o.amount_cents, o.currency, o.status, o.provider, o.provider_ref, o.created_at, o.paid_at,
                json_extract(o.payload, '$.conflict') AS conflict, u.username
         FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 200`,
      )
      .all()
      .map((o) => ({ ...o, conflict: Boolean(o.conflict), created_at: iso(o.created_at), paid_at: iso(o.paid_at) }));
    res.json({ orders });
  });

  // ------------------------------------------------------------ réglages
  r.put('/settings', (req, res) => {
    const body = req.body || {};
    if (body.pricePerFloorCents !== undefined) {
      const v = Number(body.pricePerFloorCents);
      if (!Number.isInteger(v) || v < 0 || v > 100_000) throw badRequest('Prix par étage invalide.');
      city.setSetting('pricing', { ...city.setting('pricing', {}), pricePerFloorCents: v });
    }
    if (body.districts && typeof body.districts === 'object') {
      const current = city.setting('districts', {});
      for (const [id, o] of Object.entries(body.districts)) {
        if (!DISTRICTS.some((d) => d.id === id) || typeof o !== 'object' || !o) throw badRequest(`Quartier inconnu : ${id}`);
        const next = { ...(current[id] || {}) };
        if (o.unlocked === null) delete next.unlocked;
        else if (typeof o.unlocked === 'boolean') next.unlocked = o.unlocked;
        for (const key of ['basePriceCents', 'billboardMonthCents']) {
          if (o[key] === undefined) continue;
          if (o[key] === null) {
            delete next[key];
            continue;
          }
          const v = Number(o[key]);
          if (!Number.isInteger(v) || v < 50 || v > 10_000_000) throw badRequest('Prix invalide (minimum 0,50).');
          next[key] = v;
        }
        current[id] = next;
      }
      city.setSetting('districts', current);
      city.checkUnlocks();
      live.broadcast('districts', { districts: city.districts() });
    }
    res.json({ pricing: city.pricing(), districts: city.districts() });
  });

  r.post('/announce', (req, res) => {
    const message = cleanText(req.body?.message ?? '', 200);
    const announcement = message ? { message, at: new Date().toISOString() } : null;
    city.setSetting('announcement', announcement);
    live.broadcast('announcement', { announcement });
    res.json({ announcement });
  });

  return r;
}

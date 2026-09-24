import { Router } from 'express';
import { requireUser } from '../middleware.js';
import { HttpError, badRequest, cleanText, parseNumber } from '../services/validation.js';

export function cityRoutes({ city, live, payments, limit }) {
  const r = Router();
  const writeLimit = limit('write', { max: 60, windowMs: 60_000, key: (req) => req.user?.id ?? req.ip });
  const checkoutLimit = limit('checkout', { max: 12, windowMs: 10 * 60_000, key: (req) => req.user?.id ?? req.ip });
  const socialLimit = limit('social', { max: 20, windowMs: 60_000, key: (req) => req.user?.id ?? req.ip });

  r.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

  r.get('/city', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(city.cityState());
  });

  r.get('/events', (req, res) => {
    res.json({ events: city.recentEvents(Math.min(50, Number(req.query.limit) || 30)) });
  });

  r.get('/stats', (req, res) => res.json({ stats: city.stats(), districts: city.districts() }));
  r.get('/leaderboard', (req, res) => res.json(city.leaderboard()));
  r.get('/search', (req, res) => res.json(city.search(req.query.q)));
  r.get('/users/:username', (req, res) => res.json({ profile: city.profile(req.params.username) }));

  r.get('/live', (req, res) => {
    live.attach(req, res, { visitor: req.visitor, userId: req.user?.id ?? null });
  });

  // ------------------------------------------------------------ terrains
  r.get('/plots/:number', (req, res) => {
    res.json(city.plotDetails(parseNumber(req.params.number), req.user));
  });

  r.post('/plots/:number/like', requireUser, socialLimit, (req, res) => {
    res.json(city.like(req.user, parseNumber(req.params.number), req.body?.like !== false));
  });

  r.post('/plots/:number/guestbook', requireUser, socialLimit, (req, res) => {
    const body = cleanText(req.body?.body, 280, { multiline: true });
    res.status(201).json(city.postGuestbook(req.user, parseNumber(req.params.number), req.body, body));
  });

  r.delete('/guestbook/:id', requireUser, (req, res) => {
    res.json(city.deleteGuestbook(req.user, parseNumber(req.params.id, 'Message')));
  });

  r.post('/checkout', requireUser, checkoutLimit, async (req, res) => {
    res.json(await city.checkoutPlot(req.user, parseNumber(req.body?.plot, 'Terrain'), req.body || {}));
  });

  r.get('/checkout/confirm', requireUser, async (req, res) => {
    const sessionId = String(req.query.session_id || '');
    if (!payments.enabled) throw badRequest('Paiements non configurés.');
    res.json(await city.confirmStripeSession(sessionId));
  });

  r.post('/checkout/:orderId/cancel', requireUser, (req, res) => {
    res.json(city.cancelOrder(String(req.params.orderId), req.user.id));
  });

  r.patch('/buildings/:number', requireUser, writeLimit, async (req, res) => {
    res.json(await city.updateBuilding(req.user, parseNumber(req.params.number), req.body || {}));
  });

  r.delete('/buildings/:number', requireUser, writeLimit, (req, res) => {
    res.json(city.demolish(req.user, parseNumber(req.params.number)));
  });

  r.post('/buildings/:number/transfer', requireUser, writeLimit, (req, res) => {
    res.json(city.transfer(req.user, parseNumber(req.params.number), req.body?.username));
  });

  // ------------------------------------------------------------ panneaux
  r.get('/billboards/:number', (req, res) => {
    res.json(city.billboardDetails(parseNumber(req.params.number), req.user));
  });

  r.post('/billboards/checkout', requireUser, checkoutLimit, async (req, res) => {
    res.json(await city.checkoutBillboard(req.user, parseNumber(req.body?.billboard, 'Panneau'), req.body || {}));
  });

  r.patch('/billboards/:number', requireUser, writeLimit, (req, res) => {
    res.json(city.updateBillboard(req.user, parseNumber(req.params.number), req.body || {}));
  });

  r.delete('/billboards/:number', requireUser, writeLimit, (req, res) => {
    res.json(city.releaseBillboard(req.user, parseNumber(req.params.number)));
  });

  // ------------------------------------------------------------ divers
  r.post('/visit', limit('visit', { max: 120, windowMs: 60_000 }), (req, res) => {
    const type = req.body?.type === 'billboard' ? 'billboard' : 'plot';
    res.json(city.recordVisit(type, parseNumber(req.body?.number), req.visitor));
  });

  r.post('/reports', requireUser, socialLimit, (req, res) => {
    const reason = cleanText(req.body?.reason, 300, { multiline: true });
    if (reason.length < 3) throw badRequest('Précisez la raison du signalement.');
    res.status(201).json(city.report(req.user, req.body?.type, parseNumber(req.body?.target, 'Cible'), reason));
  });

  r.get('/media/:type/:number', (req, res) => {
    const media = city.media(req.params.type, parseNumber(req.params.number));
    if (!media) throw new HttpError(404, 'Image introuvable.');
    res.setHeader('Content-Type', media.mime);
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(media.data);
  });

  return r;
}

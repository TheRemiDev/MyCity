import crypto from 'node:crypto';
import { Router } from 'express';
import { transaction } from '../db.js';
import { SESSION_COOKIE, hashPassword, serializeCookie, verifyPassword } from '../services/auth.js';
import { HttpError, badRequest, cleanText, validateEmail, validatePassword, validateUsername } from '../services/validation.js';
import { requireUser } from '../middleware.js';

export function authRoutes({ db, sessions, city, config, limit }) {
  const r = Router();
  const authLimit = limit('auth', { max: 10, windowMs: 10 * 60_000 });

  function setSession(res, userId) {
    const token = sessions.create(userId);
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, token, { maxAge: sessions.ttl, secure: res.locals.secureCookies }),
    );
  }

  function me(user) {
    const plots = db
      .prepare("SELECT number FROM plots WHERE owner_id = ? AND status = 'owned' ORDER BY number")
      .all(user.id)
      .map((p) => city.getPlot(p.number));
    const billboards = db
      .prepare("SELECT number FROM billboards WHERE renter_id = ? AND status = 'rented' ORDER BY number")
      .all(user.id)
      .map((b) => city.getBillboard(b.number));
    const pending = db
      .prepare("SELECT id, kind, target, amount_cents, created_at FROM orders WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 10")
      .all(user.id)
      .map((o) => ({ id: o.id, kind: o.kind, target: o.target, amountCents: o.amount_cents, createdAt: new Date(o.created_at).toISOString() }));
    return {
      username: user.username,
      email: user.email,
      role: user.role,
      bio: user.bio,
      createdAt: new Date(user.created_at).toISOString(),
      plots,
      billboards,
      pendingOrders: pending,
      badges: city.badgesFor(user.id),
    };
  }

  r.get('/me', (req, res) => {
    res.json({ user: req.user ? me(req.user) : null });
  });

  const needsSetup = () => !db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();

  // Premier accès : création du compte administrateur. Si SETUP_TOKEN est défini (script d'installation),
  // il doit être fourni : personne d'autre ne peut prendre la main sur une instance fraîchement déployée.
  r.get('/setup', (req, res) => {
    res.json({ needed: needsSetup(), tokenRequired: Boolean(config.setupToken) });
  });

  r.post('/setup', authLimit, async (req, res) => {
    if (!needsSetup()) throw new HttpError(409, 'MyCity est déjà configurée.');
    if (config.setupToken) {
      const given = Buffer.from(String(req.body?.token ?? ''));
      const expected = Buffer.from(config.setupToken);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        throw new HttpError(403, "Code d'installation invalide.");
      }
    }
    const email = validateEmail(req.body?.email);
    const username = validateUsername(req.body?.username);
    const password = validatePassword(req.body?.password);
    const hash = await hashPassword(password);
    const user = transaction(db, () => {
      if (!needsSetup()) throw new HttpError(409, 'MyCity est déjà configurée.');
      const clash = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
      if (clash) {
        db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(hash, clash.id);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(clash.id);
      }
      const info = db
        .prepare("INSERT INTO users (email, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
        .run(email, username, hash, Date.now());
      return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    });
    setSession(res, user.id);
    city.logEvent('join', user, 'user', user.id, `La mairie de MyCity ouvre ses portes !`);
    res.status(201).json({ user: me(user) });
  });

  r.post('/auth/register', authLimit, async (req, res) => {
    if (needsSetup()) throw new HttpError(503, "MyCity n'est pas encore configurée : l'administrateur doit d'abord créer son compte.");
    const email = validateEmail(req.body?.email);
    const username = validateUsername(req.body?.username);
    const password = validatePassword(req.body?.password);
    if (req.body?.acceptTerms !== true) throw badRequest("Merci d'accepter les conditions d'utilisation.");
    const hash = await hashPassword(password);
    const user = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Cette adresse e-mail est déjà utilisée.');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, "Ce nom d'utilisateur est déjà pris.");
      const role = config.adminEmail && config.adminEmail === email ? 'admin' : 'user';
      const info = db
        .prepare('INSERT INTO users (email, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(email, username, hash, role, Date.now());
      return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    });
    setSession(res, user.id);
    city.logEvent('join', user, 'user', user.id, `${user.username} a rejoint MyCity.`);
    res.status(201).json({ user: me(user) });
  });

  r.post('/auth/login', authLimit, async (req, res) => {
    const login = String(req.body?.login ?? req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(login.toLowerCase(), login);
    // Toujours calculer un hash pour ne pas révéler l'existence du compte par le temps de réponse.
    const ok = user ? await verifyPassword(password, user.password_hash) : (await hashPassword(password), false);
    if (!ok) throw new HttpError(401, 'Identifiants incorrects.');
    if (user.banned) throw new HttpError(403, 'Ce compte a été suspendu.');
    setSession(res, user.id);
    res.json({ user: me(user) });
  });

  r.post('/auth/logout', (req, res) => {
    sessions.destroy(req.sessionToken);
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: res.locals.secureCookies }));
    res.json({ ok: true });
  });

  r.patch('/me', requireUser, (req, res) => {
    const bio = cleanText(req.body?.bio ?? '', 200, { multiline: true });
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.user.id);
    res.json({ user: me({ ...req.user, bio }) });
  });

  r.post('/me/password', requireUser, authLimit, async (req, res) => {
    const ok = await verifyPassword(String(req.body?.current ?? ''), req.user.password_hash);
    if (!ok) throw new HttpError(401, 'Mot de passe actuel incorrect.');
    const hash = await hashPassword(validatePassword(req.body?.next));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    sessions.destroyAllFor(req.user.id);
    setSession(res, req.user.id);
    res.json({ ok: true });
  });

  // RGPD : export de toutes les données personnelles.
  r.get('/me/export', requireUser, (req, res) => {
    const u = req.user;
    const data = {
      exportedAt: new Date().toISOString(),
      account: { username: u.username, email: u.email, role: u.role, bio: u.bio, createdAt: new Date(u.created_at).toISOString() },
      plots: db.prepare('SELECT number, district, floors, shape, brand_name, description, website, purchased_at, price_paid_cents FROM plots WHERE owner_id = ?').all(u.id),
      billboards: db.prepare('SELECT number, district, brand_name, message, website, rented_until FROM billboards WHERE renter_id = ?').all(u.id),
      orders: db.prepare('SELECT id, kind, target, amount_cents, currency, status, created_at, paid_at FROM orders WHERE user_id = ?').all(u.id),
      likes: db.prepare('SELECT plot_number, created_at FROM likes WHERE user_id = ?').all(u.id),
      guestbook: db.prepare('SELECT plot_number, body, created_at FROM guestbook WHERE user_id = ?').all(u.id),
    };
    res.setHeader('Content-Disposition', `attachment; filename="mycity-${u.username}.json"`);
    res.json(data);
  });

  // RGPD : suppression du compte. Les terrains et panneaux sont remis en vente.
  r.delete('/me', requireUser, authLimit, async (req, res) => {
    const ok = await verifyPassword(String(req.body?.password ?? ''), req.user.password_hash);
    if (!ok) throw new HttpError(401, 'Mot de passe incorrect.');
    const plots = db.prepare('SELECT number FROM plots WHERE owner_id = ?').all(req.user.id);
    const boards = db.prepare('SELECT number FROM billboards WHERE renter_id = ?').all(req.user.id);
    for (const p of plots) city.resetPlot(p.number);
    for (const b of boards) {
      city.resetBillboard(b.number);
      city.broadcastBillboard(b.number);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: res.locals.secureCookies }));
    city.logEvent('leave', null, 'user', null, `${req.user.username} a quitté MyCity.`);
    res.json({ ok: true });
  });

  return r;
}

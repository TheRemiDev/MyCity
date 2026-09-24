import { HttpError } from './services/validation.js';
import { SESSION_COOKIE, VISITOR_COOKIE, parseCookies, randomId, serializeCookie, visitorHash } from './services/auth.js';

export function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://checkout.stripe.com",
      "object-src 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

// Rejette les requêtes d'écriture venant d'une autre origine (protection CSRF, en plus de SameSite=Lax).
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/api/stripe/webhook') return next();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return next(new HttpError(403, 'Requête inter-sites refusée.'));
  const origin = req.get('origin');
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return next(new HttpError(403, 'Origine invalide.'));
    }
    if (host !== req.get('host')) return next(new HttpError(403, 'Origine refusée.'));
  }
  next();
}

// Limiteur de débit en mémoire, par fenêtre fixe.
export function createRateLimiter({ disabled = false } = {}) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.reset <= now) buckets.delete(key);
  }, 60_000);
  timer.unref();

  return function limit(name, { max, windowMs, key = (req) => req.ip }) {
    return (req, res, next) => {
      if (disabled) return next();
      const id = `${name}:${key(req)}`;
      const now = Date.now();
      let b = buckets.get(id);
      if (!b || b.reset <= now) {
        b = { count: 0, reset: now + windowMs };
        buckets.set(id, b);
      }
      b.count += 1;
      if (b.count > max) {
        res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000));
        return next(new HttpError(429, 'Trop de requêtes, réessayez dans un instant.'));
      }
      next();
    };
  };
}

// Attache l'utilisateur connecté et un identifiant de visiteur anonyme (compteurs de visites, présence).
export function sessionMiddleware({ sessions, config }) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.cookies = cookies;
    req.sessionToken = cookies[SESSION_COOKIE] || null;
    const user = sessions.resolve(req.sessionToken);
    req.user = user && !user.banned ? user : null;
    let vid = cookies[VISITOR_COOKIE];
    if (!vid || !/^[A-Za-z0-9_-]{16,40}$/.test(vid)) {
      vid = randomId(16);
      res.append('Set-Cookie', serializeCookie(VISITOR_COOKIE, vid, { maxAge: 365 * 24 * 3600 * 1000, secure: req.secure }));
    }
    req.visitor = visitorHash(vid);
    res.locals.secureCookies = req.secure || config.baseUrl.startsWith('https://');
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Connectez-vous pour continuer.'));
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Connectez-vous pour continuer.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Réservé aux administrateurs.'));
  next();
}

export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Requête trop volumineuse.');
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'JSON invalide.');
    const status = err instanceof HttpError ? err.status : err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) logger.error(err);
    if (res.headersSent) return;
    res.status(status).json({
      error: status >= 500 && !(err instanceof HttpError) && status !== 502 ? 'Erreur interne, réessayez plus tard.' : err.message,
      ...(err.extra || {}),
    });
  };
}

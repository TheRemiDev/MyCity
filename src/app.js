import path from 'node:path';
import express from 'express';
import { openDatabase } from './db.js';
import { createSessionStore } from './services/auth.js';
import { createLiveHub } from './services/live.js';
import { createPayments } from './services/payments.js';
import { createCityService } from './services/city.js';
import { HttpError } from './services/validation.js';
import { createRateLimiter, errorHandler, sameOrigin, securityHeaders, sessionMiddleware } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { cityRoutes } from './routes/city.js';
import { adminRoutes } from './routes/admin.js';

export function createApp(config, { fetchImpl, logger = console } = {}) {
  const db = openDatabase(config);
  const sessions = createSessionStore(db, config);
  const live = createLiveHub();
  const payments = createPayments(config, fetchImpl);
  const city = createCityService({ db, live, payments, config });
  const limit = createRateLimiter({ disabled: config.disableRateLimit });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  // Webhook Stripe : corps brut indispensable à la vérification de signature.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    let event;
    try {
      event = payments.verifyWebhook(req.body.toString('utf8'), req.get('stripe-signature'));
    } catch (err) {
      throw new HttpError(400, `Webhook refusé : ${err.message}`);
    }
    city.handleWebhookEvent(event);
    res.json({ received: true });
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(sameOrigin);
  app.use(sessionMiddleware({ sessions, config }));

  const deps = { db, sessions, live, payments, city, config, limit };
  app.use('/api', limit('api', { max: 600, windowMs: 60_000 }), authRoutes(deps), cityRoutes(deps));
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Route inconnue.')));

  app.use(
    express.static(path.join(config.root, 'public'), {
      extensions: ['html'],
      setHeaders(res, file) {
        if (/\.(js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.use((req, res) => res.status(404).sendFile(path.join(config.root, 'public', '404.html')));
  app.use(errorHandler(logger));

  // Tâches périodiques : réservations expirées, locations terminées, sessions périmées.
  const sweeper = setInterval(() => {
    try {
      city.sweep();
      sessions.purgeExpired();
    } catch (err) {
      logger.error(err);
    }
  }, 30_000);
  sweeper.unref();
  city.sweep();

  return {
    app,
    db,
    city,
    live,
    close() {
      clearInterval(sweeper);
      live.close();
      db.close();
    },
  };
}

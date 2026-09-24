import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const port = int(env.PORT, 3000);
  return {
    root,
    env: env.NODE_ENV || 'development',
    port,
    host: env.HOST || '0.0.0.0',
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbPath: env.DB_PATH || path.join(root, 'data', 'mycity.db'),
    citySeed: int(env.CITY_SEED, 1337),
    currency: (env.CURRENCY || 'eur').toLowerCase(),
    sessionDays: int(env.SESSION_DAYS, 30),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    adminEmail: (env.ADMIN_EMAIL || '').toLowerCase(),
    // Code exigé pour créer le compte administrateur au premier accès (généré par le script d'installation).
    setupToken: env.SETUP_TOKEN || '',
    // Désactive la limitation de débit (tests automatisés).
    disableRateLimit: env.DISABLE_RATE_LIMIT === '1',
  };
}

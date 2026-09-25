import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// Plages d'adresses de Cloudflare (https://www.cloudflare.com/ips/).
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
  '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const PRIVATE = ['loopback', 'linklocal', 'uniquelocal'];

// TRUST_PROXY : « 0 » (défaut), « 1 »/« true » (un proxy), un nombre de sauts, « private » (proxys sur des adresses
// privées : Docker, réseau local), « cloudflare » (proxys privés + Cloudflare), ou une liste d'adresses/CIDR.
// Seuls les proxys de confiance peuvent fixer l'IP du visiteur via X-Forwarded-For.
export function parseTrustProxy(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'false') return false;
  if (v === 'true') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'private') return PRIVATE;
  if (v === 'cloudflare') return [...PRIVATE, ...CLOUDFLARE_RANGES];
  return v.split(',').map((x) => x.trim()).filter(Boolean);
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    adminEmail: (env.ADMIN_EMAIL || '').toLowerCase(),
    // Code exigé pour créer le compte administrateur au premier accès (généré par le script d'installation).
    setupToken: env.SETUP_TOKEN || '',
    // Désactive la limitation de débit (tests automatisés).
    disableRateLimit: env.DISABLE_RATE_LIMIT === '1',
  };
}

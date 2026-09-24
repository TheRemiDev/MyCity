import crypto from 'node:crypto';

// Paiements : Stripe Checkout via son API REST (aucun SDK requis) ou mode démo si aucune clé n'est configurée.

export function createPayments(config, fetchImpl = globalThis.fetch) {
  const enabled = Boolean(config.stripeSecretKey);

  async function stripe(method, path, params) {
    const body = params ? new URLSearchParams(flatten(params)).toString() : undefined;
    const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error?.message || `Stripe a répondu ${res.status}`);
      err.status = 502;
      throw err;
    }
    return json;
  }

  return {
    mode: enabled ? 'stripe' : 'demo',
    enabled,

    async createCheckout({ order, title, description, customerEmail }) {
      if (!enabled) return { provider: 'demo', ref: null, url: null };
      const session = await stripe('POST', '/checkout/sessions', {
        mode: 'payment',
        client_reference_id: order.id,
        customer_email: customerEmail,
        success_url: `${config.baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.baseUrl}/?checkout=cancel&order=${order.id}`,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60, // minimum imposé par Stripe : 30 min
        metadata: { order_id: order.id },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: config.currency,
              unit_amount: order.amount_cents,
              product_data: { name: title, description },
            },
          },
        ],
      });
      return { provider: 'stripe', ref: session.id, url: session.url };
    },

    async retrieveSession(sessionId) {
      if (!enabled) return null;
      if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
      return stripe('GET', `/checkout/sessions/${sessionId}`);
    },

    // Vérifie la signature d'un webhook Stripe (schéma v1, HMAC-SHA256).
    verifyWebhook(rawBody, signatureHeader, toleranceSec = 300) {
      if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET non configuré');
      const parts = Object.fromEntries(
        String(signatureHeader || '')
          .split(',')
          .map((kv) => kv.split('='))
          .filter((kv) => kv.length === 2 && kv[0] === 't'),
      );
      const signatures = String(signatureHeader || '')
        .split(',')
        .filter((kv) => kv.startsWith('v1='))
        .map((kv) => kv.slice(3));
      const timestamp = Number(parts.t);
      if (!timestamp || !signatures.length) throw new Error('Signature absente');
      if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) throw new Error('Signature expirée');
      const expected = crypto
        .createHmac('sha256', config.stripeWebhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const ok = signatures.some(
        (sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)),
      );
      if (!ok) throw new Error('Signature invalide');
      return JSON.parse(rawBody);
    },
  };
}

// { a: { b: 1 }, c: [ { d: 2 } ] } -> { 'a[b]': 1, 'c[0][d]': 2 } (format attendu par l'API Stripe)
export function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') flatten(value, name, out);
    else out[name] = String(value);
  }
  return out;
}

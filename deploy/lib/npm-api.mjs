// Crée (ou met à jour) un « Proxy Host » dans Nginx Proxy Manager via son API, avec certificat Let's Encrypt.
// Usage : node npm-api.mjs <api-base> <domaines,séparés> <hôte cible> <port cible> <email LE> <tls 0|1>
// Identifiants lus dans NPM_EMAIL et NPM_PASSWORD (jamais en argument : invisibles dans `ps`).

const [api, domainsArg, forwardHost, forwardPort, leEmail, tls] = process.argv.slice(2);
const domains = domainsArg.split(',').filter(Boolean);

async function call(method, path, body, token) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000), // l'émission du certificat peut prendre du temps
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

try {
  const { token } = await call('POST', '/api/tokens', { identity: process.env.NPM_EMAIL, secret: process.env.NPM_PASSWORD });
  const hosts = await call('GET', '/api/nginx/proxy-hosts', null, token);
  const existing = hosts.find((h) => h.domain_names.some((d) => domains.includes(d)));
  const base = {
    domain_names: domains,
    forward_scheme: 'http',
    forward_host: forwardHost,
    forward_port: Number(forwardPort),
    access_list_id: 0,
    block_exploits: true,
    caching_enabled: false,
    allow_websocket_upgrade: true,
    http2_support: true,
    hsts_enabled: false,
    hsts_subdomains: false,
    advanced_config: '',
    locations: [],
  };
  const withTls = {
    ...base,
    certificate_id: existing?.certificate_id || 'new',
    ssl_forced: true,
    meta: { letsencrypt_email: leEmail, letsencrypt_agree: true, dns_challenge: false },
  };
  // NPM peut créer l'hôte même si l'émission du certificat échoue : on relit la liste avant chaque écriture.
  const save = async (payload) => {
    const current = (await call('GET', '/api/nginx/proxy-hosts', null, token)).find((h) => h.domain_names.some((d) => domains.includes(d)));
    return current
      ? call('PUT', `/api/nginx/proxy-hosts/${current.id}`, payload, token)
      : call('POST', '/api/nginx/proxy-hosts', payload, token);
  };
  if (tls === '1') {
    try {
      const host = await save(withTls);
      console.log(`OK ${host.id} tls`);
    } catch (err) {
      // Certificat refusé (DNS pas encore propagé, Cloudflare…) : on publie au moins le site en HTTP.
      const host = await save({ ...base, certificate_id: 0, ssl_forced: false });
      console.log(`OK ${host.id} notls ${err.message}`);
    }
  } else {
    const host = await save({ ...base, certificate_id: 0, ssl_forced: false });
    console.log(`OK ${host.id} notls`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

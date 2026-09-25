// Détecte le reverse proxy Docker qui détient les ports 80/443 et comment s'y brancher.
// Sortie : lignes KEY=VALUE (valeurs échappées pour `eval` en bash).
//
// Proxys reconnus : Traefik (dont Coolify, Dokploy…), nginx-proxy (+ acme-companion),
// caddy-docker-proxy, Nginx Proxy Manager, Caddy « classique », nginx « classique ».

import { execFileSync } from 'node:child_process';

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20, ...opts });
  } catch {
    return '';
  }
};
const quote = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
const out = {};
const emit = () => {
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${quote(v)}`);
};

const ids = sh('docker', ['ps', '-q']).split('\n').filter(Boolean);
if (!ids.length) {
  out.PROXY_KIND = 'none';
  emit();
  process.exit(0);
}
const containers = JSON.parse(sh('docker', ['inspect', ...ids]) || '[]');

const publishes = (c, port) =>
  Object.entries(c.NetworkSettings?.Ports || {}).some(
    ([k, binds]) => k.startsWith(`${port}/`) && (binds || []).some((b) => String(b.HostPort) === String(port)),
  );
const hostNet = (c) => c.HostConfig?.NetworkMode === 'host';
const text = (c) => [c.Config?.Image, ...(c.Config?.Entrypoint || []), ...(c.Config?.Cmd || []), ...(c.Args || []), c.Path].join(' ').toLowerCase();

function classify(c) {
  const img = String(c.Config?.Image || '').toLowerCase();
  const t = text(c);
  if (img.includes('nginx-proxy-manager') || img.includes('jc21/')) return 'npm';
  if (img.includes('caddy-docker-proxy') || img.includes('lucaslorentz')) return 'caddy-docker-proxy';
  if (img.includes('traefik') || /\btraefik\b/.test(t)) return 'traefik';
  if (img.includes('nginx-proxy') || img.includes('jwilder')) return 'nginx-proxy';
  if (img.includes('caddy')) return 'caddy';
  if (img.includes('nginx') || img.includes('openresty')) return 'nginx';
  if (img.includes('haproxy')) return 'haproxy';
  return 'unknown';
}

const PRIORITY = ['traefik', 'npm', 'nginx-proxy', 'caddy-docker-proxy', 'caddy', 'nginx', 'haproxy', 'unknown'];
const candidates = containers
  .filter((c) => publishes(c, 443) || publishes(c, 80) || (hostNet(c) && classify(c) !== 'unknown'))
  .map((c) => ({ c, kind: classify(c) }))
  .sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));

if (!candidates.length) {
  out.PROXY_KIND = 'none';
  emit();
  process.exit(0);
}
const { c: proxy, kind } = candidates[0];
const name = proxy.Name.replace(/^\//, '');
out.PROXY_KIND = kind;
out.PROXY_CONTAINER = name;
out.PROXY_IMAGE = proxy.Config?.Image || '';

// Réseaux Docker « utilisables » du proxy (réseaux définis par l'utilisateur de préférence : DNS interne)
const nets = Object.keys(proxy.NetworkSettings?.Networks || {}).filter((n) => n !== 'host' && n !== 'none');
const preferred = nets.find((n) => n !== 'bridge') || nets[0] || '';
out.PROXY_NETWORK = preferred;
out.PROXY_HOSTNET = hostNet(proxy) ? '1' : '0';
out.PROXY_IP = preferred ? proxy.NetworkSettings.Networks[preferred]?.IPAddress || '' : '';

const envOf = (c) => Object.fromEntries((c.Config?.Env || []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
const hostPathOf = (c, containerPath) => {
  const m = (c.Mounts || [])
    .filter((m) => containerPath === m.Destination || containerPath.startsWith(`${m.Destination.replace(/\/$/, '')}/`))
    .sort((a, b) => b.Destination.length - a.Destination.length)[0];
  if (!m) return '';
  return m.Source + containerPath.slice(m.Destination.length);
};
const readInContainer = (c, path) => sh('docker', ['exec', c.Id, 'cat', path]) || '';

if (kind === 'traefik') {
  const args = [...(proxy.Config?.Entrypoint || []), ...(proxy.Config?.Cmd || []), ...(proxy.Args || [])].join('\n');
  const env = envOf(proxy);
  // Fichier de configuration statique
  let cfgPath = (args.match(/--configfile[= ]([^\s]+)/i) || [])[1] || '';
  let cfg = '';
  for (const p of [cfgPath, '/etc/traefik/traefik.yml', '/etc/traefik/traefik.yaml', '/etc/traefik/traefik.toml', '/traefik.yml', '/traefik.yaml', '/traefik.toml'].filter(Boolean)) {
    cfg = readInContainer(proxy, p);
    if (cfg) {
      cfgPath = p;
      break;
    }
  }
  const all = `${args}\n${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n${cfg}`;

  // Points d'entrée : nom de celui qui écoute sur :443 et :80
  const entrypoints = {};
  for (const m of all.matchAll(/--entrypoints\.([\w-]+)\.address[= ]["']?[^"'\s]*:(\d+)/gi)) entrypoints[m[2]] ??= m[1];
  for (const m of all.matchAll(/TRAEFIK_ENTRYPOINTS_([A-Z0-9_-]+)_ADDRESS=[^\n]*:(\d+)/g)) entrypoints[m[2]] ??= m[1].toLowerCase();
  // YAML : "  websecure:\n    address: ':443'"
  for (const m of cfg.matchAll(/^\s*([\w-]+):\s*\n(?:\s+#[^\n]*\n)*\s+address:\s*["']?[^"'\n]*:(\d+)/gm)) entrypoints[m[2]] ??= m[1];
  // TOML : [entryPoints.websecure] address = ":443"
  for (const m of cfg.matchAll(/\[entryPoints\.([\w-]+)\][^[]*?address\s*=\s*["'][^"']*:(\d+)/g)) entrypoints[m[2]] ??= m[1];
  out.TRAEFIK_EP_HTTPS = entrypoints['443'] || '';
  out.TRAEFIK_EP_HTTP = entrypoints['80'] || '';

  // Résolveur de certificats ACME
  let resolver = (all.match(/--certificatesresolvers\.([\w-]+)\./i) || [])[1] || '';
  resolver ||= ((all.match(/TRAEFIK_CERTIFICATESRESOLVERS_([A-Z0-9_-]+?)_/) || [])[1] || '').toLowerCase();
  resolver ||= (cfg.match(/certificatesResolvers:\s*\n(?:\s+#[^\n]*\n)*\s+([\w-]+):/) || [])[1] || '';
  resolver ||= (cfg.match(/\[certificatesResolvers\.([\w-]+)/) || [])[1] || '';
  out.TRAEFIK_RESOLVER = resolver;

  // Fournisseurs : docker (labels) et/ou file (répertoire dynamique)
  out.TRAEFIK_DOCKER = /--providers\.docker|TRAEFIK_PROVIDERS_DOCKER|providers:[\s\S]*?\n\s+docker:|\[providers\.docker\]/i.test(all) ? '1' : '0';
  out.TRAEFIK_SWARM = /--providers\.swarm|providers:[\s\S]*?\n\s+swarm:|\[providers\.swarm\]/i.test(all) ? '1' : '0';
  const dockerNet =
    (all.match(/--providers\.docker\.network[= ]([\w.-]+)/i) || [])[1] ||
    (all.match(/TRAEFIK_PROVIDERS_DOCKER_NETWORK=([\w.-]+)/) || [])[1] ||
    (cfg.match(/docker:[\s\S]*?\n\s+network:\s*["']?([\w.-]+)/) || [])[1] ||
    '';
  if (dockerNet && nets.includes(dockerNet)) out.PROXY_NETWORK = dockerNet;
  const fileDir =
    (all.match(/--providers\.file\.directory[= ]([^\s]+)/i) || [])[1] ||
    (all.match(/TRAEFIK_PROVIDERS_FILE_DIRECTORY=([^\s]+)/) || [])[1] ||
    (cfg.match(/file:[\s\S]*?\n\s+directory:\s*["']?([^"'\n]+)/) || [])[1] ||
    '';
  out.TRAEFIK_FILE_DIR = fileDir ? hostPathOf(proxy, fileDir.trim()) : '';
}

if (kind === 'nginx-proxy') {
  // Compagnon ACME présent ?
  const companion = containers.find((c) => /acme-companion|letsencrypt-nginx-proxy-companion/.test(String(c.Config?.Image || '')));
  out.NGINX_PROXY_ACME = companion ? '1' : '0';
}

if (kind === 'caddy-docker-proxy') {
  const env = envOf(proxy);
  const ingress = (env.CADDY_INGRESS_NETWORKS || '').split(',')[0];
  if (ingress && nets.includes(ingress)) out.PROXY_NETWORK = ingress;
}

if (kind === 'caddy') {
  out.CADDYFILE_HOST = hostPathOf(proxy, '/etc/caddy/Caddyfile');
}

if (kind === 'nginx') {
  out.NGINX_CONFD_HOST = hostPathOf(proxy, '/etc/nginx/conf.d');
}

emit();

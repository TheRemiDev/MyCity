// Trouve comment les sites « voisins » d'un Caddyfile obtiennent leur certificat, pour que MyCity fasse pareil.
// Usage : node caddy-tls.mjs <Caddyfile> <domaine>
// Sortie : les lignes à recopier dans le bloc MyCity (directive `tls …` et `import …`), ou rien.
//
// Indispensable derrière Cloudflare : le défi HTTP/TLS-ALPN de Let's Encrypt y échoue souvent, et les sites
// existants utilisent alors un défi DNS (`tls { dns cloudflare … }`), un certificat d'origine Cloudflare
// (`tls cert.pem key.pem`, souvent générique *.domaine) ou `tls internal`.

import fs from 'node:fs';

const [file, domain] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const parent = domain.split('.').slice(-2).join('.');

// Découpe en blocs de premier niveau : { header, body: [lignes de profondeur 1 avec leurs sous-blocs] }
const blocks = [];
let depth = 0;
let current = null;
let skip = false;
for (const raw of text.split('\n')) {
  const line = raw.replace(/\s+#.*$/, '').trimEnd();
  const t = line.trim();
  if (/^# >>> mycity:/.test(t)) skip = true;
  if (/^# <<< mycity:/.test(t)) {
    skip = false;
    continue;
  }
  if (skip || !t || t.startsWith('#')) continue;
  const opens = (t.match(/{/g) || []).length;
  const closes = (t.match(/}/g) || []).length;
  if (depth === 0 && t.endsWith('{')) {
    current = { header: t.slice(0, -1).trim(), lines: [] };
    blocks.push(current);
  } else if (current && depth >= 1) {
    current.lines.push({ depth, text: t });
  }
  depth += opens - closes;
  if (depth <= 0) {
    depth = 0;
    current = null;
  }
}

const isSibling = (header) =>
  header
    .split(/[\s,]+/)
    .map((a) => a.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase())
    .some((host) => host !== domain && (host === parent || host.endsWith(`.${parent}`)));

for (const block of blocks) {
  if (block.header.startsWith('(') || !isSibling(block.header)) continue; // snippets et autres domaines ignorés
  const out = [];
  for (let i = 0; i < block.lines.length; i++) {
    const { depth: d, text: t } = block.lines[i];
    if (d !== 1) continue;
    // Un « import » n'est recopié que s'il apporte la configuration TLS (snippet contenant `tls`),
    // pour ne pas hériter d'autres réglages du voisin (authentification, restrictions…).
    const imp = t.match(/^import\s+(\S+)/);
    if (imp) {
      const snippet = blocks.find((b) => b.header === `(${imp[1]})`);
      if (snippet?.lines.some((l) => l.depth === 1 && /^tls(\s|$)/.test(l.text))) out.push(t);
    }
    if (/^tls(\s|$)/.test(t)) {
      out.push(t);
      if (t.endsWith('{')) {
        // recopie du sous-bloc jusqu'à l'accolade fermante correspondante
        let level = 1;
        for (let j = i + 1; j < block.lines.length && level > 0; j++) {
          const s = block.lines[j].text;
          level += (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;
          out.push(level > 0 ? `\t${s}` : s);
        }
      }
    }
  }
  if (out.length) {
    console.log(out.join('\n'));
    break;
  }
}

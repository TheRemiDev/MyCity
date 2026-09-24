import {
  MAX_BRAND_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_LENGTH,
  MIN_FLOORS,
  ROOF_STYLES,
  SHAPES,
  WINDOW_STYLES,
  DEFAULT_BUILDING,
  maxFloorsFor,
  normalizeHex,
} from '../../public/js/shared/catalog.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);

// Supprime les caractères de contrôle et normalise les espaces.
export function cleanText(value, max, { multiline = false } = {}) {
  if (value == null) return '';
  if (typeof value !== 'string') throw badRequest('Texte invalide.');
  let v = value.normalize('NFC');
  v = multiline
    ? v.replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n')
    : v.replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ');
  v = v.trim();
  if ([...v].length > max) throw badRequest(`Texte trop long (${max} caractères maximum).`);
  return v;
}

export function cleanWebsite(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw badRequest('Adresse de site invalide.');
  let v = value.trim();
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  let url;
  try {
    url = new URL(v);
  } catch {
    throw badRequest('Adresse de site invalide.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Seuls les liens http(s) sont acceptés.');
  if (!url.hostname.includes('.') || url.username || url.password) throw badRequest('Adresse de site invalide.');
  if (url.href.length > 300) throw badRequest('Adresse de site trop longue.');
  return url.href;
}

const IMAGE_SIGNATURES = [
  { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8' },
  {
    mime: 'image/webp',
    test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

// Décode une image en data URL. Le type est déterminé par les octets, jamais par ce que le client annonce
// (les SVG sont refusés : ils peuvent embarquer du script).
export function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw badRequest('Image invalide.');
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw badRequest('Image invalide (PNG, JPEG, WebP ou GIF).');
  const buf = Buffer.from(match[1], 'base64');
  if (buf.length === 0) throw badRequest('Image vide.');
  if (buf.length > MAX_IMAGE_BYTES) throw badRequest(`Image trop lourde (${Math.round(MAX_IMAGE_BYTES / 1024)} Ko maximum).`);
  const sig = IMAGE_SIGNATURES.find((s) => s.test(buf));
  if (!sig) throw badRequest('Format d\'image non supporté (PNG, JPEG, WebP ou GIF).');
  return { mime: sig.mime, data: buf };
}

const ids = (list) => new Set(list.map((x) => x.id));
const SHAPE_IDS = ids(SHAPES);
const ROOF_IDS = ids(ROOF_STYLES);
const WINDOW_IDS = ids(WINDOW_STYLES);

function pick(set, value, fallback, label) {
  if (value == null) return fallback;
  if (!set.has(value)) throw badRequest(`${label} inconnu(e).`);
  return value;
}

function color(value, fallback) {
  if (value == null) return fallback;
  const hex = normalizeHex(value, null);
  if (!hex) throw badRequest('Couleur invalide.');
  // Palette libre : n'importe quelle couleur hexadécimale est acceptée, la palette n'est qu'une suggestion.
  return hex;
}

// Valide la partie « architecture » d'un immeuble. `current` sert de base pour une mise à jour partielle.
export function validateDesign(input = {}, current = DEFAULT_BUILDING) {
  if (typeof input !== 'object' || input === null) throw badRequest('Design invalide.');
  const shape = pick(SHAPE_IDS, input.shape, current.shape, 'Forme');
  const floorsRaw = input.floors ?? current.floors;
  const floors = Number(floorsRaw);
  if (!Number.isInteger(floors)) throw badRequest("Nombre d'étages invalide.");
  const max = maxFloorsFor(shape);
  if (floors < MIN_FLOORS || floors > max) {
    throw badRequest(`Cette forme accepte entre ${MIN_FLOORS} et ${max} étages.`);
  }
  return {
    floors,
    shape,
    roofStyle: pick(ROOF_IDS, input.roofStyle, current.roofStyle, 'Toit'),
    windows: pick(WINDOW_IDS, input.windows, current.windows, 'Fenêtres'),
    color: color(input.color, current.color),
    roofColor: color(input.roofColor, current.roofColor),
    accentColor: color(input.accentColor, current.accentColor),
  };
}

// Valide l'identité affichée (enseigne, description, site, logo).
// `logo` : undefined = inchangé, null/'' = supprimé, data URL = nouveau logo.
export function validateBranding(input = {}) {
  const out = {};
  if (input.brandName !== undefined) out.brandName = cleanText(input.brandName, MAX_BRAND_LENGTH);
  if (input.description !== undefined) out.description = cleanText(input.description, MAX_DESCRIPTION_LENGTH, { multiline: true });
  if (input.website !== undefined) out.website = cleanWebsite(input.website);
  if (input.logo !== undefined) out.logo = input.logo ? decodeImage(input.logo) : null;
  return out;
}

export function validateBillboardContent(input = {}) {
  const out = {};
  if (input.brandName !== undefined) out.brandName = cleanText(input.brandName, MAX_BRAND_LENGTH);
  if (input.message !== undefined) out.message = cleanText(input.message, MAX_MESSAGE_LENGTH);
  if (input.website !== undefined) out.website = cleanWebsite(input.website);
  if (input.color !== undefined) out.color = color(input.color, '#1f2a44');
  if (input.image !== undefined) out.image = input.image ? decodeImage(input.image) : null;
  return out;
}

export function validateUsername(value) {
  if (typeof value !== 'string') throw badRequest("Nom d'utilisateur requis.");
  const v = value.trim();
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(v)) {
    throw badRequest("Nom d'utilisateur : 3 à 20 caractères (lettres, chiffres, . _ -).");
  }
  return v;
}

export function validateEmail(value) {
  if (typeof value !== 'string') throw badRequest('Adresse e-mail requise.');
  const v = value.trim().toLowerCase();
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw badRequest('Adresse e-mail invalide.');
  return v;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8) throw badRequest('Mot de passe : 8 caractères minimum.');
  if (value.length > 200) throw badRequest('Mot de passe trop long.');
  return value;
}

export function parseNumber(value, label = 'Numéro') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1e6) throw badRequest(`${label} invalide.`);
  return n;
}

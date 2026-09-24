// Catalogue partagé entre le serveur et le navigateur.
// Tout ce qui décrit les options d'un immeuble, les quartiers et les prix par défaut vit ici,
// afin que la validation serveur et l'éditeur client restent toujours alignés.

export const MIN_FLOORS = 1;
export const MAX_FLOORS = 60;
export const MAX_BRAND_LENGTH = 32;
export const MAX_DESCRIPTION_LENGTH = 280;
export const MAX_MESSAGE_LENGTH = 60;
export const MAX_IMAGE_BYTES = 280 * 1024;
export const RESERVATION_MINUTES = 15;

export const PALETTE = [
  { id: 'harbor', label: 'Port', color: '#47767b' },
  { id: 'brick', label: 'Brique', color: '#c44b3c' },
  { id: 'ivory', label: 'Ivoire', color: '#d9cbb2' },
  { id: 'sand', label: 'Sable', color: '#e3b778' },
  { id: 'sage', label: 'Sauge', color: '#8fae8b' },
  { id: 'slate', label: 'Ardoise', color: '#4b5563' },
  { id: 'night', label: 'Nuit', color: '#1f2a44' },
  { id: 'terracotta', label: 'Terracotta', color: '#b8643e' },
  { id: 'mint', label: 'Menthe', color: '#86e3c8' },
  { id: 'sky', label: 'Ciel', color: '#7fb2e5' },
  { id: 'lavender', label: 'Lavande', color: '#a99be0' },
  { id: 'rose', label: 'Rose', color: '#e79bb0' },
  { id: 'sun', label: 'Soleil', color: '#f2c94c' },
  { id: 'graphite', label: 'Graphite', color: '#2b2f33' },
  { id: 'snow', label: 'Neige', color: '#f3f1ec' },
  { id: 'wine', label: 'Bordeaux', color: '#7a2e3a' },
];

export const ROOF_COLORS = [
  { id: 'clay', label: 'Tuile', color: '#6b3f2a' },
  { id: 'zinc', label: 'Zinc', color: '#8a939b' },
  { id: 'coal', label: 'Charbon', color: '#2f3336' },
  { id: 'copper', label: 'Cuivre', color: '#5f9e8f' },
  { id: 'gold', label: 'Or', color: '#c9a227' },
  { id: 'red', label: 'Rouge', color: '#a8322d' },
  { id: 'snow', label: 'Blanc', color: '#ece8e1' },
  { id: 'navy', label: 'Marine', color: '#23355b' },
];

export const SHAPES = [
  { id: 'classic', label: 'Immeuble classique', hint: 'Le bon vieux bloc de ville.', maxFloors: 40 },
  { id: 'tower', label: 'Tour élancée', hint: 'Fine et très haute.', maxFloors: 60 },
  { id: 'wide', label: 'Bâtiment large', hint: 'Occupe toute la parcelle.', maxFloors: 25 },
  { id: 'wings', label: 'Corps + ailes', hint: 'Un corps central flanqué de deux ailes.', maxFloors: 35 },
  { id: 'porch', label: 'Piliers et porche', hint: 'Entrée monumentale à colonnes.', maxFloors: 30 },
  { id: 'stepped', label: 'Étages décalés', hint: 'Pyramide de retraits successifs.', maxFloors: 50 },
  { id: 'courtyard', label: 'Cour intérieure', hint: 'Un îlot avec patio central.', maxFloors: 12 },
  { id: 'house', label: 'Maison basse', hint: 'Petite, chaleureuse, avec jardin.', maxFloors: 3 },
];

export const ROOF_STYLES = [
  { id: 'flat', label: 'Toit plat' },
  { id: 'sloped', label: 'Toit en pente' },
  { id: 'terrace', label: 'Toit-terrasse' },
  { id: 'spire', label: 'Flèche' },
  { id: 'dome', label: 'Dôme' },
  { id: 'helipad', label: 'Héliport' },
];

export const WINDOW_STYLES = [
  { id: 'grid', label: 'Grille' },
  { id: 'sparse', label: 'Espacées' },
  { id: 'bands', label: 'Bandeaux' },
  { id: 'glass', label: 'Mur rideau' },
  { id: 'arched', label: 'Arcades' },
];

// Quartiers : ordre = ordre d'ouverture. `unlockAt` = nombre de terrains vendus dans la ville
// pour ouvrir automatiquement le quartier (l'admin peut forcer l'ouverture).
export const DISTRICTS = [
  { id: 'centre', name: 'Centre-ville', color: '#e2b04a', basePriceCents: 2900, billboardMonthCents: 1500, unlockAt: 0,
    description: "Le cœur battant de MyCity, autour de l'Hôtel de Ville et de la Grand-Place." },
  { id: 'tilleuls', name: 'Les Tilleuls', color: '#8fae8b', basePriceCents: 900, billboardMonthCents: 500, unlockAt: 0,
    description: 'Quartier résidentiel arboré, rues calmes et petites places.' },
  { id: 'affaires', name: "Quartier d'Affaires", color: '#7fb2e5', basePriceCents: 1900, billboardMonthCents: 1200, unlockAt: 30,
    description: 'Tours de verre, sièges sociaux et vue imprenable.' },
  { id: 'docks', name: 'Les Docks', color: '#47767b', basePriceCents: 1200, billboardMonthCents: 800, unlockAt: 60,
    description: 'Front de mer, entrepôts reconvertis, phare et grande roue.' },
  { id: 'arts', name: 'Quartier des Arts', color: '#e79bb0', basePriceCents: 1200, billboardMonthCents: 700, unlockAt: 100,
    description: 'Ateliers, galeries et terrasses bohèmes.' },
  { id: 'montclair', name: 'Montclair', color: '#a99be0', basePriceCents: 1500, billboardMonthCents: 900, unlockAt: 160,
    description: 'Le quartier du stade, vivant les soirs de match.' },
  { id: 'nord', name: 'Faubourg Nord', color: '#e3b778', basePriceCents: 700, billboardMonthCents: 400, unlockAt: 240,
    description: 'Nouvelle frontière de la ville : terrains à prix doux.' },
];

export const DEFAULT_PRICING = {
  pricePerFloorCents: 100,
  billboardDurations: [
    { months: 1, discount: 0 },
    { months: 3, discount: 10 },
    { months: 6, discount: 15 },
    { months: 12, discount: 25 },
  ],
};

export const DEFAULT_BUILDING = Object.freeze({
  floors: 4,
  shape: 'classic',
  roofStyle: 'flat',
  windows: 'grid',
  color: '#47767b',
  roofColor: '#6b3f2a',
  accentColor: '#d9cbb2',
});

export const BADGES = {
  pioneer: { label: 'Pionnier', hint: 'Parmi les 25 premiers propriétaires', icon: '🚩' },
  skyscraper: { label: 'Gratte-ciel', hint: 'Possède un immeuble de 40 étages ou plus', icon: '🏙️' },
  tycoon: { label: 'Magnat', hint: 'Possède au moins 5 terrains', icon: '💼' },
  advertiser: { label: 'Annonceur', hint: 'A loué un panneau publicitaire', icon: '📣' },
  beloved: { label: 'Coup de cœur', hint: 'A reçu au moins 25 « j\'aime »', icon: '❤️' },
  explorer: { label: 'Explorateur', hint: 'Possède un terrain dans 3 quartiers différents', icon: '🧭' },
};

export function shapeById(id) {
  return SHAPES.find((s) => s.id === id) || SHAPES[0];
}

export function districtById(id) {
  return DISTRICTS.find((d) => d.id === id) || null;
}

export function maxFloorsFor(shapeId) {
  return Math.min(MAX_FLOORS, shapeById(shapeId).maxFloors);
}

export function normalizeHex(value, fallback = '#47767b') {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return fallback;
}

export function plotPriceCents(district, floors, pricing = DEFAULT_PRICING) {
  const base = district?.basePriceCents ?? 1000;
  return base + Math.max(1, Math.round(floors)) * pricing.pricePerFloorCents;
}

export function upgradePriceCents(fromFloors, toFloors, pricing = DEFAULT_PRICING) {
  return Math.max(0, Math.round(toFloors) - Math.round(fromFloors)) * pricing.pricePerFloorCents;
}

export function billboardPriceCents(district, months, pricing = DEFAULT_PRICING) {
  const option = pricing.billboardDurations.find((d) => d.months === months);
  if (!option) return null;
  const monthly = district?.billboardMonthCents ?? 500;
  return Math.round((monthly * months * (100 - option.discount)) / 100);
}

export function formatMoney(cents, currency = 'EUR') {
  const hasCents = Math.round(cents) % 100 !== 0;
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function remainingLabel(until) {
  const ms = new Date(until).getTime() - Date.now();
  if (!(ms > 0)) return 'expiré';
  const hours = Math.max(1, Math.round(ms / 36e5));
  if (hours <= 24) return `${hours} h restante${hours > 1 ? 's' : ''}`;
  const days = Math.round(hours / 24);
  return `${days} j restant${days > 1 ? 's' : ''}`;
}

// Nombre d'habitants « fictifs » d'un immeuble : sert aux statistiques de la ville.
export function inhabitantsFor(floors, shapeId) {
  const perFloor = { house: 4, wide: 14, courtyard: 12, wings: 12, tower: 8 }[shapeId] ?? 10;
  return floors * perFloor;
}

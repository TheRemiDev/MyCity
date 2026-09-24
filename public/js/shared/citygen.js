// Générateur de ville déterministe, partagé entre le serveur (création des terrains en base)
// et le navigateur (rendu de la carte). À graine identique, la ville est identique au tile près.

import { DISTRICTS } from './catalog.js';

export const BLOCK = 4; // taille d'un îlot (en tuiles)
export const PERIOD = BLOCK + 1; // îlot + une rue
export const BLOCKS = 12; // îlots par côté
export const SIZE = BLOCKS * PERIOD + 1; // 61 tuiles
export const WATER_ROW = 11; // dernière rangée d'îlots : la mer
export const DOCKS_ROW = 10;
export const CENTER = SIZE / 2;

export const T = Object.freeze({
  GRASS: 0,
  ROAD: 1,
  AVENUE: 2,
  LOT: 3,
  GARDEN: 4,
  BILLBOARD: 5,
  WATER: 6,
  PARK: 7,
  LANDMARK: 8,
  QUAY: 9,
});

export const DECOR = Object.freeze({
  NONE: 0,
  TREES: 1,
  POOL: 2,
  PARKING: 3,
  PLAYGROUND: 4,
  FOUNTAIN: 5,
  FLOWERS: 6,
});

const LANDMARKS = [
  { id: 'townhall', bx: 5, by: 5, name: 'Hôtel de Ville', blurb: 'Siège du conseil municipal de MyCity.' },
  { id: 'plaza', bx: 6, by: 6, name: 'Grand-Place', blurb: 'Fontaine monumentale et marché du dimanche.' },
  { id: 'station', bx: 5, by: 1, name: 'Gare du Nord', blurb: 'Tous les trains mènent à MyCity.' },
  { id: 'stadium', bx: 9, by: 8, name: 'Stade de Montclair', blurb: '40 000 places et une ambiance électrique.' },
  { id: 'museum', bx: 2, by: 8, name: 'Musée des Arts', blurb: 'Collections permanentes et expositions éphémères.' },
  { id: 'wheel', bx: 3, by: 10, name: 'Grande Roue', blurb: 'La plus belle vue sur la baie.' },
  { id: 'lighthouse', bx: 10, by: 10, name: 'Phare des Docks', blurb: 'Il veille sur la ville depuis 1887.' },
  { id: 'park', bx: 2, by: 3, name: 'Parc des Tilleuls', blurb: 'Poumon vert de la ville, avec son lac.' },
  { id: 'park', bx: 8, by: 6, name: 'Square Montclair', blurb: 'Un jardin à la française.' },
];

const DISTRICT_ANCHORS = {
  tilleuls: [1.5, 2],
  affaires: [9.5, 2],
  arts: [1.5, 7.5],
  montclair: [9.5, 7.5],
  nord: [5.5, 1],
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function districtForBlock(bx, by) {
  if (by === DOCKS_ROW) return 'docks';
  if (bx >= 4 && bx <= 7 && by >= 4 && by <= 7) return 'centre';
  let best = null;
  let bestD = Infinity;
  for (const [id, [ax, ay]] of Object.entries(DISTRICT_ANCHORS)) {
    const d = (bx - ax) ** 2 + (by - ay) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

export function generateCity(seed = 1337) {
  const rand = mulberry32(seed);
  const n = SIZE * SIZE;
  const tiles = new Uint8Array(n);
  const districtOf = new Uint8Array(n); // index dans DISTRICTS + 1 (0 = aucun)
  const decor = new Uint8Array(n);
  const variant = new Uint8Array(n); // petite variation visuelle (0-255)
  const idx = (x, y) => y * SIZE + x;
  const districtIndex = Object.fromEntries(DISTRICTS.map((d, i) => [d.id, i + 1]));

  for (let i = 0; i < n; i++) variant[i] = Math.floor(rand() * 256);

  // 1. Rues et avenues
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x % PERIOD === 0 || y % PERIOD === 0) {
        const avenue = x === 30 || y === 30;
        tiles[idx(x, y)] = avenue ? T.AVENUE : T.ROAD;
      } else {
        tiles[idx(x, y)] = T.GRASS;
      }
    }
  }

  // 2. La mer (dernière rangée d'îlots) et le quai
  const waterStart = WATER_ROW * PERIOD; // 55 : le quai
  for (let y = waterStart; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      tiles[idx(x, y)] = y === waterStart ? T.QUAY : T.WATER;
    }
  }

  const landmarks = [];
  const lots = [];
  const billboards = [];
  const blocks = [];
  const landmarkAt = new Map(LANDMARKS.map((l) => [`${l.bx},${l.by}`, l]));

  // 3. Îlots
  for (let by = 0; by < WATER_ROW; by++) {
    for (let bx = 0; bx < BLOCKS; bx++) {
      const x0 = bx * PERIOD + 1;
      const y0 = by * PERIOD + 1;
      const district = districtForBlock(bx, by);
      const dIndex = districtIndex[district];
      const blockRand = mulberry32(hashString(`${seed}:${bx}:${by}`));
      const lm = landmarkAt.get(`${bx},${by}`);
      let kind = 'lots';
      if (lm) kind = lm.id === 'park' ? 'park' : 'landmark';
      else if (district !== 'centre' && district !== 'affaires' && blockRand() < 0.08) kind = 'park';
      blocks.push({ bx, by, x: x0, y: y0, district, kind });

      for (let ly = 0; ly < BLOCK; ly++) {
        for (let lx = 0; lx < BLOCK; lx++) {
          const x = x0 + lx;
          const y = y0 + ly;
          districtOf[idx(x, y)] = dIndex;
        }
      }
      // Les rues qui bordent l'îlot prennent la couleur du quartier (utile pour les labels)
      for (let k = -1; k <= BLOCK; k++) {
        for (const [x, y] of [[x0 + k, y0 - 1], [x0 + k, y0 + BLOCK], [x0 - 1, y0 + k], [x0 + BLOCK, y0 + k]]) {
          if (x >= 0 && y >= 0 && x < SIZE && y < SIZE && !districtOf[idx(x, y)]) districtOf[idx(x, y)] = dIndex;
        }
      }

      if (kind === 'landmark') {
        for (let ly = 0; ly < BLOCK; ly++) for (let lx = 0; lx < BLOCK; lx++) tiles[idx(x0 + lx, y0 + ly)] = T.LANDMARK;
        landmarks.push({ id: lm.id, name: lm.name, blurb: lm.blurb, x: x0, y: y0, w: BLOCK, h: BLOCK, district });
        continue;
      }
      if (kind === 'park') {
        for (let ly = 0; ly < BLOCK; ly++) {
          for (let lx = 0; lx < BLOCK; lx++) {
            const i = idx(x0 + lx, y0 + ly);
            tiles[i] = T.PARK;
            const r = blockRand();
            const inner = lx > 0 && lx < 3 && ly > 0 && ly < 3;
            if (lm && inner) decor[i] = DECOR.POOL; // le lac du parc
            else decor[i] = r < 0.55 ? DECOR.TREES : r < 0.75 ? DECOR.FLOWERS : DECOR.NONE;
          }
        }
        if (lm) landmarks.push({ id: 'park', name: lm.name, blurb: lm.blurb, x: x0, y: y0, w: BLOCK, h: BLOCK, district });
        continue;
      }

      // Îlot constructible : couronne de terrains, cœur d'îlot en jardin.
      const commercial = district === 'centre' || district === 'affaires' || district === 'docks';
      const hasBillboard = blockRand() < (commercial ? 0.55 : 0.3);
      const innerDecor = [DECOR.TREES, DECOR.TREES, DECOR.POOL, DECOR.PARKING, DECOR.PLAYGROUND, DECOR.FOUNTAIN, DECOR.FLOWERS];
      for (let ly = 0; ly < BLOCK; ly++) {
        for (let lx = 0; lx < BLOCK; lx++) {
          const x = x0 + lx;
          const y = y0 + ly;
          const i = idx(x, y);
          const inner = lx > 0 && lx < BLOCK - 1 && ly > 0 && ly < BLOCK - 1;
          if (inner) {
            tiles[i] = T.GARDEN;
            decor[i] = innerDecor[Math.floor(blockRand() * innerDecor.length)];
            continue;
          }
          // Façade principale : priorité aux faces visibles (sud puis est).
          let facing = 'S';
          if (ly === BLOCK - 1) facing = 'S';
          else if (lx === BLOCK - 1) facing = 'E';
          else if (ly === 0) facing = 'N';
          else facing = 'W';
          if (hasBillboard && lx === BLOCK - 1 && ly === BLOCK - 1) {
            tiles[i] = T.BILLBOARD;
            billboards.push({ x, y, district, facing: 'S' });
            continue;
          }
          tiles[i] = T.LOT;
          lots.push({ x, y, district, facing });
        }
      }
    }
  }

  // 4. Numérotation : par ordre d'ouverture des quartiers, puis du plus central au plus excentré.
  const order = Object.fromEntries(DISTRICTS.map((d, i) => [d.id, i]));
  const byCentrality = (a, b) =>
    order[a.district] - order[b.district] ||
    Math.hypot(a.x - CENTER, a.y - CENTER) - Math.hypot(b.x - CENTER, b.y - CENTER) ||
    a.y - b.y ||
    a.x - b.x;
  lots.sort(byCentrality).forEach((lot, i) => (lot.number = i + 1));
  billboards.sort(byCentrality).forEach((b, i) => (b.number = i + 1));

  // 5. Position des étiquettes de quartiers (barycentre des îlots)
  const labels = DISTRICTS.map((d) => {
    const own = blocks.filter((b) => b.district === d.id);
    const x = own.reduce((s, b) => s + b.x + BLOCK / 2, 0) / (own.length || 1);
    const y = own.reduce((s, b) => s + b.y + BLOCK / 2, 0) / (own.length || 1);
    return { district: d.id, x, y, blocks: own.length };
  });

  return {
    seed,
    size: SIZE,
    tiles,
    districtOf,
    decor,
    variant,
    lots,
    billboards,
    landmarks,
    blocks,
    labels,
    idx,
    districtAt(x, y) {
      const v = districtOf[idx(x, y)];
      return v ? DISTRICTS[v - 1].id : null;
    },
    isRoad(x, y) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
      const t = tiles[idx(x, y)];
      return t === T.ROAD || t === T.AVENUE || t === T.QUAY;
    },
  };
}

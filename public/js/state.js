// État global côté client + bus d'événements minimal.

const listeners = new Map();

export const state = {
  city: null, // résultat de generateCity (géométrie)
  seed: 1337,
  currency: 'EUR',
  payments: 'demo',
  pricing: null,
  districts: [],
  plots: new Map(), // number -> plot (seulement les non-libres)
  billboards: new Map(),
  stats: null,
  me: null,
  announcement: null,
  selection: null, // { type: 'plot'|'billboard'|'landmark', number|id }
  draft: null, // { number, design } : aperçu d'un immeuble en cours de design
  settings: {
    labels: true,
    heatmap: false,
    night: null, // null = automatique (heure locale)
  },
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
}

export function districtInfo(id) {
  return state.districts.find((d) => d.id === id) ?? null;
}

export function lotByNumber(number) {
  return state.city?.lots[number - 1] ?? null;
}

export function boardByNumber(number) {
  return state.city?.billboards[number - 1] ?? null;
}

// Terrain public (libre si absent de la table des terrains actifs).
export function plotState(number) {
  const lot = lotByNumber(number);
  if (!lot) return null;
  return (
    state.plots.get(number) ?? {
      number,
      x: lot.x,
      y: lot.y,
      district: lot.district,
      facing: lot.facing,
      status: 'free',
      owner: null,
      building: null,
      likes: 0,
    }
  );
}

export function billboardState(number) {
  return state.billboards.get(number) ?? null;
}

export function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(`mycity:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem(`mycity:${key}`, JSON.stringify(value));
  } catch {
    /* stockage indisponible : pas grave */
  }
}

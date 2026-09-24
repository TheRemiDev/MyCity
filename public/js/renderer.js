// Moteur de rendu isométrique : caméra, sol, objets triés en profondeur, circulation, météo, jour/nuit.

import { T, DECOR, mulberry32, hashString, BLOCK } from './shared/citygen.js';
import { DISTRICTS } from './shared/catalog.js';
import {
  FH,
  ROOF_EXTRA,
  box,
  buildingHeight,
  diamond,
  drawBillboard,
  drawBuilding,
  drawLandmark,
  drawTree,
  faceColors,
  iso,
  mix,
  nightify,
  poly,
  shade,
} from './sprites.js';
import { state, plotState, districtInfo } from './state.js';

const MIN_ZOOM = 0.22;
const MAX_ZOOM = 3.2;
const MAX_SPRITES = 700;
const PROFILE = new URLSearchParams(location.search).has('profile');

export function createRenderer(canvas, { onSelect, onHover, onCamera } = {}) {
  const mainCtx = canvas.getContext('2d');
  let ctx = mainCtx; // cible de dessin courante (écran ou cache du sol)
  const groundCanvas = document.createElement('canvas');
  const groundCtx = groundCanvas.getContext('2d');
  let groundKey = '';
  let groundVersion = 0;
  const city = state.city;
  const S = city.size;
  const cam = { x: 0, y: 0, zoom: 1, rot: 0 };
  let anim = null; // animation de caméra
  let width = 0;
  let height = 0;
  let dpr = 1;
  let time = 0;
  let lastFrame = performance.now();
  let hover = null;
  let hitList = []; // objets dessinés au dernier rendu (ordre de dessin)
  let traffic = null;
  let running = true;
  let clouds = [];
  let rain = [];
  const sprites = new Map(); // clé -> { canvas, ox, oy, used }
  const images = new Map(); // url -> { img, ok }
  let spriteBudget = 0;
  let nightCache = null;

  // ---------------------------------------------------------------- géométrie
  function rotate(u, v, r = cam.rot) {
    switch (r) {
      case 1:
        return [S - v, u];
      case 2:
        return [S - u, S - v];
      case 3:
        return [v, S - u];
      default:
        return [u, v];
    }
  }
  function unrotate(a, b, r = cam.rot) {
    switch (r) {
      case 1:
        return [b, S - a];
      case 2:
        return [S - a, S - b];
      case 3:
        return [S - b, a];
      default:
        return [a, b];
    }
  }
  // Monde (u, v continus) -> espace écran à zoom 1 (avant caméra).
  function worldToView(u, v, z = 0, r = cam.rot) {
    const [a, b] = rotate(u, v, r);
    return [(a - b) * 32, (a + b) * 16 - z];
  }
  function viewToScreen(x, y) {
    return [(x - cam.x) * cam.zoom + width / 2, (y - cam.y) * cam.zoom + height / 2];
  }
  function worldToScreen(u, v, z = 0) {
    const [x, y] = worldToView(u, v, z);
    return viewToScreen(x, y);
  }
  function screenToWorld(px, py) {
    const x = (px - width / 2) / cam.zoom + cam.x;
    const y = (py - height / 2) / cam.zoom + cam.y;
    const a = (x / 32 + y / 16) / 2;
    const b = (y / 16 - x / 32) / 2;
    return unrotate(a, b);
  }
  // Direction monde -> face visible (gauche = +v, droite = +u après rotation)
  function frontSide(facing) {
    const vec = { S: [0, 1], E: [1, 0], N: [0, -1], W: [-1, 0] }[facing] || [0, 1];
    let [dx, dy] = vec;
    for (let i = 0; i < cam.rot; i++) [dx, dy] = [-dy, dx];
    if (dy === 1 || dy === -1) return 'left';
    return 'right';
  }

  // ---------------------------------------------------------------- caméra
  function clampCamera() {
    const [minX] = worldToView(0, S, 0);
    const [maxX] = worldToView(S, 0, 0);
    const lo = Math.min(minX, maxX);
    const hi = Math.max(minX, maxX);
    cam.x = Math.max(lo, Math.min(hi, cam.x));
    cam.y = Math.max(-60, Math.min(S * 32 + 60, cam.y));
    cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom));
  }

  function centerOn(u, v, zoom = cam.zoom, { animate = true, z = 0, avoidPanel = false } = {}) {
    let [x, y] = worldToView(u, v, z);
    // Le panneau latéral masque la droite de l'écran (ou le bas sur mobile) : on décale la cible.
    if (avoidPanel) {
      const z1 = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      if (width > 640) x += 210 / z1;
      else y += (height * 0.3) / z1;
    }
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      Object.assign(cam, { x, y, zoom });
      clampCamera();
      onCamera?.(cam);
      return;
    }
    anim = { from: { ...cam }, to: { x, y, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) }, t: 0, dur: 900 };
  }

  function zoomAt(factor, px = width / 2, py = height / 2) {
    anim = null;
    const before = [(px - width / 2) / cam.zoom + cam.x, (py - height / 2) / cam.zoom + cam.y];
    cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));
    cam.x = before[0] - (px - width / 2) / cam.zoom;
    cam.y = before[1] - (py - height / 2) / cam.zoom;
    clampCamera();
    onCamera?.(cam);
  }

  function panBy(dx, dy) {
    anim = null;
    cam.x -= dx / cam.zoom;
    cam.y -= dy / cam.zoom;
    clampCamera();
    onCamera?.(cam);
  }

  function setRotation(r) {
    const [u, v] = screenToWorld(width / 2, height / 2);
    cam.rot = ((r % 4) + 4) % 4;
    sprites.clear();
    const [x, y] = worldToView(u, v);
    cam.x = x;
    cam.y = y;
    clampCamera();
    onCamera?.(cam);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    groundCanvas.width = canvas.width;
    groundCanvas.height = canvas.height;
    groundKey = '';
  }

  // ---------------------------------------------------------------- ambiance
  function ambience() {
    const forced = state.settings.night;
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    let night;
    let dusk = 0;
    if (forced === true) night = true;
    else if (forced === false) night = false;
    else {
      night = h >= 21 || h < 6.5;
      if (h >= 18.5 && h < 21) dusk = (h - 18.5) / 2.5;
      if (h >= 6.5 && h < 8) dusk = 1 - (h - 6.5) / 1.5;
    }
    if (night !== nightCache) {
      nightCache = night;
      sprites.clear();
    }
    return { night, dusk: night ? 0 : dusk };
  }

  function weatherToday() {
    const d = new Date();
    const r = mulberry32(hashString(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`))();
    const winter = d.getMonth() === 11 || d.getMonth() <= 1;
    if (r < 0.18) return winter ? 'snow' : 'rain';
    if (r < 0.5) return 'clouds';
    return 'clear';
  }
  const weather = weatherToday();

  function initWeather() {
    const rand = mulberry32(99);
    clouds = Array.from({ length: weather === 'clear' ? 5 : 12 }, () => ({
      x: rand() * 3000 - 500,
      y: rand() * 2000 - 200,
      s: 0.6 + rand() * 1.2,
      v: 6 + rand() * 10,
    }));
    rain = Array.from({ length: weather === 'rain' || weather === 'snow' ? 220 : 0 }, () => ({ x: rand(), y: rand(), v: 0.6 + rand() * 0.6 }));
  }

  // ---------------------------------------------------------------- images (logos, pubs)
  function image(url) {
    if (!url) return null;
    let entry = images.get(url);
    if (!entry) {
      entry = { img: new Image(), ok: false };
      entry.img.decoding = 'async';
      entry.img.onload = () => {
        entry.ok = true;
        invalidateAll();
      };
      entry.img.src = url;
      images.set(url, entry);
    }
    return entry.ok ? entry.img : null;
  }

  function invalidateAll() {
    sprites.clear();
    groundVersion++;
  }
  function invalidatePlot(number) {
    groundVersion++;
    for (const key of sprites.keys()) if (key.startsWith(`p${number}:`)) sprites.delete(key);
  }

  // ---------------------------------------------------------------- sprites d'immeubles
  function spriteScale() {
    const s = cam.zoom * dpr;
    return s <= 0.45 ? 0.4 : s <= 0.8 ? 0.75 : s <= 1.3 ? 1.25 : s <= 2.2 ? 2 : 3;
  }

  function buildingSprite(number, building, facing, night) {
    const scale = spriteScale();
    const front = frontSide(facing);
    const logoUrl = building.logoPreview || building.logo;
    const logo = image(logoUrl);
    const key = `p${number}:${scale}:${front}:${night ? 1 : 0}:${logo ? 1 : 0}:${building.floors}:${building.shape}:${building.roofStyle}:${building.windows}:${building.color}:${building.roofColor}:${building.accentColor}:${building.brandName}:${logoUrl || ''}`;
    let sp = sprites.get(key);
    if (sp) {
      sp.used = time;
      return sp;
    }
    if (spriteBudget <= 0) return null;
    spriteBudget--;
    const H = buildingHeight(building) + ROOF_EXTRA;
    const w = 76;
    const h = H + 26;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(h * scale);
    const g = c.getContext('2d');
    g.scale(scale, scale);
    g.translate(w / 2, H);
    drawBuilding(g, building, { front, night, seed: hashString(`plot${number}`), logo });
    sp = { canvas: c, ox: w / 2, oy: H, scale, used: time, h: buildingHeight(building) };
    sprites.set(key, sp);
    if (sprites.size > MAX_SPRITES) {
      const oldest = [...sprites.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, sprites.size - MAX_SPRITES);
      for (const [k] of oldest) sprites.delete(k);
    }
    return sp;
  }

  // ---------------------------------------------------------------- sol
  const districtColor = Object.fromEntries(DISTRICTS.map((d) => [d.id, d.color]));

  function groundColor(t, i, x, y, night, locked) {
    const v = city.variant[i];
    switch (t) {
      case T.ROAD:
        return '#5f666b';
      case T.AVENUE:
        return '#565d62';
      case T.QUAY:
        return '#8b8c84';
      case T.WATER:
        return '#5b9bb5';
      case T.PARK:
      case T.GARDEN:
        return v % 3 === 0 ? '#93b57e' : v % 3 === 1 ? '#9dbb87' : '#a3c08c';
      case T.LANDMARK:
        return '#a9c093';
      case T.BILLBOARD:
        return '#d3cec2';
      case T.LOT:
        return locked ? '#b9ae93' : '#c9d2bd';
      default:
        return v % 2 ? '#a9c093' : '#a4bc8e';
    }
  }

  function heatColor(plot, locked) {
    if (locked) return '#8d8f93';
    if (plot.status === 'owned') return '#e24a3b';
    if (plot.status === 'reserved') return '#f2c94c';
    const d = districtInfo(plot.district);
    const price = d?.basePriceCents ?? 1000;
    const t = Math.min(1, (price - 600) / 2600);
    return mix('#bdf1e2', '#1f7a60', t);
  }

  function drawGround(night, visible) {
    const heat = state.settings.heatmap;
    for (const tile of visible) {
      const { x, y, i, t, sx, sy } = tile;
      const districtId = city.districtAt(x, y);
      const locked = districtId ? !districtInfo(districtId)?.unlocked : false;
      let color = groundColor(t, i, x, y, night, locked);
      if (t === T.LOT && heat) {
        const n = tile.lot?.number;
        color = n ? heatColor(plotState(n), locked) : color;
      }
      ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, sx * dpr, sy * dpr);
      if (t === T.WATER) {
        const wave = Math.sin(time / 900 + (x + y) * 0.7) * 0.04;
        diamond(ctx, -0.51, -0.51, 0.51, 0.51, 0, nightify(shade(color, 1 + wave), night));
        if (cam.zoom > 0.5 && (x * 7 + y * 3) % 5 === 0) {
          ctx.strokeStyle = night ? 'rgba(160,190,255,0.18)' : 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 0.8;
          const off = ((time / 60 + x * 11) % 40) - 20;
          ctx.beginPath();
          ctx.moveTo(off - 6, 2);
          ctx.lineTo(off + 6, 2);
          ctx.stroke();
        }
        continue;
      }
      const isRoad = t === T.ROAD || t === T.AVENUE || t === T.QUAY;
      if (isRoad) {
        diamond(ctx, -0.51, -0.51, 0.51, 0.51, 0, nightify(color, night));
        if (cam.zoom > 0.45) drawRoadMarks(x, y, t, night);
        continue;
      }
      // trottoir puis parcelle
      if (t === T.LOT || t === T.BILLBOARD) {
        diamond(ctx, -0.51, -0.51, 0.51, 0.51, 0, nightify('#cfcabd', night));
        diamond(ctx, -0.42, -0.42, 0.42, 0.42, 0, nightify(color, night));
        if (t === T.LOT && tile.lot && cam.zoom > 0.35) {
          const plot = plotState(tile.lot.number);
          if (plot.status === 'free' && !locked && !heat) {
            ctx.strokeStyle = night ? 'rgba(134,227,200,0.25)' : 'rgba(31,95,78,0.25)';
            ctx.setLineDash([2, 2]);
            ctx.lineWidth = 0.8;
            poly(ctx, [iso(-0.36, -0.36), iso(0.36, -0.36), iso(0.36, 0.36), iso(-0.36, 0.36)], null, ctx.strokeStyle);
            ctx.setLineDash([]);
          }
        }
      } else {
        diamond(ctx, -0.51, -0.51, 0.51, 0.51, 0, nightify(color, night));
      }
      const d = city.decor[i];
      if (d === DECOR.POOL) {
        diamond(ctx, -0.34, -0.34, 0.34, 0.34, 0, nightify('#e8e2d4', night));
        diamond(ctx, -0.28, -0.28, 0.28, 0.28, 0, nightify(t === T.PARK ? '#5b9bb5' : '#7fd0e8', night));
      } else if (d === DECOR.PARKING) {
        diamond(ctx, -0.44, -0.44, 0.44, 0.44, 0, nightify('#8d9296', night));
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 0.6;
        for (let k = -0.3; k <= 0.3; k += 0.2) {
          const a = iso(k, -0.4);
          const b = iso(k, -0.1);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        }
      } else if (d === DECOR.FLOWERS && cam.zoom > 0.5) {
        const r = mulberry32(i);
        const cols = ['#e79bb0', '#f2c94c', '#f3f1ec', '#e24a3b', '#a99be0'];
        for (let k = 0; k < 14; k++) {
          const [fx, fy] = iso(r() - 0.5, r() - 0.5);
          ctx.fillStyle = nightify(cols[k % cols.length], night);
          ctx.fillRect(fx - 0.8, fy - 0.8, 1.6, 1.6);
        }
      } else if (d === DECOR.PLAYGROUND) {
        diamond(ctx, -0.36, -0.36, 0.36, 0.36, 0, nightify('#e3b778', night));
      } else if (d === DECOR.FOUNTAIN) {
        diamond(ctx, -0.36, -0.36, 0.36, 0.36, 0, nightify('#d8d0c0', night));
        ctx.fillStyle = nightify('#7fd0e8', night);
        ctx.beginPath();
        ctx.ellipse(0, 0, 11, 5.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawRoadMarks(x, y, t, night) {
    const h = city.isRoad(x - 1, y) || city.isRoad(x + 1, y);
    const v = city.isRoad(x, y - 1) || city.isRoad(x, y + 1);
    const cross = (city.isRoad(x - 1, y) || city.isRoad(x + 1, y)) && (city.isRoad(x, y - 1) || city.isRoad(x, y + 1));
    // Les axes suivent la rotation : on dessine dans l'espace monde puis on projette.
    const line = (u0, v0, u1, v1, color, width, dash) => {
      const a = worldToView(x + 0.5 + u0, y + 0.5 + v0);
      const b = worldToView(x + 0.5 + u1, y + 0.5 + v1);
      const c = worldToView(x + 0.5, y + 0.5);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(a[0] - c[0], a[1] - c[1]);
      ctx.lineTo(b[0] - c[0], b[1] - c[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const mark = night ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.7)';
    const yellow = night ? 'rgba(242,201,76,0.5)' : '#e9c46a';
    if (cross) {
      if (cam.zoom > 0.8 && t !== T.QUAY) {
        // passages piétons
        for (let k = -0.35; k <= 0.36; k += 0.14) {
          line(k, 0.42, k, 0.5, mark, 1.6);
          line(0.42, k, 0.5, k, mark, 1.6);
        }
      }
      return;
    }
    if (t === T.AVENUE) {
      if (h) {
        line(-0.5, -0.03, 0.5, -0.03, yellow, 0.9);
        line(-0.5, 0.03, 0.5, 0.03, yellow, 0.9);
      } else if (v) {
        line(-0.03, -0.5, -0.03, 0.5, yellow, 0.9);
        line(0.03, -0.5, 0.03, 0.5, yellow, 0.9);
      }
    } else if (h) line(-0.5, 0, 0.5, 0, mark, 0.8, [4, 4]);
    else if (v) line(0, -0.5, 0, 0.5, mark, 0.8, [4, 4]);
  }

  // ---------------------------------------------------------------- objets
  function collectObjects(visible, night) {
    const objs = [];
    const landmarkSeen = new Set();
    for (const tile of visible) {
      const { x, y, t, i } = tile;
      const [a, b] = rotate(x + 0.5, y + 0.5);
      const depth = a + b;
      if (t === T.LOT && tile.lot) {
        objs.push({ kind: 'plot', depth, tie: a, x, y, number: tile.lot.number, lot: tile.lot });
      } else if (t === T.BILLBOARD && tile.board) {
        objs.push({ kind: 'billboard', depth, tie: a, x, y, number: tile.board.number });
      } else if ((t === T.GARDEN || t === T.PARK) && city.decor[i] === DECOR.TREES) {
        objs.push({ kind: 'trees', depth, tie: a, x, y, i });
      } else if (t === T.GARDEN && city.decor[i] === DECOR.PLAYGROUND) {
        objs.push({ kind: 'playground', depth, tie: a, x, y, i });
      } else if (t === T.LANDMARK) {
        const lm = tile.landmark;
        if (lm && !landmarkSeen.has(lm)) {
          landmarkSeen.add(lm);
          const [la, lb] = rotate(lm.x + lm.w / 2, lm.y + lm.h / 2);
          objs.push({ kind: 'landmark', depth: la + lb, tie: la, x: lm.x, y: lm.y, landmark: lm });
        }
      }
    }
    if (traffic && cam.zoom > 0.3) {
      for (const car of traffic.cars) {
        const [a, b] = rotate(car.u, car.v);
        objs.push({ kind: 'car', depth: a + b, tie: a, car });
      }
    }
    void night;
    objs.sort((p, q) => p.depth - q.depth || p.tie - q.tie);
    return objs;
  }

  function setObjectTransform(u, v) {
    const [sx, sy] = worldToScreen(u, v);
    ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, sx * dpr, sy * dpr);
    return [sx, sy];
  }

  function drawObjects(objs, night) {
    hitList = [];
    const selected = state.selection?.type === 'plot' ? state.selection.number : null;
    let selRect = null;
    if (selected) {
      const lot = city.lots[selected - 1];
      const plot = plotState(selected);
      const bld = state.draft?.number === selected ? state.draft.design : plot?.building;
      const h = bld ? buildingHeight(bld) + 20 : 20;
      const [sx, sy] = worldToScreen(lot.x + 0.5, lot.y + 0.5);
      selRect = { x0: sx - 34 * cam.zoom, x1: sx + 34 * cam.zoom, y0: sy - h * cam.zoom, y1: sy + 16 * cam.zoom, depth: rotate(lot.x + 0.5, lot.y + 0.5).reduce((s, n) => s + n, 0) };
    }

    for (const o of objs) {
      if (o.kind === 'plot') {
        const [sx, sy] = setObjectTransform(o.x + 0.5, o.y + 0.5);
        const plot = plotState(o.number);
        const draft = state.draft?.number === o.number ? state.draft.design : null;
        const building = draft || plot.building;
        const locked = !districtInfo(o.lot.district)?.unlocked;
        if (building) {
          const H = buildingHeight(building);
          // Rayons X : les immeubles devant la sélection deviennent translucides.
          let alpha = 1;
          if (selRect && o.depth > selRect.depth && o.number !== selected) {
            const top = sy - (H + 40) * cam.zoom;
            if (sx + 34 * cam.zoom > selRect.x0 && sx - 34 * cam.zoom < selRect.x1 && top < selRect.y1 && sy > selRect.y0) alpha = 0.28;
          }
          ctx.globalAlpha = alpha;
          const sp = buildingSprite(draft ? `d${o.number}` : o.number, building, o.lot.facing, night);
          if (sp) {
            ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);
            const k = cam.zoom / sp.scale;
            ctx.drawImage(sp.canvas, -sp.ox * cam.zoom, -sp.oy * cam.zoom, sp.canvas.width * k, sp.canvas.height * k);
          } else {
            box(ctx, { u0: -0.36, v0: -0.36, u1: 0.36, v1: 0.36, z0: 0, z1: H }, faceColors(building.color || '#47767b', night));
          }
          ctx.globalAlpha = 1;
          hitList.push({ type: 'plot', number: o.number, sx, sy, h: H + 12, w: 0.46 });
        } else {
          if (plot.status === 'reserved') drawFence(night, '#f2c94c');
          else if (locked) drawConstruction(o.x, o.y, night);
          else if (cam.zoom > 1.6) drawForSale(night);
          hitList.push({ type: 'plot', number: o.number, sx, sy, h: 6, w: 0.46 });
        }
      } else if (o.kind === 'billboard') {
        const [sx, sy] = setObjectTransform(o.x + 0.5, o.y + 0.5);
        const b = state.billboards.get(o.number);
        const locked = !districtInfo(b?.district)?.unlocked;
        const ad = b?.status === 'rented' ? b.ad : null;
        drawBillboard(ctx, ad, { night, logo: image(ad?.image), time, locked });
        hitList.push({ type: 'billboard', number: o.number, sx, sy, h: 58, w: 0.46 });
      } else if (o.kind === 'trees') {
        setObjectTransform(o.x + 0.5, o.y + 0.5);
        const r = mulberry32(o.i * 7 + 3);
        const n = 1 + Math.floor(r() * 3);
        const pts = Array.from({ length: n }, () => [r() * 0.6 - 0.3, r() * 0.6 - 0.3, 8 + r() * 6, Math.floor(r() * 4)]);
        pts.sort((p, q) => p[0] + p[1] - (q[0] + q[1]));
        for (const [u, v, s, variant] of pts) drawTree(ctx, u, v, s, night, variant);
      } else if (o.kind === 'playground') {
        setObjectTransform(o.x + 0.5, o.y + 0.5);
        box(ctx, { u0: -0.2, v0: -0.05, u1: 0.2, v1: 0.05, z0: 8, z1: 9 }, faceColors('#e24a3b', night));
        box(ctx, { u0: -0.2, v0: -0.05, u1: -0.16, v1: 0.05, z0: 0, z1: 9 }, faceColors('#7fb2e5', night));
        box(ctx, { u0: 0.16, v0: -0.05, u1: 0.2, v1: 0.05, z0: 0, z1: 9 }, faceColors('#7fb2e5', night));
      } else if (o.kind === 'landmark') {
        const lm = o.landmark;
        const cu = lm.x + lm.w / 2;
        const cv = lm.y + lm.h / 2;
        const [sx, sy] = setObjectTransform(cu, cv);
        if (lm.id !== 'park') drawLandmark(ctx, lm.id, { night, time });
        hitList.push({ type: 'landmark', id: `${lm.x},${lm.y}`, landmark: lm, sx, sy, h: lm.id === 'park' ? 4 : 70, w: 2 });
      } else if (o.kind === 'car') {
        drawCar(o.car, night);
      }
    }
  }

  function drawFence(night, color) {
    const c = nightify(color, night);
    for (const [u0, v0, u1, v1] of [[-0.4, -0.4, 0.4, -0.37], [-0.4, -0.4, -0.37, 0.4], [-0.4, 0.37, 0.4, 0.4], [0.37, -0.4, 0.4, 0.4]]) {
      box(ctx, { u0, v0, u1, v1, z0: 0, z1: 5 }, { left: c, right: shade(c, 0.8), top: shade(c, 1.1) });
    }
  }

  function drawForSale(night) {
    const [x, y] = iso(0.25, 0.25, 0);
    ctx.fillStyle = nightify('#6b4a33', night);
    ctx.fillRect(x - 0.5, y - 12, 1, 12);
    ctx.fillStyle = nightify('#86e3c8', night);
    ctx.fillRect(x - 6, y - 17, 12, 7);
    ctx.fillStyle = '#0f2a22';
    ctx.font = "700 4px 'DM Sans', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('À VENDRE', x, y - 13.3);
  }

  function drawConstruction(x, y, night) {
    const r = mulberry32(x * 131 + y);
    const roll = r();
    if (roll < 0.35) drawFence(night, '#e3b778');
    if (roll < 0.025) {
      // grue
      const c = nightify('#f2c94c', night);
      box(ctx, { u0: -0.05, v0: -0.05, u1: 0.05, v1: 0.05, z0: 0, z1: 70 }, { left: c, right: shade(c, 0.8), top: c });
      const a = iso(0, 0, 70);
      const b = iso(0.9, -0.1, 70);
      const cBack = iso(-0.3, 0.05, 70);
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cBack[0], cBack[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(b[0] - 6, b[1]);
      ctx.lineTo(b[0] - 6, b[1] + 30 + Math.sin(time / 1200 + x) * 8);
      ctx.stroke();
      void a;
    } else if (roll > 0.85) {
      box(ctx, { u0: -0.2, v0: -0.15, u1: 0.1, v1: 0.15, z0: 0, z1: 5 }, faceColors('#c9c2b0', night));
    }
  }

  function drawCar(car, night) {
    const [sx, sy] = worldToScreen(car.u, car.v);
    if (sx < -40 || sy < -40 || sx > width + 40 || sy > height + 40) return;
    ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, sx * dpr, sy * dpr);
    // axe de la voiture dans l'espace tourné
    let [dx, dy] = car.dir;
    for (let i = 0; i < cam.rot; i++) [dx, dy] = [-dy, dx];
    const long = car.kind === 'bus' ? 0.3 : 0.16;
    const wide = car.kind === 'bus' ? 0.08 : 0.07;
    const alongU = dx !== 0;
    const bx = alongU ? { u0: -long, u1: long, v0: -wide, v1: wide } : { u0: -wide, u1: wide, v0: -long, v1: long };
    const color = car.kind === 'bus' ? '#e2b04a' : car.kind === 'taxi' ? '#f2c94c' : car.color;
    const fc = faceColors(color, night);
    box(ctx, { ...bx, z0: 1, z1: car.kind === 'bus' ? 8 : 4 }, fc);
    if (car.kind !== 'bus') {
      const s = 0.55;
      box(ctx, { u0: bx.u0 * s, u1: bx.u1 * s, v0: bx.v0 * 0.85, v1: bx.v1 * 0.85, z0: 4, z1: 6.5 }, { left: night ? '#2a3550' : '#b9d4e3', right: night ? '#1d2640' : '#8fb0c4', top: fc.top });
    }
    if (night) {
      const [hx, hy] = iso((dx > 0 ? bx.u1 : dx < 0 ? bx.u0 : 0) + dx * 0.5, (dy > 0 ? bx.v1 : dy < 0 ? bx.v0 : 0) + dy * 0.5, 2);
      const [ox, oy] = iso(dx > 0 ? bx.u1 : dx < 0 ? bx.u0 : 0, dy > 0 ? bx.v1 : dy < 0 ? bx.v0 : 0, 2);
      const g = ctx.createLinearGradient(ox, oy, hx, hy);
      g.addColorStop(0, 'rgba(255,240,190,0.55)');
      g.addColorStop(1, 'rgba(255,240,190,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    }
  }

  function drawBoats(night) {
    if (!traffic) return;
    for (const b of traffic.boats) {
      const [sx, sy] = worldToScreen(b.u, b.v);
      if (sx < -60 || sy < -80 || sx > width + 60 || sy > height + 40) continue;
      ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, sx * dpr, sy * dpr);
      const bob = Math.sin(time / 500 + b.u) * 0.8;
      poly(ctx, [[-9, bob - 1], [9, bob - 1], [6, bob + 3], [-6, bob + 3]], nightify('#f3f1ec', night));
      poly(ctx, [[0, bob - 22], [0, bob - 2], [8 * Math.sign(b.speed), bob - 3]], nightify(b.sail, night));
      ctx.fillStyle = '#555';
      ctx.fillRect(-0.4, bob - 22, 0.8, 21);
    }
  }

  // ---------------------------------------------------------------- superpositions
  function drawSelection(visibleTiles, night) {
    const sel = state.selection;
    const drawTileOutline = (x, y, color, widthPx, fill) => {
      const [sx, sy] = worldToScreen(x + 0.5, y + 0.5);
      ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, sx * dpr, sy * dpr);
      ctx.lineWidth = widthPx / cam.zoom;
      poly(ctx, [iso(-0.5, -0.5), iso(0.5, -0.5), iso(0.5, 0.5), iso(-0.5, 0.5)], fill, color);
    };
    if (hover && (!sel || hover.type !== sel.type || hover.number !== sel.number)) {
      if (hover.type === 'plot' || hover.type === 'billboard') {
        const t = hover.type === 'plot' ? city.lots[hover.number - 1] : city.billboards[hover.number - 1];
        drawTileOutline(t.x, t.y, 'rgba(255,255,255,0.9)', 1.5, 'rgba(255,255,255,0.12)');
      }
    }
    if (sel && (sel.type === 'plot' || sel.type === 'billboard')) {
      const t = sel.type === 'plot' ? city.lots[sel.number - 1] : city.billboards[sel.number - 1];
      const pulse = 0.5 + Math.sin(time / 250) * 0.25;
      drawTileOutline(t.x, t.y, '#86e3c8', 2.5, `rgba(134,227,200,${0.15 + pulse * 0.2})`);
    }
    void visibleTiles;
    void night;
  }

  function drawMarker() {
    const sel = state.selection;
    if (!sel || (sel.type !== 'plot' && sel.type !== 'billboard')) return;
    const t = sel.type === 'plot' ? city.lots[sel.number - 1] : city.billboards[sel.number - 1];
    const plot = sel.type === 'plot' ? plotState(sel.number) : null;
    const bld = state.draft?.number === sel.number ? state.draft.design : plot?.building;
    const h = sel.type === 'billboard' ? 64 : bld ? buildingHeight(bld) + 40 : 18;
    const [sx, sy] = worldToScreen(t.x + 0.5, t.y + 0.5, h);
    const bob = Math.sin(time / 300) * 4;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#86e3c8';
    ctx.strokeStyle = '#161a17';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const y = sy - 18 + bob;
    ctx.moveTo(sx, y + 14);
    ctx.lineTo(sx - 8, y);
    ctx.arc(sx, y, 8, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#161a17';
    ctx.beginPath();
    ctx.arc(sx, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawLabels() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cam.zoom < 0.62) {
      for (const label of city.labels) {
        const d = districtInfo(label.district);
        if (!d) continue;
        const [sx, sy] = worldToScreen(label.x, label.y, 0);
        if (sx < -200 || sx > width + 200 || sy < -50 || sy > height + 50) continue;
        ctx.font = "800 16px 'Syne', 'DM Sans', sans-serif";
        const text = d.name.toUpperCase();
        const w = ctx.measureText(text).width + 24;
        ctx.fillStyle = 'rgba(22,26,23,0.82)';
        roundRect(sx - w / 2, sy - 16, w, 32, 16);
        ctx.fill();
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(sx - w / 2 + 14, sy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f1f3ef';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, sx + 5, sy + 1);
        if (!d.unlocked) {
          ctx.font = "500 11px 'DM Sans', sans-serif";
          ctx.fillStyle = 'rgba(22,26,23,0.82)';
          const sub = `Ouvre à ${d.unlockAt} terrains vendus`;
          const sw = ctx.measureText(sub).width + 16;
          roundRect(sx - sw / 2, sy + 20, sw, 20, 10);
          ctx.fill();
          ctx.fillStyle = '#f2c94c';
          ctx.fillText(sub, sx, sy + 30.5);
        }
      }
      return;
    }
    if (!state.settings.labels || cam.zoom < 1.35) return;
    const taken = [];
    ctx.font = "700 11px 'DM Sans', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const hit of hitList) {
      if (hit.type !== 'plot') continue;
      const plot = plotState(hit.number);
      const name = plot?.building?.brandName;
      if (!name) continue;
      const x = hit.sx;
      const y = hit.sy - (hit.h + 16) * cam.zoom;
      if (x < 0 || x > width || y < 0 || y > height) continue;
      const w = Math.min(160, ctx.measureText(name).width + 16);
      const rect = [x - w / 2, y - 10, w, 20];
      if (taken.some((r) => rect[0] < r[0] + r[2] && rect[0] + rect[2] > r[0] && rect[1] < r[1] + r[3] && rect[1] + rect[3] > r[1])) continue;
      taken.push(rect);
      if (taken.length > 40) break;
      ctx.fillStyle = 'rgba(22,26,23,0.85)';
      roundRect(rect[0], rect[1], rect[2], rect[3], 10);
      ctx.fill();
      ctx.fillStyle = '#f1f3ef';
      ctx.fillText(name, x, y + 0.5, w - 10);
    }
  }

  function drawWeather(dt, amb) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // voile crépuscule / nuit
    if (amb.dusk > 0) {
      ctx.fillStyle = `rgba(255,120,70,${0.16 * amb.dusk})`;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = `rgba(60,40,120,${0.12 * amb.dusk})`;
      ctx.fillRect(0, 0, width, height);
    }
    if (weather !== 'clear' || clouds.length) {
      for (const c of clouds) {
        c.x += c.v * dt;
        if (c.x > 3200) c.x = -600;
        const px = ((c.x - cam.x * 0.3 * cam.zoom) % (width + 800)) - 400;
        const py = ((c.y - cam.y * 0.3 * cam.zoom) % (height + 400) + height + 400) % (height + 400) - 200;
        const r = 70 * c.s * Math.max(0.6, cam.zoom);
        ctx.fillStyle = amb.night ? 'rgba(180,190,220,0.05)' : weather === 'clear' ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.26)';
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * 0.45, 0, 0, Math.PI * 2);
        ctx.ellipse(px + r * 0.6, py + 6, r * 0.7, r * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (rain.length) {
      const snow = weather === 'snow';
      ctx.strokeStyle = snow ? 'rgba(255,255,255,0.85)' : amb.night ? 'rgba(170,190,230,0.35)' : 'rgba(90,110,130,0.35)';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of rain) {
        d.y += d.v * dt * (snow ? 0.15 : 1.1);
        d.x += dt * (snow ? Math.sin(time / 1000 + d.v * 10) * 0.01 : 0.05);
        if (d.y > 1) d.y -= 1;
        if (d.x > 1) d.x -= 1;
        const x = d.x * width;
        const y = d.y * height;
        if (snow) {
          ctx.moveTo(x + 1.5, y);
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        } else {
          ctx.moveTo(x, y);
          ctx.lineTo(x - 3, y + 12);
        }
      }
      if (snow) ctx.fill();
      else ctx.stroke();
    }
    if (amb.night) {
      // Lampadaires aux carrefours
      ctx.globalCompositeOperation = 'lighter';
      for (const tile of visibleCache) {
        if (!(tile.t === T.ROAD || tile.t === T.AVENUE || tile.t === T.QUAY) || tile.x % 5 || tile.y % 5) continue;
        const [sx, sy] = [tile.sx, tile.sy];
        const r = 40 * cam.zoom;
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
        g.addColorStop(0, 'rgba(255,200,120,0.28)');
        g.addColorStop(1, 'rgba(255,200,120,0)');
        ctx.fillStyle = g;
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------------------------------------------------------------- tuiles visibles
  const lotAt = new Map(city.lots.map((l) => [`${l.x},${l.y}`, l]));
  const boardAt = new Map(city.billboards.map((b) => [`${b.x},${b.y}`, b]));
  const landmarkAt = new Map();
  for (const lm of city.landmarks) {
    for (let y = lm.y; y < lm.y + lm.h; y++) for (let x = lm.x; x < lm.x + lm.w; x++) landmarkAt.set(`${x},${y}`, lm);
  }
  let visibleCache = [];

  // Ordre de dessin (arrière -> avant) précalculé pour chaque orientation : aucun tri par image.
  const orderByRot = [0, 1, 2, 3].map((r) => {
    const idx = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) idx.push([x, y]);
    const depth = ([x, y]) => rotate(x, y, r).reduce((a, b) => a + b, 0);
    return idx.sort((a, b) => depth(a) - depth(b));
  });
  const tileMeta = new Map();
  function meta(x, y) {
    const i = city.idx(x, y);
    let m = tileMeta.get(i);
    if (!m) {
      const key = `${x},${y}`;
      m = { i, t: city.tiles[i], lot: lotAt.get(key), board: boardAt.get(key), landmark: landmarkAt.get(key) };
      tileMeta.set(i, m);
    }
    return m;
  }

  function visibleTiles() {
    const out = [];
    const margin = 120 * cam.zoom;
    const tall = 520 * cam.zoom; // immeubles hauts dont la base est hors écran
    for (const [x, y] of orderByRot[cam.rot]) {
      const [sx, sy] = worldToScreen(x + 0.5, y + 0.5);
      if (sx < -margin || sx > width + margin || sy < -margin || sy > height + tall) continue;
      const m = meta(x, y);
      out.push({ x, y, i: m.i, t: m.t, sx, sy, lot: m.lot, board: m.board, landmark: m.landmark });
    }
    return out;
  }

  // ---------------------------------------------------------------- boucle
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    time = now;
    spriteBudget = 40;
    if (anim) {
      anim.t += dt * 1000;
      const k = Math.min(1, anim.t / anim.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      cam.x = anim.from.x + (anim.to.x - anim.from.x) * e;
      cam.y = anim.from.y + (anim.to.y - anim.from.y) * e;
      cam.zoom = anim.from.zoom + (anim.to.zoom - anim.from.zoom) * e;
      if (k >= 1) anim = null;
      clampCamera();
      onCamera?.(cam);
    }
    traffic?.update(dt);
    const amb = ambience();
    const night = amb.night;
    const P = PROFILE ? {} : null;
    let t0 = performance.now();
    visibleCache = visibleTiles();
    if (P) { P.visible = performance.now() - t0; t0 = performance.now(); }
    // Le sol est mis en cache : il n'est redessiné que si la vue ou la ville change (et ~1×/s pour l'eau).
    const key = `${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.zoom.toFixed(4)}|${cam.rot}|${night}|${state.settings.heatmap}|${groundVersion}|${width}x${height}|${Math.floor(time / 900)}`;
    if (key !== groundKey) {
      groundKey = key;
      ctx = groundCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = night ? '#0e1526' : '#b7c3bb';
      ctx.fillRect(0, 0, groundCanvas.width, groundCanvas.height);
      drawGround(night, visibleCache);
      ctx = mainCtx;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(groundCanvas, 0, 0);
    if (P) { P.ground = performance.now() - t0; t0 = performance.now(); }
    drawSelection(visibleCache, night);
    drawBoats(night);
    const objs = collectObjects(visibleCache, night);
    if (P) { P.collect = performance.now() - t0; t0 = performance.now(); }
    drawObjects(objs, night);
    if (P) { P.objects = performance.now() - t0; t0 = performance.now(); }
    drawWeather(dt, amb);
    drawLabels();
    drawMarker();
    if (P) { P.overlay = performance.now() - t0; window.__mcProfile = P; }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- interactions
  function pointInHex(px, py, hit) {
    const z = cam.zoom;
    const w = hit.w;
    // Hexagone de la silhouette d'un volume carré (demi-côté w) de hauteur h.
    const hex = [
      iso(w, w, 0),
      iso(w, -w, 0),
      iso(w, -w, hit.h),
      iso(-w, -w, hit.h),
      iso(-w, w, hit.h),
      iso(-w, w, 0),
    ].map(([x, y]) => [hit.sx + x * z, hit.sy + y * z]);
    let inside = false;
    for (let i = 0, j = hex.length - 1; i < hex.length; j = i++) {
      const [xi, yi] = hex[i];
      const [xj, yj] = hex[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function pick(px, py) {
    for (let i = hitList.length - 1; i >= 0; i--) {
      const hit = hitList[i];
      if (hit.type === 'landmark' && hit.landmark.id === 'park') continue;
      if (pointInHex(px, py, hit)) return hit;
    }
    // sinon : la tuile sous le curseur
    const [u, v] = screenToWorld(px, py);
    const x = Math.floor(u);
    const y = Math.floor(v);
    const key = `${x},${y}`;
    const lot = lotAt.get(key);
    if (lot) return { type: 'plot', number: lot.number };
    const board = boardAt.get(key);
    if (board) return { type: 'billboard', number: board.number };
    const lm = landmarkAt.get(key);
    if (lm) return { type: 'landmark', id: `${lm.x},${lm.y}`, landmark: lm };
    return null;
  }

  function setupInput() {
    const pointers = new Map();
    let dragDist = 0;
    let pinch = null;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragDist = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) {
        const hit = pick(e.clientX, e.clientY);
        const changed = hit?.type !== hover?.type || hit?.number !== hover?.number || hit?.id !== hover?.id;
        hover = hit;
        canvas.classList.toggle('pointing', Boolean(hit));
        if (changed || hit) onHover?.(hit, e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const target = (pinch.zoom * d) / pinch.d;
        zoomAt(target / cam.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2);
        dragDist += 10;
        return;
      }
      dragDist += Math.abs(dx) + Math.abs(dy);
      if (dragDist > 4) {
        canvas.classList.add('dragging');
        panBy(dx, dy);
        onHover?.(null);
      }
    });
    const end = (e) => {
      const had = pointers.has(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      canvas.classList.remove('dragging');
      if (had && e.type === 'pointerup' && dragDist <= 6 && pointers.size === 0) {
        onSelect?.(pick(e.clientX, e.clientY));
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      hover = null;
      onHover?.(null);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomAt(Math.exp(-delta * 0.0015), e.clientX, e.clientY);
      },
      { passive: false },
    );
    canvas.addEventListener('dblclick', (e) => zoomAt(1.8, e.clientX, e.clientY));

    // Clavier : flèches, ZQSD et WASD
    const keys = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => keys.clear());
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let dx = 0;
      let dy = 0;
      if (keys.has('arrowleft') || keys.has('q') || keys.has('a')) dx -= 1;
      if (keys.has('arrowright') || keys.has('d')) dx += 1;
      if (keys.has('arrowup') || keys.has('z') || keys.has('w')) dy -= 1;
      if (keys.has('arrowdown') || keys.has('s')) dy += 1;
      if (dx || dy) {
        const n = Math.hypot(dx, dy);
        panBy((-dx / n) * 700 * dt, (-dy / n) * 700 * dt);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- démarrage
  resize();
  window.addEventListener('resize', resize);
  initWeather();
  setupInput();
  const [hx, hy] = worldToView(33, 31);
  cam.x = hx;
  cam.y = hy;
  cam.zoom = window.innerWidth < 640 ? 0.7 : 1;
  requestAnimationFrame(frame);

  return {
    cam,
    worldToScreen,
    screenToWorld,
    centerOn,
    zoomAt,
    setRotation,
    rotate: () => setRotation(cam.rot + 1),
    setTraffic(t) {
      traffic = t;
    },
    invalidatePlot,
    invalidateAll,
    focusPlot(number, zoom = Math.max(cam.zoom, 1.4)) {
      const lot = city.lots[number - 1];
      const plot = plotState(number);
      const h = plot?.building ? buildingHeight(plot.building) / 2 : 0;
      centerOn(lot.x + 0.5, lot.y + 0.5, zoom, { z: h, avoidPanel: true });
    },
    focusTile(x, y, zoom = Math.max(cam.zoom, 1.2), avoidPanel = true) {
      centerOn(x + 0.5, y + 0.5, zoom, { avoidPanel });
    },
    viewportPolygon() {
      return [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ].map(([x, y]) => screenToWorld(x, y));
    },
    stop() {
      running = false;
    },
    get weather() {
      return weather;
    },
    isNight: () => nightCache,
    FH,
  };
}

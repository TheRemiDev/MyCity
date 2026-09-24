// Dessin procédural des éléments de la ville en projection isométrique.
// Repère local : (u, v) en unités de tuile, centrés sur la tuile ; z en pixels vers le haut.
// Écran : x = (u - v) * 32, y = (u + v) * 16 - z. Face « gauche » = normale +v, face « droite » = normale +u.

import { mulberry32, hashString } from './shared/citygen.js';
import { maxFloorsFor } from './shared/catalog.js';

export const TW = 64;
export const TH = 32;
export const FH = 7; // hauteur d'un étage en px
export const ROOF_EXTRA = 80;

// ------------------------------------------------------------------ couleurs
const rgbCache = new Map();
export function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) {
    const h = hex.replace('#', '');
    c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    rgbCache.set(hex, c);
  }
  return c;
}
const toHex = (r, g, b) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
export function shade(hex, f) {
  const [r, g, b] = rgb(hex);
  return f <= 1 ? toHex(r * f, g * f, b * f) : toHex(r + (255 - r) * (f - 1), g + (255 - g) * (f - 1), b + (255 - b) * (f - 1));
}
export function mix(a, b, t) {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
// Palette de nuit : assombrit et bleuit.
export function nightify(hex, night) {
  return night ? mix(shade(hex, 0.42), '#101a33', 0.35) : hex;
}

// ------------------------------------------------------------------ primitives
export const iso = (u, v, z = 0) => [(u - v) * 32, (u + v) * 16 - z];

export function poly(ctx, pts, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
}

export function diamond(ctx, u0, v0, u1, v1, z, fill, stroke) {
  poly(ctx, [iso(u0, v0, z), iso(u1, v0, z), iso(u1, v1, z), iso(u0, v1, z)], fill, stroke);
}

// Espace de la face gauche (v = v1) : x = u, y = -z.
export function withLeftFace(ctx, v1, fn) {
  ctx.save();
  ctx.transform(32, 16, 0, 1, -32 * v1, 16 * v1);
  fn();
  ctx.restore();
}
// Espace de la face droite (u = u1) : x = -v (croissant vers la droite de l'écran), y = -z.
export function withRightFace(ctx, u1, fn) {
  ctx.save();
  ctx.transform(32, -16, 0, 1, 32 * u1, 16 * u1);
  fn();
  ctx.restore();
}
// Espace du plan horizontal à la hauteur z : x = u, y = v.
export function withTop(ctx, z, fn) {
  ctx.save();
  ctx.transform(32, 16, -32, 16, 0, -z);
  fn();
  ctx.restore();
}

// Pavé : dessine les faces visibles. Renvoie la géométrie pour la décoration.
export function box(ctx, b, colors) {
  const { u0, v0, u1, v1, z0, z1 } = b;
  poly(ctx, [iso(u0, v1, z0), iso(u1, v1, z0), iso(u1, v1, z1), iso(u0, v1, z1)], colors.left);
  poly(ctx, [iso(u1, v1, z0), iso(u1, v0, z0), iso(u1, v0, z1), iso(u1, v1, z1)], colors.right);
  if (colors.top) poly(ctx, [iso(u0, v0, z1), iso(u1, v0, z1), iso(u1, v1, z1), iso(u0, v1, z1)], colors.top);
  if (colors.edge) {
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    const a = iso(u1, v1, z0);
    const c = iso(u1, v1, z1);
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.stroke();
  }
}

export function faceColors(base, night) {
  const c = nightify(base, night);
  return { left: shade(c, 0.94), right: shade(c, 0.74), top: shade(c, 1.12), edge: shade(c, 0.6) };
}

// ------------------------------------------------------------------ fenêtres
function windowColor(faceBase, side, night, lit) {
  if (night) return lit ? (side === 'left' ? '#ffd98f' : '#e9bf6c') : side === 'left' ? '#1d2840' : '#161f33';
  const glass = side === 'left' ? '#a9cde0' : '#7fa3ba';
  return mix(glass, faceBase, 0.18);
}

function drawWindows(ctx, side, a0, a1, z0, z1, floors, style, base, night, rand, floorH) {
  const W = a1 - a0;
  if (W <= 0.05 || floors <= 0) return;
  const m = Math.min(0.05, W * 0.12);
  const lit = () => rand() < 0.55;
  if (style === 'glass') {
    const g = ctx.createLinearGradient(a0, -z1, a1, -z0);
    if (night) {
      g.addColorStop(0, '#1f2d4d');
      g.addColorStop(1, '#131c30');
    } else {
      g.addColorStop(0, side === 'left' ? '#c7e3f1' : '#9cc2d8');
      g.addColorStop(0.5, side === 'left' ? '#8fbad3' : '#6f98b3');
      g.addColorStop(1, side === 'left' ? '#b4d6e8' : '#86adc6');
    }
    ctx.fillStyle = g;
    ctx.fillRect(a0 + m * 0.4, -z1 + 2, W - m * 0.8, z1 - z0 - 3);
    ctx.fillStyle = shade(nightify(base, night), 0.8);
    for (let f = 1; f < floors; f++) ctx.fillRect(a0 + m * 0.4, -(z0 + f * floorH) - 0.35, W - m * 0.8, 0.7);
    const cols = Math.max(2, Math.round(W * 8));
    for (let c = 1; c < cols; c++) ctx.fillRect(a0 + m * 0.4 + ((W - m * 0.8) * c) / cols - 0.006, -z1 + 2, 0.012, z1 - z0 - 3);
    if (night) {
      for (let f = 0; f < floors; f++) {
        for (let c = 0; c < cols; c++) {
          if (rand() < 0.35) {
            ctx.fillStyle = 'rgba(255,214,140,0.85)';
            const cw = (W - m * 0.8) / cols;
            ctx.fillRect(a0 + m * 0.4 + c * cw + 0.01, -(z0 + (f + 1) * floorH) + 1, cw - 0.02, floorH - 2);
          }
        }
      }
    }
    return;
  }
  if (style === 'bands') {
    for (let f = 0; f < floors; f++) {
      const y = -(z0 + f * floorH + floorH * 0.72);
      ctx.fillStyle = windowColor(base, side, night, lit());
      ctx.fillRect(a0 + m, y, W - 2 * m, floorH * 0.42);
    }
    return;
  }
  const density = style === 'sparse' ? 4 : style === 'arched' ? 6 : 9;
  const cols = Math.max(style === 'sparse' ? 1 : 2, Math.round(W * density));
  const cell = (W - 2 * m) / cols;
  const ww = cell * (style === 'sparse' ? 0.42 : style === 'arched' ? 0.5 : 0.56);
  const wh = floorH * (style === 'sparse' ? 0.55 : 0.5);
  for (let f = 0; f < floors; f++) {
    const yBase = -(z0 + f * floorH + floorH * 0.22);
    for (let c = 0; c < cols; c++) {
      const x = a0 + m + c * cell + (cell - ww) / 2;
      ctx.fillStyle = windowColor(base, side, night, lit());
      if (style === 'arched') {
        ctx.beginPath();
        ctx.rect(x, yBase - wh, ww, wh);
        ctx.ellipse(x + ww / 2, yBase - wh, ww / 2, Math.min(wh * 0.45, 3), 0, Math.PI, 0);
        ctx.fill();
      } else {
        ctx.fillRect(x, yBase - wh, ww, wh);
      }
    }
  }
}

// ------------------------------------------------------------------ formes
// Chaque forme renvoie une liste de volumes (dans l'ordre de dessin) et le volume principal (toit, enseigne).
function shapeParts(shape, H, colors) {
  const { color, accent } = colors;
  switch (shape) {
    case 'tower': {
      const podium = Math.min(H, FH * 2);
      const parts = [{ u0: -0.4, v0: -0.4, u1: 0.4, v1: 0.4, z0: 0, z1: podium, color: mix(color, accent, 0.55), floors: Math.round(podium / FH), top: true }];
      if (H > podium) parts.push({ u0: -0.25, v0: -0.25, u1: 0.25, v1: 0.25, z0: podium, z1: H, color, floors: Math.round((H - podium) / FH) });
      return { parts, main: parts[parts.length - 1] };
    }
    case 'wide': {
      const p = { u0: -0.44, v0: -0.44, u1: 0.44, v1: 0.44, z0: 0, z1: H, color };
      return { parts: [p], main: p };
    }
    case 'wings': {
      const wingH = Math.max(FH, Math.round((H * 0.6) / FH) * FH);
      const back = { u0: -0.44, v0: -0.3, u1: -0.2, v1: 0.3, z0: 0, z1: wingH, color: shade(color, 0.96) };
      const mid = { u0: -0.2, v0: -0.4, u1: 0.2, v1: 0.4, z0: 0, z1: H, color };
      const front = { u0: 0.2, v0: -0.3, u1: 0.44, v1: 0.3, z0: 0, z1: wingH, color: shade(color, 0.96) };
      return { parts: [back, mid, front], main: mid, flatTops: [back, front] };
    }
    case 'porch': {
      const main = { u0: -0.38, v0: -0.38, u1: 0.38, v1: 0.14, z0: 0, z1: H, color };
      const porchH = Math.min(H, FH * 1.4);
      const cols = [-0.3, -0.1, 0.1, 0.3].map((u) => ({
        u0: u - 0.03, v0: 0.35, u1: u + 0.03, v1: 0.41, z0: 0, z1: porchH, color: accent, plain: true,
      }));
      const slab = { u0: -0.4, v0: 0.12, u1: 0.4, v1: 0.43, z0: porchH, z1: porchH + 3, color: accent, plain: true, top: true };
      return { parts: [main, ...cols, slab], main };
    }
    case 'stepped': {
      const tiers = Math.max(1, Math.min(4, Math.ceil(H / (FH * 6))));
      const parts = [];
      let z = 0;
      const floorsTotal = Math.round(H / FH);
      for (let k = 0; k < tiers; k++) {
        const f = Math.round((floorsTotal * (k + 1)) / tiers) - Math.round((floorsTotal * k) / tiers);
        const inset = 0.44 - k * 0.08;
        const z1 = z + f * FH;
        parts.push({ u0: -inset, v0: -inset, u1: inset, v1: inset, z0: z, z1, color: k % 2 ? shade(color, 1.05) : color, floors: f, top: k < tiers - 1 });
        z = z1;
      }
      return { parts, main: parts[parts.length - 1] };
    }
    case 'courtyard': {
      const m = 0.42;
      const t = 0.16;
      const back = { u0: -m, v0: -m, u1: m, v1: -m + t, z0: 0, z1: H, color, top: true };
      const left = { u0: -m, v0: -m + t, u1: -m + t, v1: m - t, z0: 0, z1: H, color, top: true };
      const right = { u0: m - t, v0: -m + t, u1: m, v1: m - t, z0: 0, z1: H, color, top: true };
      const front = { u0: -m, v0: m - t, u1: m, v1: m, z0: 0, z1: H, color, top: true };
      return { parts: [back, left, { court: true }, right, front], main: front, noRoof: true };
    }
    case 'house': {
      const p = { u0: -0.3, v0: -0.28, u1: 0.3, v1: 0.28, z0: 0, z1: H, color };
      return { parts: [{ garden: true }, p], main: p };
    }
    default: {
      const p = { u0: -0.36, v0: -0.36, u1: 0.36, v1: 0.36, z0: 0, z1: H, color, cornice: true };
      return { parts: [p], main: p };
    }
  }
}

export function buildingHeight(b) {
  const floors = Math.min(b.floors || 1, maxFloorsFor(b.shape));
  return floors * (b.shape === 'house' ? FH * 1.35 : FH);
}

function drawTreeLocal(ctx, u, v, size, night, variant = 0) {
  const [x, y] = iso(u, v, 0);
  const trunk = night ? '#2a2320' : '#6b4a33';
  ctx.fillStyle = trunk;
  ctx.fillRect(x - 0.8, y - size * 0.55, 1.6, size * 0.55);
  const greens = ['#5f8f55', '#6f9e5c', '#4f7d4a', '#7aa36a'];
  const g = nightify(greens[variant % greens.length], night);
  if (variant % 3 === 2) {
    poly(ctx, [[x, y - size * 1.7], [x + size * 0.45, y - size * 0.45], [x - size * 0.45, y - size * 0.45]], shade(g, 0.9));
  } else {
    ctx.fillStyle = shade(g, 0.85);
    ctx.beginPath();
    ctx.arc(x + size * 0.12, y - size * 0.95, size * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x - size * 0.08, y - size * 1.05, size * 0.44, 0, Math.PI * 2);
    ctx.fill();
  }
}
export { drawTreeLocal as drawTree };

function drawRoof(ctx, main, style, roofColor, accent, night, rand) {
  const { u0, v0, u1, v1, z1 } = main;
  const rc = nightify(roofColor, night);
  const top = shade(rc, 1.05);
  const w = Math.min(u1 - u0, v1 - v0);
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  switch (style) {
    case 'sloped': {
      const hr = w * 26;
      const vm = cv;
      poly(ctx, [iso(u0, v0, z1), iso(u1, v0, z1), iso(u1, vm, z1 + hr), iso(u0, vm, z1 + hr)], shade(rc, 0.8));
      poly(ctx, [iso(u0, vm, z1 + hr), iso(u1, vm, z1 + hr), iso(u1, v1, z1), iso(u0, v1, z1)], shade(rc, 1.0));
      poly(ctx, [iso(u1, v0, z1), iso(u1, v1, z1), iso(u1, vm, z1 + hr)], shade(nightify(accent, night), 0.78));
      // cheminée
      box(ctx, { u0: u0 + 0.08, v0: v0 + 0.06, u1: u0 + 0.16, v1: v0 + 0.14, z0: z1, z1: z1 + hr * 0.9 }, faceColors('#8a5a44', night));
      return;
    }
    case 'terrace': {
      diamond(ctx, u0, v0, u1, v1, z1, shade(nightify('#7aa36a', night), 1));
      diamond(ctx, u0 + 0.04, v0 + 0.04, u1 - 0.04, v1 - 0.04, z1, shade(nightify('#8fb77a', night), 1));
      drawTreeLocalAt(ctx, u0 + 0.1, v0 + 0.1, z1, 7, night, 0);
      drawTreeLocalAt(ctx, u1 - 0.12, v0 + 0.14, z1, 6, night, 1);
      // parasol
      const [px, py] = iso(cu + 0.05, cv + 0.08, z1);
      ctx.fillStyle = '#ddd';
      ctx.fillRect(px - 0.4, py - 8, 0.8, 8);
      ctx.fillStyle = nightify(accent, night);
      ctx.beginPath();
      ctx.ellipse(px, py - 8, 7, 3, 0, Math.PI, 0);
      ctx.fill();
      return;
    }
    case 'spire': {
      diamond(ctx, u0, v0, u1, v1, z1, top);
      const s = w * 0.28;
      box(ctx, { u0: cu - s, v0: cv - s, u1: cu + s, v1: cv + s, z0: z1, z1: z1 + 8 }, faceColors(accent, night));
      const h = 26 + w * 30;
      const apex = iso(cu, cv, z1 + 8 + h);
      poly(ctx, [iso(cu - s, cv + s, z1 + 8), iso(cu + s, cv + s, z1 + 8), apex], shade(rc, 1.0));
      poly(ctx, [iso(cu + s, cv + s, z1 + 8), iso(cu + s, cv - s, z1 + 8), apex], shade(rc, 0.75));
      ctx.fillStyle = night ? '#ff5a4a' : '#c0392b';
      ctx.beginPath();
      ctx.arc(apex[0], apex[1] - 1, 1.3, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case 'dome': {
      diamond(ctx, u0, v0, u1, v1, z1, top);
      const [cx, cy] = iso(cu, cv, z1);
      const rx = w * 32 * 0.62;
      const g = ctx.createRadialGradient(cx - rx * 0.35, cy - rx * 0.7, 1, cx, cy - rx * 0.3, rx * 1.1);
      g.addColorStop(0, shade(rc, 1.35));
      g.addColorStop(1, shade(rc, 0.7));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, rx / 2, 0, 0, Math.PI);
      ctx.ellipse(cx, cy, rx, rx * 0.95, 0, 0, Math.PI, true);
      ctx.fill();
      ctx.fillStyle = shade(nightify(accent, night), 1);
      ctx.fillRect(cx - 0.6, cy - rx * 0.95 - 7, 1.2, 7);
      return;
    }
    case 'helipad': {
      diamond(ctx, u0, v0, u1, v1, z1, shade(nightify('#3a3f44', night), 1));
      withTop(ctx, z1, () => {
        const r = w * 0.36;
        ctx.strokeStyle = night ? '#e9d36c' : '#f2c94c';
        ctx.lineWidth = 0.035;
        ctx.beginPath();
        ctx.arc(cu, cv, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#f3f1ec';
        const k = r * 0.5;
        ctx.fillRect(cu - k, cv - k, k * 0.28, k * 2);
        ctx.fillRect(cu + k * 0.72, cv - k, k * 0.28, k * 2);
        ctx.fillRect(cu - k, cv - k * 0.14, k * 2, k * 0.28);
      });
      if (night) {
        for (const [a, b] of [[u0 + 0.03, v1 - 0.03], [u1 - 0.03, v1 - 0.03], [u1 - 0.03, v0 + 0.03]]) {
          const [x, y] = iso(a, b, z1);
          ctx.fillStyle = '#ff6a5a';
          ctx.beginPath();
          ctx.arc(x, y - 1, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }
    default: {
      // toit plat : acrotère + équipements techniques
      diamond(ctx, u0, v0, u1, v1, z1, top);
      diamond(ctx, u0 + 0.03, v0 + 0.03, u1 - 0.03, v1 - 0.03, z1, shade(rc, 0.92));
      if (w > 0.3) {
        const a = u0 + 0.08 + rand() * (u1 - u0 - 0.3);
        const b = v0 + 0.08 + rand() * (v1 - v0 - 0.3);
        box(ctx, { u0: a, v0: b, u1: a + 0.12, v1: b + 0.1, z0: z1, z1: z1 + 4 }, faceColors('#9aa1a6', night));
      }
    }
  }
}

function drawTreeLocalAt(ctx, u, v, z, size, night, variant) {
  ctx.save();
  ctx.translate(0, -z);
  drawTreeLocal(ctx, u, v, size, night, variant);
  ctx.restore();
}

// ------------------------------------------------------------------ enseignes
function fitText(ctx, text, maxW, maxH, weight = 700) {
  let size = Math.min(maxH, 9);
  ctx.font = `${weight} ${size}px 'DM Sans', system-ui, sans-serif`;
  while (size > 2.5 && ctx.measureText(text).width > maxW) {
    size -= 0.5;
    ctx.font = `${weight} ${size}px 'DM Sans', system-ui, sans-serif`;
  }
  return size;
}

// Dessine le panneau d'enseigne (logo ou nom) sur une face visible, ou sur le toit si l'immeuble est bas.
function drawSign(ctx, main, side, brand, logoImg, accent, night) {
  if (!brand && !logoImg) return;
  const onLeft = side === 'left';
  const a0 = onLeft ? main.u0 : -main.v1;
  const a1 = onLeft ? main.u1 : -main.v0;
  const W = a1 - a0;
  const faceH = main.z1 - main.z0;
  const plateW = Math.min(W * 0.78, logoImg ? 0.42 : 0.7);
  const plateHpx = logoImg ? plateW * 34 : Math.max(8, Math.min(12, plateW * 18));
  const onRoof = faceH < plateHpx + FH * 1.5;
  const zTop = onRoof ? main.z1 + plateHpx + 5 : main.z1 - 4;
  const x = a0 + (W - plateW) / 2;
  const y = -zTop;
  const fn = () => {
    if (onRoof) {
      ctx.fillStyle = night ? '#333' : '#555';
      ctx.fillRect(x + plateW * 0.2, y + plateHpx, 0.02, 5);
      ctx.fillRect(x + plateW * 0.8, y + plateHpx, 0.02, 5);
    }
    ctx.fillStyle = logoImg ? '#ffffff' : nightify(accent, night && !brand);
    ctx.fillRect(x, y, plateW, plateHpx);
    if (logoImg) {
      const ratio = logoImg.naturalWidth / logoImg.naturalHeight || 1;
      let w = plateW * 0.9;
      let h = w * 34 * (1 / ratio) * 0.95;
      if (h > plateHpx * 0.9) {
        h = plateHpx * 0.9;
        w = (h * ratio) / 34;
      }
      ctx.drawImage(logoImg, x + (plateW - w) / 2, y + (plateHpx - h) / 2, w, h);
      if (night) {
        ctx.fillStyle = 'rgba(255,240,200,0.12)';
        ctx.fillRect(x, y, plateW, plateHpx);
      }
    } else {
      // Texte : on revient dans un repère non déformé horizontalement pour garder des lettres lisibles.
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1 / 32, 1);
      const maxW = plateW * 32 - 3;
      const size = fitText(ctx, brand, maxW, plateHpx - 3);
      ctx.fillStyle = contrastInk(accent);
      if (night) ctx.fillStyle = '#fff4d6';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(brand, (plateW * 32) / 2, plateHpx / 2 + 0.5, maxW);
      ctx.restore();
      void size;
    }
  };
  if (onLeft) withLeftFace(ctx, main.v1, fn);
  else withRightFace(ctx, main.u1, fn);
}

export function contrastInk(hex) {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#161a17' : '#ffffff';
}

// ------------------------------------------------------------------ immeuble complet
// b : { floors, shape, roofStyle, windows, color, roofColor, accentColor, brandName }
// opts : { front: 'left'|'right', night, seed, logo: HTMLImageElement|null }
export function drawBuilding(ctx, b, opts = {}) {
  const night = Boolean(opts.night);
  const rand = mulberry32(opts.seed ?? hashString(JSON.stringify(b)));
  const H = buildingHeight(b);
  const floorH = b.shape === 'house' ? FH * 1.35 : FH;
  const color = b.color || '#47767b';
  const accent = b.accentColor || '#d9cbb2';
  const { parts, main, noRoof, flatTops } = shapeParts(b.shape, H, { color, accent });
  const mirrored = opts.front === 'right';

  // Ombre portée au sol
  ctx.save();
  ctx.globalAlpha = night ? 0.25 : 0.18;
  diamond(ctx, -0.46, -0.46, 0.5, 0.5, 0, '#0b0f0d');
  ctx.restore();

  ctx.save();
  if (mirrored) ctx.scale(-1, 1);
  for (const p of parts) {
    if (p.garden) {
      diamond(ctx, -0.46, -0.46, 0.46, 0.46, 0, nightify('#8fb77a', night));
      drawTreeLocal(ctx, 0.36, -0.36, 9, night, 1);
      drawTreeLocal(ctx, -0.4, -0.1, 7, night, 2);
      continue;
    }
    if (p.court) {
      diamond(ctx, -0.26, -0.26, 0.26, 0.26, 0, nightify('#8fb77a', night));
      drawTreeLocal(ctx, 0, 0, 8, night, 0);
      continue;
    }
    const fc = faceColors(p.color, night);
    const flatTop = p.top || noRoof || (flatTops && flatTops.includes(p));
    box(ctx, p, { left: fc.left, right: fc.right, top: flatTop ? shade(nightify(b.roofColor || '#6b3f2a', night), 1.05) : null, edge: fc.edge });
    if (!p.plain) {
      const floors = p.floors ?? Math.max(1, Math.round((p.z1 - p.z0) / floorH));
      const fh = (p.z1 - p.z0) / floors;
      withLeftFace(ctx, p.v1, () => drawWindows(ctx, 'left', p.u0, p.u1, p.z0, p.z1, floors, b.windows, color, night, rand, fh));
      withRightFace(ctx, p.u1, () => drawWindows(ctx, 'right', -p.v1, -p.v0, p.z0, p.z1, floors, b.windows, color, night, rand, fh));
    }
    if (p.cornice) {
      box(ctx, { u0: p.u0 - 0.02, v0: p.v0 - 0.02, u1: p.u1 + 0.02, v1: p.v1 + 0.02, z0: p.z1 - 2.5, z1: p.z1 }, faceColors(accent, night));
    }
  }
  // Porte d'entrée et auvent sur la face avant
  const entry = parts.find((p) => p.z0 === 0 && !p.plain && !p.garden && !p.court && p.v1 !== undefined && (b.shape !== 'porch' || p === main));
  if (entry && b.shape !== 'courtyard') {
    withLeftFace(ctx, entry.v1, () => {
      const cu = (entry.u0 + entry.u1) / 2;
      const dh = Math.min(floorH * 0.85, 7);
      ctx.fillStyle = nightify(shade(accent, 0.55), night);
      ctx.fillRect(cu - 0.06, -dh, 0.12, dh);
      if (night) {
        ctx.fillStyle = 'rgba(255,217,143,0.8)';
        ctx.fillRect(cu - 0.05, -dh + 1, 0.1, dh - 1);
      }
      if (b.shape !== 'house' && b.shape !== 'porch') {
        ctx.fillStyle = nightify(accent, night);
        ctx.fillRect(entry.u0 + 0.04, -floorH - 0.5, entry.u1 - entry.u0 - 0.08, 1.6);
      }
    });
  }
  if (!noRoof) drawRoof(ctx, main, b.roofStyle, b.roofColor || '#6b3f2a', accent, night, rand);
  if (noRoof && (b.roofStyle === 'terrace')) drawTreeLocalAt(ctx, 0.3, 0.3, main.z1, 6, night, 1);
  ctx.restore();

  // Enseigne (jamais en miroir pour garder le texte lisible)
  const signMain = mirrored ? { ...main, u0: main.v0, u1: main.v1, v0: main.u0, v1: main.u1 } : main;
  drawSign(ctx, signMain, opts.front === 'right' ? 'right' : 'left', b.brandName, opts.logo, accent, night);
}

// ------------------------------------------------------------------ panneau publicitaire
export function drawBillboard(ctx, ad, { night, logo, time = 0, locked = false }) {
  const pole = nightify('#5b6166', night);
  ctx.save();
  ctx.globalAlpha = 0.18;
  diamond(ctx, -0.3, -0.1, 0.4, 0.3, 0, '#0b0f0d');
  ctx.restore();
  // deux pieds
  box(ctx, { u0: -0.3, v0: 0.05, u1: -0.26, v1: 0.09, z0: 0, z1: 26 }, faceColors('#6b7176', night));
  box(ctx, { u0: 0.26, v0: 0.05, u1: 0.3, v1: 0.09, z0: 0, z1: 26 }, faceColors('#6b7176', night));
  // cadre
  box(ctx, { u0: -0.46, v0: 0.02, u1: 0.46, v1: 0.07, z0: 24, z1: 56 }, { left: pole, right: shade(pole, 0.8), top: shade(pole, 1.1) });
  withLeftFace(ctx, 0.07, () => {
    const x = -0.43;
    const y = -54;
    const w = 0.86;
    const h = 28;
    if (!ad) {
      ctx.fillStyle = locked ? nightify('#8a8f93', night) : nightify('#f3f1ec', night);
      ctx.fillRect(x, y, w, h);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1 / 32, 1);
      ctx.fillStyle = locked ? '#555' : '#1f5f4e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = "700 6.5px 'DM Sans', sans-serif";
      ctx.fillText(locked ? 'BIENTÔT' : 'VOTRE PUB', (w * 32) / 2, h / 2 - 4);
      ctx.fillText(locked ? 'DISPONIBLE' : 'ICI', (w * 32) / 2, h / 2 + 4);
      ctx.restore();
    } else {
      ctx.fillStyle = ad.color || '#1f2a44';
      ctx.fillRect(x, y, w, h);
      if (logo) {
        const ratio = logo.naturalWidth / logo.naturalHeight || 1;
        let iw = w;
        let ih = (iw * 32) / ratio / 1.12;
        if (ih > h) {
          ih = h;
          iw = (ih * ratio * 1.12) / 32;
        }
        ctx.drawImage(logo, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
      }
      if (!logo || ad.message) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1 / 32, 1);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const W = w * 32 - 4;
        if (!logo) {
          ctx.fillStyle = contrastInk(ad.color || '#1f2a44');
          fitText(ctx, ad.brandName || '', W, 11, 800);
          ctx.fillText(ad.brandName || '', (w * 32) / 2, ad.message ? h / 2 - 5 : h / 2, W);
        }
        if (ad.message) {
          ctx.fillStyle = logo ? 'rgba(0,0,0,.55)' : contrastInk(ad.color || '#1f2a44');
          if (logo) ctx.fillRect(0, h - 8, w * 32, 8);
          if (logo) ctx.fillStyle = '#fff';
          fitText(ctx, ad.message, W, 5.5, 500);
          ctx.fillText(ad.message, (w * 32) / 2, logo ? h - 4 : h / 2 + 6, W);
        }
        ctx.restore();
      }
    }
    if (night) {
      // Éclairage des spots
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, 'rgba(255,240,200,0.28)');
      g.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    }
  });
  void time;
}

// ------------------------------------------------------------------ monuments (îlot 4×4, origine = centre de l'îlot)
export function drawLandmark(ctx, id, { night, time }) {
  const N = night;
  const paved = nightify('#d8d0c0', N);
  switch (id) {
    case 'townhall': {
      diamond(ctx, -2, -2, 2, 2, 0, paved);
      diamond(ctx, -1.95, 1.3, 1.95, 1.95, 0, nightify('#9dbb87', N));
      const body = { u0: -1.6, v0: -1.2, u1: 1.6, v1: 1.1, z0: 0, z1: 30 };
      box(ctx, body, faceColors('#e8dcc4', N));
      withLeftFace(ctx, body.v1, () => drawWindows(ctx, 'left', body.u0, body.u1, 0, 30, 3, 'arched', '#e8dcc4', N, mulberry32(7), 10));
      withRightFace(ctx, body.u1, () => drawWindows(ctx, 'right', -body.v1, -body.v0, 0, 30, 3, 'arched', '#e8dcc4', N, mulberry32(8), 10));
      drawRoof(ctx, body, 'sloped', '#4b5563', '#e8dcc4', N, mulberry32(1));
      const tower = { u0: -0.35, v0: -0.35, u1: 0.35, v1: 0.35, z0: 30, z1: 78 };
      // la tour s'élève au centre, devant le toit
      box(ctx, { ...tower, v0: 0.4, v1: 1.1, z0: 0 }, faceColors('#efe5cf', N));
      const t2 = { u0: -0.35, v0: 0.4, u1: 0.35, v1: 1.1, z0: 0, z1: 78 };
      withLeftFace(ctx, t2.v1, () => {
        ctx.fillStyle = nightify('#f7f2e6', N);
        ctx.beginPath();
        ctx.ellipse(0, -62, 0.2, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.6;
        const now = new Date();
        const hA = ((now.getHours() % 12) / 12) * Math.PI * 2;
        const mA = (now.getMinutes() / 60) * Math.PI * 2;
        ctx.save();
        ctx.translate(0, -62);
        ctx.scale(1 / 32, 1);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.sin(hA) * 3.6, -Math.cos(hA) * 3.6);
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.sin(mA) * 5.5, -Math.cos(mA) * 5.5);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = nightify('#6b4a33', N);
        ctx.fillRect(-0.12, -14, 0.24, 14);
      });
      drawRoof(ctx, t2, 'dome', '#5f9e8f', '#c9a227', N, mulberry32(2));
      // drapeau
      const [fx, fy] = iso(0, 0.75, 78 + 26);
      ctx.fillStyle = '#444';
      ctx.fillRect(fx - 0.4, fy - 18, 0.8, 18);
      const wave = Math.sin(time / 400) * 1.5;
      poly(ctx, [[fx, fy - 18], [fx + 12, fy - 16 + wave], [fx, fy - 12]], '#86e3c8');
      for (const [u, v] of [[-1.7, 1.6], [1.7, 1.6], [-0.9, 1.7], [0.9, 1.7]]) drawTreeLocal(ctx, u, v, 9, N, 0);
      return;
    }
    case 'plaza': {
      diamond(ctx, -2, -2, 2, 2, 0, paved);
      withTop(ctx, 0, () => {
        ctx.strokeStyle = nightify('#c7bca8', N);
        ctx.lineWidth = 0.03;
        for (let r = 0.6; r < 2; r += 0.35) {
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
      // bassin
      const [cx, cy] = iso(0, 0, 0);
      ctx.fillStyle = nightify('#bfb4a0', N);
      ctx.beginPath();
      ctx.ellipse(cx, cy, 44, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = nightify('#9a8f7c', N);
      ctx.beginPath();
      ctx.ellipse(cx, cy + 3, 44, 22, 0, 0, Math.PI);
      ctx.fill();
      const water = ctx.createRadialGradient(cx, cy, 4, cx, cy, 40);
      water.addColorStop(0, nightify('#8fd0e0', N));
      water.addColorStop(1, nightify('#4f9bb3', N));
      ctx.fillStyle = water;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 40, 20, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const r = ((time / 40 + k * 13) % 38) + 2;
        ctx.globalAlpha = 1 - r / 40;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // colonne centrale et jet d'eau
      box(ctx, { u0: -0.12, v0: -0.12, u1: 0.12, v1: 0.12, z0: 0, z1: 18 }, faceColors('#e8dcc4', N));
      ctx.fillStyle = 'rgba(220,240,255,0.8)';
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + time / 900;
        const px = cx + Math.cos(a) * 10;
        const py = cy - 22 + Math.sin(a) * 5 + ((time / 60 + k * 7) % 14);
        ctx.beginPath();
        ctx.arc(px, py, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const [u, v] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) drawTreeLocal(ctx, u, v, 11, N, 1);
      return;
    }
    case 'station': {
      diamond(ctx, -2, -2, 2, 2, 0, paved);
      const hall = { u0: -1.8, v0: -1.1, u1: 1.8, v1: 1.1, z0: 0, z1: 20 };
      box(ctx, hall, faceColors('#c8b89a', N));
      withLeftFace(ctx, hall.v1, () => drawWindows(ctx, 'left', hall.u0, hall.u1, 0, 20, 2, 'arched', '#c8b89a', N, mulberry32(3), 10));
      // voûte vitrée
      const steps = 10;
      for (let i = 0; i < steps; i++) {
        const a0 = (i / steps) * Math.PI;
        const a1 = ((i + 1) / steps) * Math.PI;
        const va = -Math.cos(a0) * 1.1;
        const vb = -Math.cos(a1) * 1.1;
        const za = 20 + Math.sin(a0) * 26;
        const zb = 20 + Math.sin(a1) * 26;
        const light = 0.8 + 0.4 * (i / steps);
        poly(ctx, [iso(-1.8, va, za), iso(1.8, va, za), iso(1.8, vb, zb), iso(-1.8, vb, zb)], shade(nightify('#8fb8cc', N), light));
      }
      poly(ctx, Array.from({ length: steps + 1 }, (_, i) => iso(1.8, -Math.cos((i / steps) * Math.PI) * 1.1, 20 + Math.sin((i / steps) * Math.PI) * 26)), shade(nightify('#c8b89a', N), 0.8));
      const clock = { u0: 1.3, v0: 0.6, u1: 1.8, v1: 1.1, z0: 0, z1: 62 };
      box(ctx, clock, faceColors('#b3a283', N));
      withLeftFace(ctx, clock.v1, () => {
        ctx.fillStyle = N ? '#fff2c4' : '#f7f2e6';
        ctx.beginPath();
        ctx.ellipse(1.55, -50, 0.16, 5.5, 0, 0, Math.PI * 2);
        ctx.fill();
      });
      drawRoof(ctx, clock, 'spire', '#4b5563', '#c9a227', N, mulberry32(4));
      return;
    }
    case 'stadium': {
      diamond(ctx, -2, -2, 2, 2, 0, nightify('#a8b6a0', N));
      const [cx, cy] = iso(0, 0, 0);
      const rx = 82;
      const ry = 41;
      const h = 22;
      ctx.fillStyle = shade(nightify('#d9d4ca', N), 0.8);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI);
      ctx.lineTo(cx - rx, cy - h);
      ctx.ellipse(cx, cy - h, rx, ry, 0, Math.PI, 0, true);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = nightify('#e8e3d8', N);
      ctx.beginPath();
      ctx.ellipse(cx, cy - h, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = nightify('#a99be0', N);
      ctx.beginPath();
      ctx.ellipse(cx, cy - h + 2, rx - 8, ry - 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = nightify('#6fa35a', N);
      ctx.beginPath();
      ctx.ellipse(cx, cy - h + 8, rx - 26, ry - 13, 0, 0, Math.PI * 2);
      ctx.fill();
      withTop(ctx, h - 8, () => {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 0.03;
        ctx.strokeRect(-0.9, -0.55, 1.8, 1.1);
        ctx.beginPath();
        ctx.moveTo(0, -0.55);
        ctx.lineTo(0, 0.55);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, 0.2, 0, Math.PI * 2);
        ctx.stroke();
      });
      for (const [u, v] of [[-1.8, -1.8], [1.8, -1.8], [1.8, 1.8], [-1.8, 1.8]]) {
        const [x, y] = iso(u, v, 0);
        ctx.fillStyle = '#555';
        ctx.fillRect(x - 0.7, y - 58, 1.4, 58);
        ctx.fillStyle = N ? '#fffbe0' : '#ccc';
        ctx.fillRect(x - 4, y - 62, 8, 4);
        if (N) {
          ctx.fillStyle = 'rgba(255,250,210,0.12)';
          ctx.beginPath();
          ctx.moveTo(x - 4, y - 60);
          ctx.lineTo(cx - 30, cy - 10);
          ctx.lineTo(cx + 30, cy - 10);
          ctx.lineTo(x + 4, y - 60);
          ctx.fill();
        }
      }
      return;
    }
    case 'museum': {
      diamond(ctx, -2, -2, 2, 2, 0, paved);
      const body = { u0: -1.5, v0: -1.5, u1: 1.5, v1: 0.9, z0: 0, z1: 30 };
      box(ctx, body, faceColors('#efe8da', N));
      withRightFace(ctx, body.u1, () => drawWindows(ctx, 'right', -body.v1, -body.v0, 0, 30, 2, 'sparse', '#efe8da', N, mulberry32(5), 15));
      for (let i = 0; i < 7; i++) {
        const u = -1.35 + i * 0.45;
        box(ctx, { u0: u - 0.07, v0: 1.25, u1: u + 0.07, v1: 1.39, z0: 0, z1: 26 }, faceColors('#f7f2e6', N));
      }
      box(ctx, { u0: -1.55, v0: 0.9, u1: 1.55, v1: 1.45, z0: 26, z1: 30 }, faceColors('#e2d8c4', N));
      // fronton triangulaire
      poly(ctx, [iso(-1.55, 1.45, 30), iso(1.55, 1.45, 30), iso(0, 1.45, 48)], shade(nightify('#efe8da', N), 1.02));
      poly(ctx, [iso(-1.55, -1.5, 30), iso(0, -1.5, 48), iso(0, 1.45, 48), iso(-1.55, 1.45, 30)], shade(nightify('#8a939b', N), 0.9));
      poly(ctx, [iso(0, -1.5, 48), iso(1.55, -1.5, 30), iso(1.55, 1.45, 30), iso(0, 1.45, 48)], shade(nightify('#8a939b', N), 1.1));
      diamond(ctx, -1.9, 1.5, 1.9, 1.95, 0, nightify('#cfc6b3', N));
      return;
    }
    case 'wheel': {
      diamond(ctx, -2, -2, 2, 2, 0, nightify('#b89b72', N));
      withTop(ctx, 0, () => {
        ctx.strokeStyle = nightify('#a3865f', N);
        ctx.lineWidth = 0.02;
        for (let k = -2; k <= 2; k += 0.25) {
          ctx.beginPath();
          ctx.moveTo(k, -2);
          ctx.lineTo(k, 2);
          ctx.stroke();
        }
      });
      const R = 58;
      const zc = R + 10;
      withLeftFace(ctx, 0, () => {
        ctx.save();
        ctx.translate(0, -zc);
        ctx.scale(1 / 32, 1);
        ctx.strokeStyle = N ? '#9bd3ff' : '#e8e8e8';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 0.7;
        const rot = time / 9000;
        for (let i = 0; i < 16; i++) {
          const a = rot + (i / 16) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
          ctx.stroke();
        }
        const cabin = ['#e24a3b', '#f2c94c', '#86e3c8', '#7fb2e5'];
        for (let i = 0; i < 16; i++) {
          const a = rot + (i / 16) * Math.PI * 2;
          ctx.fillStyle = N ? shade(cabin[i % 4], 1.2) : cabin[i % 4];
          ctx.fillRect(Math.cos(a) * R - 3.5, Math.sin(a) * R, 7, 7);
        }
        ctx.fillStyle = '#777';
        ctx.beginPath();
        ctx.moveTo(-3, 0);
        ctx.lineTo(-30, zc);
        ctx.lineTo(-24, zc);
        ctx.lineTo(0, 4);
        ctx.lineTo(24, zc);
        ctx.lineTo(30, zc);
        ctx.lineTo(3, 0);
        ctx.fill();
        ctx.restore();
      });
      return;
    }
    case 'lighthouse': {
      diamond(ctx, -2, -2, 2, 2, 0, nightify('#c9c2b0', N));
      const [cx, cy] = iso(0.5, 0.5, 0);
      const H = 96;
      for (let i = 0; i < 6; i++) {
        const z0 = (H / 6) * i;
        const w0 = 14 - i * 0.9;
        const w1 = 14 - (i + 1) * 0.9;
        ctx.fillStyle = nightify(i % 2 ? '#f3f1ec' : '#c0392b', N);
        ctx.beginPath();
        ctx.moveTo(cx - w0, cy - z0);
        ctx.lineTo(cx + w0, cy - z0);
        ctx.lineTo(cx + w1, cy - z0 - H / 6);
        ctx.lineTo(cx - w1, cy - z0 - H / 6);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(cx, cy - H, 14, H);
      ctx.fillStyle = N ? '#fff6c4' : '#dfe9ee';
      ctx.fillRect(cx - 6, cy - H - 12, 12, 12);
      ctx.fillStyle = '#2b2f33';
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy - H - 12);
      ctx.lineTo(cx + 8, cy - H - 12);
      ctx.lineTo(cx, cy - H - 22);
      ctx.fill();
      if (N) {
        const a = time / 1500;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(cx, cy - H - 6, 2, cx, cy - H - 6, 320);
        g.addColorStop(0, 'rgba(255,245,190,0.5)');
        g.addColorStop(1, 'rgba(255,245,190,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, cy - H - 6);
        ctx.lineTo(cx + Math.cos(a - 0.12) * 320, cy - H - 6 + Math.sin(a - 0.12) * 110);
        ctx.lineTo(cx + Math.cos(a + 0.12) * 320, cy - H - 6 + Math.sin(a + 0.12) * 110);
        ctx.fill();
        ctx.restore();
      }
      box(ctx, { u0: -1.6, v0: -1.4, u1: -0.6, v1: -0.6, z0: 0, z1: 14 }, faceColors('#e8dcc4', N));
      drawRoof(ctx, { u0: -1.6, v0: -1.4, u1: -0.6, v1: -0.6, z0: 0, z1: 14 }, 'sloped', '#a8322d', '#e8dcc4', N, mulberry32(6));
      return;
    }
    default:
  }
}

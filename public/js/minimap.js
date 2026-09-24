// Mini-carte vue du dessus, avec le cadre de la vue courante. Clic = déplacement.

import { T } from './shared/citygen.js';
import { state, plotState, districtInfo } from './state.js';

export function createMinimap(canvas, renderer) {
  const city = state.city;
  const S = city.size;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = canvas.clientWidth || 180;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const base = document.createElement('canvas');
  base.width = S;
  base.height = S;
  let dirty = true;

  function paintBase() {
    const g = base.getContext('2d');
    const lotByPos = new Map(city.lots.map((l) => [l.y * S + l.x, l]));
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const t = city.tiles[i];
        let c = '#a9c093';
        if (t === T.ROAD || t === T.QUAY) c = '#6b7277';
        else if (t === T.AVENUE) c = '#50575c';
        else if (t === T.WATER) c = '#5b9bb5';
        else if (t === T.PARK || t === T.GARDEN) c = '#8fb07a';
        else if (t === T.LANDMARK) c = '#e8dcc4';
        else if (t === T.BILLBOARD) c = state.billboards.get(city.billboards.find((b) => b.x === x && b.y === y)?.number)?.status === 'rented' ? '#f2c94c' : '#d3cec2';
        else if (t === T.LOT) {
          const lot = lotByPos.get(i);
          const p = plotState(lot.number);
          const d = districtInfo(lot.district);
          c = p.status === 'owned' ? p.building?.color || '#47767b' : p.status === 'reserved' ? '#f2c94c' : d?.unlocked ? '#d7e2cc' : '#b9ae93';
        }
        g.fillStyle = c;
        g.fillRect(x, y, 1, 1);
      }
    }
    dirty = false;
  }

  function draw() {
    if (dirty) paintBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    // Rotation de 45° pour correspondre à la vue isométrique (et à la rotation choisie)
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 4 + (renderer.cam.rot * Math.PI) / 2);
    const k = (canvas.width / S) * 0.7;
    ctx.scale(k, k);
    ctx.translate(-S / 2, -S / 2);
    ctx.drawImage(base, 0, 0);
    const poly = renderer.viewportPolygon();
    ctx.strokeStyle = '#86e3c8';
    ctx.lineWidth = 2 / k;
    ctx.beginPath();
    poly.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = 'rgba(134,227,200,0.12)';
    ctx.fill();
    if (state.selection?.type === 'plot') {
      const lot = city.lots[state.selection.number - 1];
      ctx.fillStyle = '#e24a3b';
      ctx.beginPath();
      ctx.arc(lot.x + 0.5, lot.y + 0.5, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function toWorld(px, py) {
    const k = (canvas.width / S) * 0.7;
    let x = (px * dpr - canvas.width / 2) / k;
    let y = (py * dpr - canvas.height / 2) / k;
    const a = -(Math.PI / 4 + (renderer.cam.rot * Math.PI) / 2);
    [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
    return [x + S / 2, y + S / 2];
  }

  let dragging = false;
  const move = (e) => {
    const r = canvas.getBoundingClientRect();
    const [u, v] = toWorld(e.clientX - r.left, e.clientY - r.top);
    renderer.centerOn(Math.max(0, Math.min(S, u)), Math.max(0, Math.min(S, v)), renderer.cam.zoom, { animate: !dragging });
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    move(e);
    dragging = true;
  });
  canvas.addEventListener('pointermove', (e) => dragging && move(e));
  canvas.addEventListener('pointerup', () => (dragging = false));

  setInterval(draw, 120);
  return { invalidate: () => (dirty = true), draw };
}

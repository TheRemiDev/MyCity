// Circulation : voitures sur le réseau routier et bateaux dans la baie.

import { mulberry32 } from './shared/citygen.js';

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const CAR_COLORS = ['#e24a3b', '#f3f1ec', '#2b2f33', '#7fb2e5', '#f2c94c', '#47767b', '#a99be0', '#c9c2b0', '#1f2a44', '#86e3c8'];

export function createTraffic(city, { cars = 160, boats = 7, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const roads = [];
  for (let y = 0; y < city.size; y++) for (let x = 0; x < city.size; x++) if (city.isRoad(x, y)) roads.push([x, y]);

  const list = [];
  for (let i = 0; i < cars; i++) {
    const [x, y] = roads[Math.floor(rand() * roads.length)];
    const options = DIRS.filter(([dx, dy]) => city.isRoad(x + dx, y + dy));
    const dir = options[Math.floor(rand() * options.length)] || [1, 0];
    list.push({
      tx: x,
      ty: y,
      dir,
      progress: rand(),
      speed: 1.1 + rand() * 1.2, // tuiles par seconde
      color: CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)],
      kind: rand() < 0.08 ? 'bus' : rand() < 0.1 ? 'taxi' : 'car',
      u: x + 0.5,
      v: y + 0.5,
    });
  }

  const waterRows = [];
  for (let y = 0; y < city.size; y++) if (city.tiles[city.idx(0, y)] === 6) waterRows.push(y);
  const boatList = Array.from({ length: waterRows.length ? boats : 0 }, (_, i) => ({
    u: rand() * city.size,
    v: waterRows[1 + Math.floor(rand() * Math.max(1, waterRows.length - 2))] + 0.5,
    speed: (0.25 + rand() * 0.35) * (i % 2 ? 1 : -1),
    sail: ['#f3f1ec', '#e24a3b', '#f2c94c', '#86e3c8'][i % 4],
  }));

  function nextDir(car) {
    const [dx, dy] = car.dir;
    const options = DIRS.filter(([ox, oy]) => !(ox === -dx && oy === -dy) && city.isRoad(car.tx + ox, car.ty + oy));
    if (!options.length) return [-dx, -dy];
    const straight = options.find(([ox, oy]) => ox === dx && oy === dy);
    if (straight && rand() < 0.62) return straight;
    return options[Math.floor(rand() * options.length)];
  }

  function update(dt) {
    const step = Math.min(dt, 0.1);
    for (const car of list) {
      car.progress += car.speed * step * (car.kind === 'bus' ? 0.7 : 1);
      while (car.progress >= 1) {
        car.progress -= 1;
        car.tx += car.dir[0];
        car.ty += car.dir[1];
        if (!city.isRoad(car.tx + car.dir[0], car.ty + car.dir[1]) || isIntersection(car.tx, car.ty)) car.dir = nextDir(car);
      }
      const [dx, dy] = car.dir;
      // Circulation à droite : décalage perpendiculaire au sens de marche.
      const off = 0.2;
      car.u = car.tx + 0.5 + dx * car.progress - dy * off;
      car.v = car.ty + 0.5 + dy * car.progress + dx * off;
    }
    for (const b of boatList) {
      b.u += b.speed * step;
      if (b.u > city.size + 2) b.u = -2;
      if (b.u < -2) b.u = city.size + 2;
    }
  }

  function isIntersection(x, y) {
    let n = 0;
    for (const [dx, dy] of DIRS) if (city.isRoad(x + dx, y + dy)) n++;
    return n > 2;
  }

  return { cars: list, boats: boatList, update };
}

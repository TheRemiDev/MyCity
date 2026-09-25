import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCity, T, SIZE } from '../public/js/shared/citygen.js';
import { DISTRICTS, billboardPriceCents, plotPriceCents, upgradePriceCents, normalizeHex, maxFloorsFor } from '../public/js/shared/catalog.js';
import { validateDesign, cleanWebsite, cleanText, decodeImage } from '../src/services/validation.js';
import { flatten } from '../src/services/payments.js';

test('la ville est déterministe', () => {
  const a = generateCity(1337);
  const b = generateCity(1337);
  assert.deepEqual(a.lots, b.lots);
  assert.deepEqual([...a.tiles], [...b.tiles]);
  assert.notDeepEqual([...generateCity(42).decor], [...a.decor]);
});

test('chaque terrain touche une rue et a un numéro unique', () => {
  const city = generateCity(1337);
  const numbers = new Set(city.lots.map((l) => l.number));
  assert.equal(numbers.size, city.lots.length);
  assert.ok(city.lots.length > 1000);
  for (const lot of city.lots) {
    const nearRoad = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => city.isRoad(lot.x + dx, lot.y + dy));
    assert.ok(nearRoad, `terrain #${lot.number} enclavé`);
    assert.equal(city.tiles[city.idx(lot.x, lot.y)], T.LOT);
  }
  assert.equal(city.lots[0].district, 'centre', 'le n°1 est au centre-ville');
  assert.equal(city.size, SIZE);
  for (const d of DISTRICTS) assert.ok(city.lots.some((l) => l.district === d.id), `quartier ${d.id} vide`);
});

test('tarifs', () => {
  const centre = DISTRICTS[0];
  assert.equal(plotPriceCents(centre, 4), centre.basePriceCents + 400);
  assert.equal(upgradePriceCents(4, 10), 600);
  assert.equal(upgradePriceCents(10, 4), 0);
  assert.equal(billboardPriceCents(centre, 12), Math.round(centre.billboardMonthCents * 12 * 0.75));
  assert.equal(billboardPriceCents(centre, 5), null);
});

test('validation du design', () => {
  assert.equal(validateDesign({ floors: 60, shape: 'tower' }).floors, 60);
  assert.throws(() => validateDesign({ floors: 61, shape: 'tower' }));
  assert.throws(() => validateDesign({ floors: 4, shape: 'house' }));
  assert.throws(() => validateDesign({ shape: 'pyramid' }));
  assert.throws(() => validateDesign({ floors: 2.5 }));
  assert.equal(validateDesign({ color: '#ABC' }).color, '#aabbcc');
  assert.equal(maxFloorsFor('house'), 3);
  assert.equal(normalizeHex('nope', '#000000'), '#000000');
});

test('nettoyage des textes et liens', () => {
  assert.equal(cleanText('  a‮b\u0000  c ', 10), 'a b c');
  assert.throws(() => cleanText('x'.repeat(11), 10));
  assert.equal(cleanWebsite('exemple.fr'), 'https://exemple.fr/');
  assert.throws(() => cleanWebsite('javascript:alert(1)'));
  assert.throws(() => cleanWebsite('https://user:pass@exemple.fr'));
  assert.throws(() => cleanWebsite('http://localhost'));
});

test('images : type déterminé par les octets', () => {
  const png = 'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal(decodeImage(png).mime, 'image/png');
  assert.throws(() => decodeImage('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')));
  assert.throws(() => decodeImage('data:image/png;base64,' + Buffer.alloc(300 * 1024, 1).toString('base64')));
});

test('encodage des paramètres Stripe', () => {
  assert.deepEqual(flatten({ a: 1, b: { c: 'x' }, d: [{ e: 2 }] }), { a: '1', 'b[c]': 'x', 'd[0][e]': '2' });
});

test('confiance envers les proxys : Cloudflare et réseaux privés uniquement', async () => {
  const { parseTrustProxy } = await import('../src/config.js');
  const express = (await import('express')).default;
  const app = express();
  app.set('trust proxy', parseTrustProxy('cloudflare'));
  const trusted = app.get('trust proxy fn');
  assert.equal(trusted('188.114.96.5', 0), true, 'IP Cloudflare');
  assert.equal(trusted('172.18.0.3', 0), true, 'proxy Docker');
  assert.equal(trusted('127.0.0.1', 0), true);
  assert.equal(trusted('8.8.8.8', 0), false, "une IP publique quelconque ne peut pas usurper l'adresse du visiteur");
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('1'), 1);
});

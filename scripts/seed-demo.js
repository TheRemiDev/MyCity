// Peuple la ville avec des habitants et des immeubles fictifs (démonstration / captures d'écran).
// Usage : npm run seed:demo -- --yes [--count 180]
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase, transaction } from '../src/db.js';
import { PALETTE, ROOF_COLORS, ROOF_STYLES, SHAPES, WINDOW_STYLES, maxFloorsFor } from '../public/js/shared/catalog.js';
import { mulberry32 } from '../public/js/shared/citygen.js';

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
  console.error('Ce script ajoute des données fictives. Relancez avec --yes pour confirmer.');
  process.exit(1);
}
const count = Number(args[args.indexOf('--count') + 1]) || 180;
const config = loadConfig();
const db = openDatabase(config);
const rand = mulberry32(2026);
const pick = (list) => list[Math.floor(rand() * list.length)];

const NAMES = ['camille', 'lucas', 'ines', 'hugo', 'lea', 'nathan', 'chloe', 'yanis', 'manon', 'theo', 'sarah', 'adam', 'jade', 'louis', 'emma', 'noah'];
const BRANDS = [
  'Boulangerie Lune', 'Café Mistral', 'Studio Pixel', 'Librairie Plume', 'Atelier Brique', 'Nova Tech', 'Maison Sauge', 'Le Petit Bistrot',
  'Vélo Rapide', 'Cinéma Aurore', 'Pharmacie du Port', 'Galerie Ocre', 'Fleurs & Co', 'Banque Horizon', 'Hôtel Azur', 'Épicerie Fine',
  'Salle Olympe', 'Radio Onde', 'Crèche Soleil', 'Imprimerie 42', 'Pizzeria Vesuvio', 'Coworking Ruche', 'Brasserie du Quai', 'Opticien Clair',
  'Glacier Polaire', 'Agence Boréale', 'Théâtre Rouge', 'Menuiserie Chêne', 'Sushi Kaze', 'Labo Vert', 'Club Échecs', 'Mode Indigo',
];

const now = Date.now();
const hash = `scrypt$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(64).toString('base64')}`; // comptes non connectables
transaction(db, () => {
  const users = NAMES.map((name) => {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
    if (existing) return existing.id;
    return Number(
      db.prepare("INSERT INTO users (email, username, password_hash, role, created_at, bio) VALUES (?, ?, ?, 'user', ?, ?)")
        .run(`${name}@demo.mycity.local`, name, hash, now - Math.floor(rand() * 60) * 86400_000, 'Habitant de démonstration.').lastInsertRowid,
    );
  });
  const free = db.prepare("SELECT number, district FROM plots WHERE status = 'free' AND district IN ('centre', 'tilleuls', 'affaires', 'docks') ORDER BY number").all();
  let built = 0;
  for (const plot of free) {
    if (built >= count) break;
    if (rand() > (plot.district === 'centre' ? 0.75 : 0.35)) continue;
    const shape = plot.district === 'tilleuls' && rand() < 0.4 ? 'house' : pick(SHAPES).id;
    const tall = plot.district === 'affaires' ? 0.6 : plot.district === 'centre' ? 0.35 : 0.15;
    const max = maxFloorsFor(shape);
    const floors = Math.max(1, Math.min(max, Math.round(rand() < tall ? max * (0.5 + rand() * 0.5) : 2 + rand() * 10)));
    const windows = plot.district === 'affaires' && rand() < 0.6 ? 'glass' : pick(WINDOW_STYLES).id;
    db.prepare(
      `UPDATE plots SET status = 'owned', owner_id = ?, purchased_at = ?, price_paid_cents = 0, floors = ?, shape = ?, roof_style = ?, windows = ?,
       color = ?, roof_color = ?, accent_color = ?, brand_name = ?, description = ?, website = '', updated_at = ? WHERE number = ?`,
    ).run(pick(users), now - Math.floor(rand() * 30 * 86400_000), floors, shape, pick(ROOF_STYLES).id, windows, pick(PALETTE).color, pick(ROOF_COLORS).color, pick(PALETTE).color, rand() < 0.7 ? pick(BRANDS) : '', 'Immeuble de démonstration.', now, plot.number);
    for (const u of users) if (rand() < 0.08) db.prepare('INSERT OR IGNORE INTO likes (user_id, plot_number, created_at) VALUES (?, ?, ?)').run(u, plot.number, now);
    built++;
  }
  const boards = db.prepare("SELECT number FROM billboards WHERE status = 'free' AND district IN ('centre', 'tilleuls') LIMIT 6").all();
  for (const b of boards) {
    db.prepare("UPDATE billboards SET status = 'rented', renter_id = ?, rented_until = ?, brand_name = ?, message = ?, color = ?, updated_at = ? WHERE number = ?")
      .run(pick(users), now + 30 * 86400_000, pick(BRANDS), 'Ouvert 7j/7', pick(PALETTE).color, now, b.number);
  }
  console.log(`✔ ${built} immeubles et ${boards.length} publicités de démonstration ajoutés.`);
});
db.close();

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateCity } from '../public/js/shared/citygen.js';

const MIGRATIONS = [
  // v1 — schéma initial
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    bio TEXT NOT NULL DEFAULT '',
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE plots (
    number INTEGER PRIMARY KEY,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    district TEXT NOT NULL,
    facing TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'reserved', 'owned')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reserved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reserved_until INTEGER,
    purchased_at INTEGER,
    price_paid_cents INTEGER NOT NULL DEFAULT 0,
    floors INTEGER,
    shape TEXT,
    roof_style TEXT,
    windows TEXT,
    color TEXT,
    roof_color TEXT,
    accent_color TEXT,
    brand_name TEXT,
    description TEXT,
    website TEXT,
    logo_mime TEXT,
    logo BLOB,
    updated_at INTEGER,
    UNIQUE (x, y)
  );
  CREATE INDEX plots_owner ON plots(owner_id);
  CREATE INDEX plots_status ON plots(status);

  CREATE TABLE billboards (
    number INTEGER PRIMARY KEY,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    district TEXT NOT NULL,
    facing TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'reserved', 'rented')),
    renter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reserved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reserved_until INTEGER,
    rented_until INTEGER,
    brand_name TEXT,
    message TEXT,
    website TEXT,
    color TEXT,
    image_mime TEXT,
    image BLOB,
    updated_at INTEGER,
    UNIQUE (x, y)
  );

  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('plot', 'upgrade', 'billboard')),
    target INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
    provider TEXT NOT NULL,
    provider_ref TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX orders_user ON orders(user_id);
  CREATE INDEX orders_provider_ref ON orders(provider_ref);

  CREATE TABLE likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plot_number INTEGER NOT NULL REFERENCES plots(number) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, plot_number)
  );
  CREATE INDEX likes_plot ON likes(plot_number);

  CREATE TABLE visits (
    target_type TEXT NOT NULL,
    target INTEGER NOT NULL,
    visitor TEXT NOT NULL,
    hour INTEGER NOT NULL,
    PRIMARY KEY (target_type, target, visitor, hour)
  );
  CREATE INDEX visits_hour ON visits(hour);

  CREATE TABLE guestbook (
    id INTEGER PRIMARY KEY,
    plot_number INTEGER NOT NULL REFERENCES plots(number) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX guestbook_plot ON guestbook(plot_number, created_at);

  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    target_type TEXT NOT NULL CHECK (target_type IN ('plot', 'billboard', 'message')),
    target INTEGER NOT NULL,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_type TEXT,
    target INTEGER,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_created ON events(created_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase({ dbPath, citySeed }) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seedCity(db, citySeed);
  return db;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

// Crée les terrains et panneaux à partir du générateur (idempotent : n'ajoute que ce qui manque).
function seedCity(db, seed) {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'city_seed'").get();
  if (stored && Number(stored.value) !== seed) {
    throw new Error(
      `La base a été créée avec CITY_SEED=${stored.value}. Changer la graine déplacerait tous les terrains existants.`,
    );
  }
  const city = generateCity(seed);
  transaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('city_seed', ?)").run(String(seed));
    const insertPlot = db.prepare(
      'INSERT OR IGNORE INTO plots (number, x, y, district, facing) VALUES (?, ?, ?, ?, ?)',
    );
    for (const lot of city.lots) insertPlot.run(lot.number, lot.x, lot.y, lot.district, lot.facing);
    const insertBoard = db.prepare(
      'INSERT OR IGNORE INTO billboards (number, x, y, district, facing) VALUES (?, ?, ?, ?, ?)',
    );
    for (const b of city.billboards) insertBoard.run(b.number, b.x, b.y, b.district, b.facing);
  });
}

// Transaction réentrante : un appel imbriqué utilise un SAVEPOINT.
const depth = new WeakMap();
export function transaction(db, fn) {
  const level = depth.get(db) || 0;
  const sp = `sp${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

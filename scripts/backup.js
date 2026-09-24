// Sauvegarde à chaud de la base SQLite (cohérente même pendant l'écriture) et rotation.
// Usage : node scripts/backup.js [dossier] [nombre à conserver]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const dir = process.argv[2] || path.join(path.dirname(config.dbPath), 'backups');
const keep = Number(process.argv[3]) || 14;
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(dir, `mycity-${stamp}.db`);
const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const old = fs
  .readdirSync(dir)
  .filter((f) => /^mycity-.*\.db$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) fs.unlinkSync(path.join(dir, f));
console.log(`Sauvegarde : ${target} (${old.length} ancienne(s) supprimée(s))`);

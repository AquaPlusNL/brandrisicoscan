import { backup, DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH;
const directory = process.argv[2];
if (!dbPath || !directory) {
  console.error('Gebruik: DB_PATH=/pad/naar/brandrisicoscan.db node scripts/backup.js /backupmap');
  process.exit(2);
}

const name = `brandrisicoscan-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
const target = path.join(directory, name);
const temporary = `${target}.tmp`;
const temporarySidecars = [`${temporary}-shm`, `${temporary}-wal`];
let source;
try {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  source = new DatabaseSync(dbPath, { readOnly: true });
  await backup(source, temporary);
  const snapshot = new DatabaseSync(temporary, { readOnly: true });
  try {
    if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') {
      throw new Error('SQLite quick_check mislukt');
    }
  } finally {
    snapshot.close();
  }
  for (const sidecar of temporarySidecars) {
    try { fs.unlinkSync(sidecar); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  console.log(`Backup gemaakt: ${target}`);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch { /* geen tijdelijk bestand */ }
  for (const sidecar of temporarySidecars) {
    try { fs.unlinkSync(sidecar); } catch { /* geen tijdelijk bestand */ }
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  source?.close();
}

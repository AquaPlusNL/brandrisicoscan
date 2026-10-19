import { backup, DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH;
const directory = process.argv[2];
if (!dbPath || !directory) {
  console.error('Gebruik: DB_PATH=/pad/naar/brandrisicoscan.db node scripts/backup.js /backupmap');
  process.exit(2);
}

/* Back-ups bevatten leads. Zonder opruimen blijven die bewaard tot ver na de
   bewaartermijn van 28 dagen. Een lead is hiermee na uiterlijk
   LEAD_BEWAARDAGEN + BACKUP_BEWAARDAGEN overal weg. */
const BACKUP_BEWAARDAGEN = Number(process.env.BACKUP_BEWAARDAGEN || 7);

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

  // Pas na een geslaagde back-up opruimen: mislukt hij, dan houden we de oude.
  const grens = Date.now() - BACKUP_BEWAARDAGEN * 86_400_000;
  for (const bestand of fs.readdirSync(directory)) {
    const pad = path.join(directory, bestand);
    if (/^brandrisicoscan-.*\.db$/.test(bestand) && fs.statSync(pad).mtimeMs < grens) {
      fs.unlinkSync(pad);
      console.log(`Oude back-up verwijderd: ${bestand}`);
    }
  }
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

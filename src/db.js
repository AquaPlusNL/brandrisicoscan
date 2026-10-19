import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/brandrisicoscan.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

/* De volgorde van de schermen. stage_idx is de index hierin; zo kan een
   later binnenkomende, oudere stand een scan niet terugzetten. */
export const STAGES = ['step-0', 'step-1', 'step-2', 'step-3', 'step-4', 'result', 'lead', 'thanks'];
export const STAGE_LABELS = ['1 activiteit', '2 omvang', '3 brandlast', '4 beveiliging', '5 omgeving', 'resultaat', 'gegevens', 'verstuurd'];

db.exec(`
  /* Een scan is anoniem: geen naam of contact, alleen antwoorden en hoe ver
     iemand kwam. Het id komt uit de browser, zodat opnieuw versturen vanuit
     de outbox dezelfde rij bijwerkt. */
  CREATE TABLE IF NOT EXISTS scans (
    id             TEXT PRIMARY KEY,
    gestart        TEXT NOT NULL,
    bijgewerkt     INTEGER NOT NULL,
    stage_idx      INTEGER NOT NULL,
    uitkomst       TEXT NOT NULL,
    risico         TEXT,
    score          INTEGER,
    activiteit     TEXT,
    oppervlakte_m2 INTEGER,
    materialen     TEXT,
    beveiliging    TEXT,
    omgeving       TEXT
  );

  /* Een lead is een ingevuld contactformulier: persoonsgegevens. */
  CREATE TABLE IF NOT EXISTS leads (
    id             TEXT PRIMARY KEY,
    scan_id        TEXT,
    tijdstip       TEXT NOT NULL,
    ontvangen      INTEGER NOT NULL,
    bedrijf        TEXT NOT NULL,
    naam           TEXT NOT NULL,
    telefoon       TEXT NOT NULL,
    risico         TEXT,
    score          INTEGER,
    activiteit     TEXT,
    oppervlakte_m2 INTEGER,
    materialen     TEXT,
    beveiliging    TEXT,
    omgeving       TEXT
  );
`);

export const q = {
  bewaarScan: db.prepare(`
    INSERT INTO scans (id, gestart, bijgewerkt, stage_idx, uitkomst, risico, score,
                       activiteit, oppervlakte_m2, materialen, beveiliging, omgeving)
    VALUES (@id, @gestart, @bijgewerkt, @stage_idx, @uitkomst, @risico, @score,
            @activiteit, @oppervlakte_m2, @materialen, @beveiliging, @omgeving)
    ON CONFLICT (id) DO UPDATE SET
      bijgewerkt = excluded.bijgewerkt, stage_idx = excluded.stage_idx, uitkomst = excluded.uitkomst,
      risico = excluded.risico, score = excluded.score, activiteit = excluded.activiteit,
      oppervlakte_m2 = excluded.oppervlakte_m2, materialen = excluded.materialen,
      beveiliging = excluded.beveiliging, omgeving = excluded.omgeving
    WHERE excluded.stage_idx >= scans.stage_idx`),
  /* Een lead verandert niet meer: nogmaals versturen is een no-op. */
  bewaarLead: db.prepare(`
    INSERT OR IGNORE INTO leads (id, scan_id, tijdstip, ontvangen, bedrijf, naam, telefoon, risico, score,
                                 activiteit, oppervlakte_m2, materialen, beveiliging, omgeving)
    VALUES (@id, @scan_id, @tijdstip, @ontvangen, @bedrijf, @naam, @telefoon, @risico, @score,
            @activiteit, @oppervlakte_m2, @materialen, @beveiliging, @omgeving)`),
  leads: db.prepare(`SELECT * FROM leads ORDER BY tijdstip DESC`),
  scans: db.prepare(`SELECT * FROM scans ORDER BY gestart DESC`),
  verwijderLead: db.prepare(`DELETE FROM leads WHERE id = ?`),
  verwijderOudeLeads: db.prepare(`DELETE FROM leads WHERE ontvangen < ?`),
};

export function statistiek() {
  const perStage = db.prepare('SELECT stage_idx, COUNT(*) AS n FROM scans GROUP BY stage_idx').all();
  const totaal = perStage.reduce((a, r) => a + r.n, 0);
  return {
    scans: totaal,
    leads: db.prepare('SELECT COUNT(*) AS n FROM leads').get().n,
    /* Trechter: hoeveel scans kwamen minstens tot dit scherm. */
    trechter: STAGE_LABELS.map((label, i) => ({
      label,
      n: perStage.filter((r) => r.stage_idx >= i).reduce((a, r) => a + r.n, 0),
    })),
    uitkomst: db.prepare('SELECT uitkomst, COUNT(*) AS n FROM scans GROUP BY uitkomst ORDER BY n DESC').all(),
    risico: db.prepare(
      "SELECT risico, COUNT(*) AS n FROM scans WHERE risico IS NOT NULL AND risico != '' GROUP BY risico ORDER BY n DESC",
    ).all(),
  };
}

export function wis(wat) {
  if (wat === 'leads' || wat === 'alles') db.exec('DELETE FROM leads');
  if (wat === 'scans' || wat === 'alles') db.exec('DELETE FROM scans');
}

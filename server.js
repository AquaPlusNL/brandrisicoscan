/* ============================================================
   Aqua+ Brandrisicoscan, server
   Express + SQLite. Publiek: de scan en twee schrijf-endpoints.
   Beheer (/admin): Microsoft SSO + extra wachtwoord. Zie README.md.
   ============================================================ */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, STAGES, STAGE_LABELS, statistiek, wis } from './src/db.js';
import { laadConfig, beheerAuth } from './src/auth.js';
import { begrens } from './src/begrenzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = laadConfig();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
// Bewaartermijn leads (persoonsgegevens), conform privacybeleid: 28 dagen na ontvangst.
// Scans zijn anoniem en vallen hier niet onder.
const LEAD_BEWAARDAGEN = Number(process.env.LEAD_BEWAARDAGEN || 28);
if (!(LEAD_BEWAARDAGEN > 0)) throw new Error('LEAD_BEWAARDAGEN moet een positief aantal dagen zijn.');

// Achter Caddy/nginx: TRUST_PROXY=1, anders is req.ip het IP van de proxy.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // same-origin, niet no-referrer: anders stuurt de browser Origin: null en faalt de CSRF-check.
  res.setHeader('Referrer-Policy', 'same-origin');
  if (cfg.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});

app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const fout = (res, code, bericht) => res.status(code).json({ fout: bericht });

/* ============================================================
   Publieke API. Alles komt uit de browser, dus alles wordt
   gecontroleerd tegen de vaste antwoordopties uit de scan.
   ============================================================ */
const OPTIES = {
  activiteit: ['recycling', 'afval', 'gevaarlijk', 'overslag'],
  materialen: ['kunststof', 'papier', 'chemisch', 'accu', 'gemengd', 'metaal'],
  beveiliging: ['bmo', 'sprinkler', 'schuim', 'nevel', 'geen'],
  omgeving: ['buiten', 'verhoogd', 'omwonend', 'verzekering', 'uitbreiding'],
  risico: ['Hoog risico', 'Matig risico', 'Beperkt risico'],
  uitkomst: ['afgehaakt', 'resultaat bekeken', 'nee, bedankt', 'lead'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* Antwoorden uit de scan, of null als er iets niet klopt. Lege velden mogen:
   een scan kan halverwege worden afgebroken. */
function antwoorden(b) {
  const FOUT = Symbol();
  const een = (k) => (!b[k] ? '' : OPTIES[k].includes(b[k]) ? b[k] : FOUT);
  const lijst = (k) => {
    const v = b[k] ?? [];
    return Array.isArray(v) && v.every((x) => OPTIES[k].includes(x)) ? v.join(', ') : FOUT;
  };
  const getal = (v, min, max) => (v == null ? null : Number.isInteger(v) && v >= min && v <= max ? v : FOUT);
  const r = {
    activiteit: een('activiteit'),
    risico: een('risico'),
    score: getal(b.score, -99, 99),
    oppervlakte_m2: getal(b.oppervlakte_m2, 500, 20000),
    materialen: lijst('materialen'),
    beveiliging: lijst('beveiliging'),
    omgeving: lijst('omgeving'),
  };
  return Object.values(r).includes(FOUT) ? null : r;
}
const tijd = (v) => (typeof v === 'string' && v.length < 40 && !Number.isNaN(Date.parse(v)) ? v : new Date().toISOString());

/* Zelfde regel als validPhone() in public/app.js. */
function geldigTelefoon(v) {
  let d = String(v).replace(/\(0\)/g, '').replace(/[\s\-.()/]/g, '');
  if (d.startsWith('0031')) d = '+31' + d.slice(4);
  if (d.startsWith('+31')) return /^\+31[1-9]\d{8}$/.test(d);
  return /^0[1-9]\d{8}$/.test(d) || /^\+[1-9]\d{7,14}$/.test(d);
}

/* Per IP per minuut. Ruim voor een paar tablets achter één beurs-IP (een scan is
   ~8 updates, een lead kost minuten), krap voor een script dat de database vult.
   Een 429 is voor de kiosk geen verlies: de outbox probeert het later opnieuw. */
const limiet = (naam, max) => (req, res, next) =>
  begrens(`${naam}:${req.ip}`, max, 60_000) ? next() : fout(res, 429, 'Te veel verzoeken.');

app.post('/api/scan', limiet('scan', 120), (req, res) => {
  const b = req.body || {};
  const a = antwoorden(b);
  const stage_idx = STAGES.indexOf(b.stage);
  if (!UUID.test(b.id) || stage_idx < 0 || !OPTIES.uitkomst.includes(b.uitkomst) || !a) {
    return fout(res, 400, 'Ongeldige scan.');
  }
  q.bewaarScan.run({ id: b.id, gestart: tijd(b.gestart), bijgewerkt: Date.now(), stage_idx, uitkomst: b.uitkomst, ...a });
  res.status(204).end();
});

app.post('/api/lead', limiet('lead', 20), (req, res) => {
  const b = req.body || {};
  const a = antwoorden(b);
  const tekst = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');
  const bedrijf = tekst(b.bedrijf), naam = tekst(b.naam), telefoon = tekst(b.telefoon);
  if (!UUID.test(b.id) || (b.scanId != null && !UUID.test(b.scanId)) || !a) return fout(res, 400, 'Ongeldige lead.');
  if (bedrijf.length < 2 || naam.length < 2 || !geldigTelefoon(telefoon)) return fout(res, 400, 'Vul bedrijf, naam en telefoonnummer in.');
  q.bewaarLead.run({
    id: b.id, scan_id: b.scanId ?? null, tijdstip: tijd(b.tijdstip), ontvangen: Date.now(),
    bedrijf, naam, telefoon, ...a,
  });
  res.status(204).end();
});

app.get('/api/gezond', (req, res) => res.json({ ok: true }));

/* ============================================================
   Beheer
   ============================================================ */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sjablonen = {};
function pagina(naam, vars) {
  sjablonen[naam] ??= fs.readFileSync(path.join(__dirname, 'admin', `${naam}.html`), 'utf8');
  return sjablonen[naam].replace(/\{\{(\w+)\}\}/g, (m, k) => esc(vars[k] ?? ''));
}

/* Beheer niet in zoekmachines. Bewust geen robots.txt: die zou /admin juist publiek aanwijzen. */
app.use('/admin', (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

/* Schrijfacties alleen vanaf onze eigen pagina's (CSRF). SameSite=Lax houdt
   al veel tegen; de Origin-header controleren kost één regel. */
app.post('/admin/*', (req, res, next) =>
  req.get('origin') === cfg.baseUrl ? next() : fout(res, 403, 'Verzoek van onbekende herkomst.'),
);
app.use('/admin', express.urlencoded({ extended: false, limit: '2kb' }));

app.get('/admin/admin.css', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.css')));
const vereisBeheer = beheerAuth(app, cfg, { begrens, pagina });
app.use('/admin', vereisBeheer);
app.use('/admin', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/admin', (req, res) => res.type('html').send(pagina('index', { email: req.beheerder })));
app.get('/admin/admin.js', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.js')));

app.get('/admin/api/overzicht', (req, res) =>
  res.json({ ...statistiek(), leadsLijst: q.leads.all(), bewaardagen: LEAD_BEWAARDAGEN }),
);

app.post('/admin/api/lead/:id/verwijder', (req, res) => {
  const n = q.verwijderLead.run(req.params.id).changes;
  console.log(`[beheer] ${req.beheerder} verwijderde lead ${req.params.id}`);
  res.json({ verwijderd: n });
});

app.post('/admin/api/wissen', (req, res) => {
  const wat = req.body?.wat;
  if (!['leads', 'scans', 'alles'].includes(wat)) return fout(res, 400, 'Kies leads, scans of alles.');
  wis(wat);
  console.log(`[beheer] ${req.beheerder} wiste ${wat}`);
  res.json({ gewist: wat });
});

/* CSV voor Excel (NL): puntkomma, BOM, en geen formules. */
function csvCel(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
const KOLOMMEN = {
  leads: ['tijdstip', 'bedrijf', 'naam', 'telefoon', 'risico', 'score', 'activiteit', 'oppervlakte_m2', 'materialen', 'beveiliging', 'omgeving'],
  scans: ['gestart', 'verste_scherm', 'uitkomst', 'risico', 'score', 'activiteit', 'oppervlakte_m2', 'materialen', 'beveiliging', 'omgeving'],
};
const nlTijd = (iso) => iso && new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
app.get('/admin/export/:wat.csv', (req, res) => {
  const wat = req.params.wat;
  if (!Object.hasOwn(KOLOMMEN, wat)) return fout(res, 404, 'Niet gevonden.');
  const rijen = (wat === 'leads' ? q.leads.all() : q.scans.all())
    .map((r) => ({ ...r, verste_scherm: STAGE_LABELS[r.stage_idx], tijdstip: nlTijd(r.tijdstip), gestart: nlTijd(r.gestart) }));
  const csv = '﻿' + [KOLOMMEN[wat].join(';'), ...rijen.map((r) => KOLOMMEN[wat].map((k) => csvCel(r[k])).join(';'))].join('\r\n');
  console.log(`[beheer] ${req.beheerder} exporteerde ${wat} (${rijen.length})`);
  res.attachment(`brandrisicoscan-${wat}-${new Date().toISOString().slice(0, 10)}.csv`).type('text/csv; charset=utf-8').send(csv);
});

app.use((err, req, res, next) => {
  console.error('[fout]', err);
  if (res.headersSent) return next(err);
  fout(res, err.status && err.status < 500 ? err.status : 500, 'Er ging iets mis op de server.');
});

function ruimOp() {
  const n = q.verwijderOudeLeads.run(Date.now() - LEAD_BEWAARDAGEN * 86_400_000).changes;
  if (n) console.log(`[opruiming] ${n} leads ouder dan ${LEAD_BEWAARDAGEN} dagen verwijderd`);
}
ruimOp();
setInterval(ruimOp, 6 * 60 * 60 * 1000).unref();

app.listen(PORT, HOST, () => console.log(`Brandrisicoscan draait op http://${HOST}:${PORT} (beheer: ${cfg.baseUrl}/admin)`));

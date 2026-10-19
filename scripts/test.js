// npm test: start de server met een tijdelijke database en controleert API en beheer-afscherming.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashWachtwoord, controleerWachtwoord, controleerClaims } from '../src/auth.js';
import { maakKioskcode } from '../src/kioskcode.js';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const map = fs.mkdtempSync(path.join(os.tmpdir(), 'brs-test-'));
const TENANT = crypto.randomUUID(), CLIENT = crypto.randomUUID();
const DB = path.join(map, 'test.db');
const KIOSK = maakKioskcode();

// Twee leads vooraf: een van 29 dagen oud (moet weg bij het starten) en een van 27 (blijft).
process.env.DB_PATH = DB;
const { db, q } = await import('../src/db.js');
for (const [id, dagen] of [['00000000-0000-4000-8000-000000000029', 29], ['00000000-0000-4000-8000-000000000027', 27]]) {
  q.bewaarLead.run({ id, scan_id: null, tijdstip: 'x', ontvangen: Date.now() - dagen * 86_400_000, bedrijf: 'Oud BV',
    naam: 'Oud', telefoon: '0612345678', risico: '', score: null, activiteit: '', oppervlakte_m2: null,
    materialen: '', beveiliging: '', omgeving: '' });
}

const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: DB, BASE_URL: BASE,
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'x'.repeat(32),
    KIOSK_CODE: KIOSK, ADMIN_EMAILS: 'beheer@aqua.nl', ADMIN_WACHTWOORD_HASH: hashWachtwoord('correct horse battery'),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ok) => server.stdout.on('data', (d) => String(d).includes('draait op') && ok()));
after(async () => {
  db.close();
  server.kill();
  await new Promise((ok) => server.once('exit', ok));   // Windows: database pas vrij na afsluiten
  fs.rmSync(map, { recursive: true, force: true });
});

const post = (url, body, headers = {}) =>
  fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kiosk-code': KIOSK, ...headers }, body: JSON.stringify(body), redirect: 'manual' });
const get = (url) => fetch(BASE + url, { redirect: 'manual' });

const scan = { id: crypto.randomUUID(), gestart: new Date().toISOString(), stage: 'result', uitkomst: 'resultaat bekeken',
  risico: 'Hoog risico', score: 12, activiteit: 'afval', oppervlakte_m2: 7500, materialen: ['accu'], beveiliging: ['geen'], omgeving: [] };

test('scan opslaan, ook herhaald en halverwege', async () => {
  assert.equal((await post('/api/scan', { id: crypto.randomUUID(), gestart: 'x', stage: 'step-0', uitkomst: 'afgehaakt' })).status, 204);
  assert.equal((await post('/api/scan', scan)).status, 204);
  assert.equal((await post('/api/scan', scan)).status, 204);
  // Oudere stand mag een verdere niet terugzetten (geen fout, wel genegeerd)
  assert.equal((await post('/api/scan', { ...scan, stage: 'step-1', uitkomst: 'afgehaakt' })).status, 204);
});

test('zonder of met foute kioskcode wordt niets opgeslagen', async () => {
  const lead = { id: crypto.randomUUID(), bedrijf: 'Bot BV', naam: 'Bot', telefoon: '0612345678' };
  for (const code of ['', 'fout', KIOSK + 'x']) {
    assert.equal((await post('/api/lead', lead, { 'x-kiosk-code': code })).status, 403, code);
    assert.equal((await post('/api/scan', scan, { 'x-kiosk-code': code })).status, 403, code);
  }
  assert.equal((await post('/api/kiosk', {}, { 'x-kiosk-code': 'fout' })).status, 403);
  assert.equal((await post('/api/kiosk', {})).status, 204);
  // Zo typt een iPad hem misschien: hoofdletters, spaties in plaats van streepjes
  assert.equal((await post('/api/kiosk', {}, { 'x-kiosk-code': KIOSK.toUpperCase().replaceAll('-', ' ') })).status, 204);
  assert.equal((await post('/api/kiosk', {}, { 'x-kiosk-code': KIOSK.slice(0, -1) })).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leads WHERE bedrijf = 'Bot BV'").get().n, 0);
});

test('scan met onbekende waarden wordt geweigerd', async () => {
  assert.equal((await post('/api/scan', { ...scan, id: 'abc' })).status, 400);
  assert.equal((await post('/api/scan', { ...scan, materialen: ['<script>'] })).status, 400);
  assert.equal((await post('/api/scan', { ...scan, stage: 'admin' })).status, 400);
  assert.equal((await post('/api/scan', { ...scan, oppervlakte_m2: 1e9 })).status, 400);
});

test('lead opslaan en valideren', async () => {
  const { stage, uitkomst, gestart, ...antwoorden } = scan;
  const lead = { ...antwoorden, id: crypto.randomUUID(), scanId: scan.id, tijdstip: new Date().toISOString(),
    bedrijf: 'Test BV', naam: 'Jan Test', telefoon: '06 12345678' };
  assert.equal((await post('/api/lead', lead)).status, 204);
  assert.equal((await post('/api/lead', lead)).status, 204);   // opnieuw uit de outbox: geen dubbele rij
  assert.equal((await post('/api/lead', { ...lead, id: crypto.randomUUID(), telefoon: '123' })).status, 400);
  assert.equal((await post('/api/lead', { ...lead, id: crypto.randomUUID(), naam: '' })).status, 400);
});

test('beheer is afgeschermd zonder login', async () => {
  const r = await get('/admin');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin/login');
  for (const url of ['/admin/api/overzicht', '/admin/export/leads.csv']) assert.equal((await get(url)).status, 401, url);
  assert.equal((await post('/admin/api/wissen', { wat: 'alles' }, { Origin: BASE })).status, 401);
  assert.equal((await post('/admin/api/wissen', { wat: 'alles' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/admin/wachtwoord', {}, { Origin: BASE })).status, 302);   // zonder SSO terug naar login
  assert.equal((await get('/admin/admin.js')).status, 302);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('login stuurt door naar Microsoft met PKCE, callback zonder state faalt', async () => {
  const r = await get('/admin/login');
  const url = new URL(r.headers.get('location'));
  assert.equal(url.origin + url.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), `${BASE}/admin/callback`);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/i);
  assert.equal((await get('/admin/callback?code=x&state=y')).status, 400);
});

test('wachtwoord en id_token-claims', () => {
  const h = hashWachtwoord('geheim-wachtwoord');
  assert.ok(controleerWachtwoord('geheim-wachtwoord', h));
  assert.ok(!controleerWachtwoord('geheim-wachtwoorD', h));

  const cfg = { tenant: TENANT, clientId: CLIENT, nonce: 'n1', admins: ['beheer@aqua.nl'] };
  const goed = { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, aud: CLIENT, nonce: 'n1',
    exp: Date.now() / 1000 + 600, preferred_username: 'Beheer@aqua.nl' };
  assert.equal(controleerClaims(goed, cfg), null);
  assert.ok(controleerClaims({ ...goed, tid: crypto.randomUUID() }, cfg));
  assert.ok(controleerClaims({ ...goed, aud: 'ander' }, cfg));
  assert.ok(controleerClaims({ ...goed, nonce: 'n2' }, cfg));
  assert.ok(controleerClaims({ ...goed, exp: 1 }, cfg));
  assert.ok(controleerClaims({ ...goed, preferred_username: 'iemand@aqua.nl' }, cfg));
  assert.ok(controleerClaims(goed, { ...cfg, nonce: undefined }));
});

test('leads ouder dan 28 dagen worden verwijderd', () => {
  const ids = db.prepare("SELECT id FROM leads WHERE bedrijf = 'Oud BV'").all().map((r) => r.id);
  assert.deepEqual(ids, ['00000000-0000-4000-8000-000000000027']);
});

test('back-up ruimt kopieën ouder dan 7 dagen op, en alleen eigen bestanden', () => {
  const map2 = path.join(map, 'backups');
  fs.mkdirSync(map2);
  const oud = path.join(map2, 'brandrisicoscan-oud.db'), recent = path.join(map2, 'brandrisicoscan-recent.db'), anders = path.join(map2, 'notities.txt');
  for (const p of [oud, recent, anders]) fs.writeFileSync(p, 'x');
  const acht = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(oud, acht, acht);
  fs.utimesSync(anders, acht, acht);
  const r = spawnSync(process.execPath, ['scripts/backup.js', map2], { env: { ...process.env, DB_PATH: DB }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const over = fs.readdirSync(map2);
  assert.ok(!over.includes('brandrisicoscan-oud.db'));
  assert.ok(over.includes('brandrisicoscan-recent.db') && over.includes('notities.txt'));
  assert.equal(over.filter((b) => /^brandrisicoscan-\d/.test(b)).length, 1);   // de nieuwe back-up
});

test('kioskcode: 3 groepen van 4, zonder verwarrende tekens, steeds anders', () => {
  const codes = Array.from({ length: 200 }, maakKioskcode);
  for (const c of codes) assert.match(c, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
  assert.equal(new Set(codes).size, codes.length);
});

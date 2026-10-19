/* ============================================================
   Aqua+ Brandrisicoscan, kiosk
   Zelfde scan als brandrisicoscan.html, maar scans en leads gaan
   naar de server in plaats van localStorage van het apparaat.
   ============================================================ */
const IDLE_MS = 90000;       // terug naar start na 90 s zonder aanraking
const THANKS_S = 10;         // bedankscherm telt af en gaat terug naar start
const OUTBOX_KEY = 'aquaplus-brandrisicoscan-outbox';

// ---------- Outbox: niets kwijt als de beurs-wifi wegvalt ----------
/* Elke scan en lead gaat eerst in localStorage en wordt daarna verstuurd.
   Lukt dat niet, dan blijft hij staan tot het wel lukt. De server slaat op
   met het id van de browser, dus twee keer versturen geeft geen dubbele rij.
   Per sleutel bewaren we alleen de laatste stand van een scan. */
function loadOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || {}; } catch (e) { return {}; }
}
function saveOutbox(box) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(box)); return true; } catch (e) { return false; }
}
function queue(key, url, body) {
  const box = loadOutbox();
  box[key] = { url, body };
  const ok = saveOutbox(box);
  flush();
  return ok;
}
let flushing = false, again = false;
async function flush() {
  if (flushing) { again = true; return; }   // tijdens verzenden bijgekomen: straks nog een ronde
  flushing = true;
  try {
    do {
      again = false;
      for (const [key, item] of Object.entries(loadOutbox())) {
        let res;
        try {
          res = await fetch(item.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body),
          });
        } catch (e) { again = false; break; }   // offline: later opnieuw
        if (res.status >= 500 || res.status === 429) { again = false; break; }
        const box = loadOutbox();
        // Alleen weghalen als er intussen geen nieuwere stand in staat
        if (JSON.stringify(box[key]) === JSON.stringify(item)) { delete box[key]; saveOutbox(box); }
        else again = true;
        if (!res.ok) console.warn('Server weigerde', key, res.status);
      }
    } while (again);
  } finally {
    flushing = false;
    const n = Object.keys(loadOutbox()).length;
    const el = document.getElementById('outbox');
    el.hidden = n === 0;
    el.textContent = n + ' nog niet verzonden';
  }
}
window.addEventListener('online', flush);
setInterval(flush, 30000);

// ---------- Anonieme scanlog: elke gestarte scan, ook zonder lead ----------
const STAGES = ['step-0', 'step-1', 'step-2', 'step-3', 'step-4', 'result', 'lead', 'thanks'];
let scan = null;

function saveScan() {
  if (scan) queue('scan:' + scan.id, '/api/scan', scan);
}
function startScan() {
  if (!scan) scan = { id: crypto.randomUUID(), gestart: new Date().toISOString(), stage: '', uitkomst: 'afgehaakt' };
  go('step-0');
}
function trackStage(id) {
  const i = STAGES.indexOf(id);
  if (!scan || i < 0 || i <= STAGES.indexOf(scan.stage)) return;
  scan.stage = id;
  if (id === 'result' && scan.uitkomst === 'afgehaakt') scan.uitkomst = 'resultaat bekeken';
  saveScan();
}
function declineLead() {
  if (scan) { scan.uitkomst = 'nee, bedankt'; saveScan(); }
  reset();
}

let state, result;
function freshState() {
  return { sector: null, sectorRisk: 0, opp: 2500, materialen: [], beveiliging: [], omgeving: [] };
}
function answers() {
  return {
    risico: result ? result.level : '', score: result ? result.score : null,
    activiteit: state.sector || '', oppervlakte_m2: state.opp,
    materialen: state.materialen, beveiliging: state.beveiliging, omgeving: state.omgeving,
  };
}

// ---------- Navigatie ----------
let countdown;
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  const step = id.startsWith('step-') ? +id.slice(5) : -1;
  document.getElementById('progress').classList.toggle('show', step >= 0);
  document.getElementById('restart-row').classList.toggle('show', step >= 0);
  document.querySelectorAll('.seg').forEach((s, i) => {
    s.className = 'seg' + (i < step ? ' done' : i === step ? ' active' : '');
  });
  if (step >= 0) document.getElementById('progress-label').textContent = 'Stap ' + (step + 1) + ' van 5';
  clearInterval(countdown);
  if (id === 'thanks') {
    let n = THANKS_S;
    const show = () => document.getElementById('thanks-count').textContent = n;
    show();
    countdown = setInterval(() => { n--; if (n <= 0) reset(); else show(); }, 1000);
  }
  trackStage(id);
  if (document.activeElement) document.activeElement.blur();
  document.querySelectorAll('.screen').forEach(s => s.scrollTop = 0);
}

function reset() {
  state = freshState();
  result = null;
  scan = null;
  setHint(false);
  document.querySelectorAll('.opt.selected, .chk.checked').forEach(el => el.classList.remove('selected', 'checked'));
  document.getElementById('opp-range').value = 2500;
  setOpp(2500);
  document.getElementById('lead-form').reset();
  document.querySelectorAll('.field input').forEach(i => i.classList.remove('invalid'));
  ['btn-0', 'btn-2', 'btn-3', 'btn-send'].forEach(id => document.getElementById(id).disabled = true);
  go('start');
}

// Knoppen: data-go="scherm" of data-act="actie" (geen inline handlers, strikte CSP)
const ACTIONS = {
  startScan, calcResult, declineLead, reset,
  // Nog niets beantwoord? Dan dezelfde scan houden, anders telt elke klik als nieuwe scan.
  restart: () => { const s = scan && scan.stage === 'step-0' ? scan : null; reset(); scan = s; startScan(); },
  submitLead: e => submitLead(e),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-go], [data-act]');
  if (!el || el.disabled) return;
  if (el.dataset.go) go(el.dataset.go);
  else ACTIONS[el.dataset.act](e);
});

// Kiosk: na inactiviteit alles wissen en terug naar start
let idleTimer;
function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!document.getElementById('start').classList.contains('active')) reset();
  }, IDLE_MS);
}
['pointerdown', 'keydown', 'input'].forEach(e => document.addEventListener(e, bumpIdle, true));

// ---------- Stap 1 ----------
document.querySelectorAll('.opt').forEach(opt => opt.addEventListener('click', () => {
  document.querySelectorAll('.opt').forEach(o => o.classList.toggle('selected', o === opt));
  state.sector = opt.dataset.v;
  state.sectorRisk = +opt.dataset.r;
  document.getElementById('btn-0').disabled = false;
}));

// ---------- Stap 2 ----------
function setOpp(val) {
  state.opp = +val;
  document.getElementById('range-display').innerHTML = (+val).toLocaleString('nl-NL') + ' <span>m&#178;</span>';
}
document.getElementById('opp-range').addEventListener('input', e => setOpp(e.target.value));

// ---------- Stap 3-5 ----------
document.querySelectorAll('.checks').forEach(group => group.addEventListener('click', e => {
  const chk = e.target.closest('.chk');
  if (!chk) return;
  chk.classList.toggle('checked');
  // "geen" sluit de andere beveiligingsopties uit, en andersom
  if (group.dataset.group === 'beveiliging' && chk.classList.contains('checked')) {
    group.querySelectorAll('.chk').forEach(c => {
      if (c !== chk && (chk.dataset.v === 'geen' || c.dataset.v === 'geen')) c.classList.remove('checked');
    });
  }
  state[group.dataset.group] = [...group.querySelectorAll('.chk.checked')].map(c => c.dataset.v);
  if (group.dataset.btn) document.getElementById(group.dataset.btn).disabled = state[group.dataset.group].length === 0;
}));

// ---------- Resultaat ----------
function calcResult() {
  let score = state.sectorRisk;
  const opp = state.opp;
  if (opp > 10000) score += 3; else if (opp > 5000) score += 2; else if (opp > 2000) score += 1;
  const mat = state.materialen;
  if (mat.includes('accu'))      score += 4;
  if (mat.includes('chemisch'))  score += 3;
  if (mat.includes('kunststof')) score += 2;
  if (mat.includes('papier'))    score += 1;
  if (mat.includes('gemengd'))   score += 1;
  const bev = state.beveiliging;
  if (bev.includes('sprinkler')) score -= 3;
  if (bev.includes('schuim'))    score -= 2;
  if (bev.includes('nevel'))     score -= 2;
  if (bev.includes('bmo'))       score -= 1;
  if (bev.includes('geen'))      score += 3;
  const omg = state.omgeving;
  if (omg.includes('buiten'))      score += 1;
  if (omg.includes('verhoogd'))    score += 1;
  if (omg.includes('omwonend'))    score += 1;
  if (omg.includes('verzekering')) score += 2;
  if (omg.includes('uitbreiding')) score += 1;
  showResult(score, bev, mat, omg);
}

function showResult(score, bev, mat, omg) {
  const fl = [];
  let level, pill, em, head, body, dmg;

  if (score >= 10) {
    level = 'hoog'; pill = 'Hoog risico'; em = 'kritisch';
    head = 'Jouw locatie heeft een kritisch brandrisicoprofiel.';
    body = 'De combinatie van brandlast, locatieomvang en beperkte of afwezige blusinstallaties maakt jouw locatie <strong>aanzienlijk kwetsbaar</strong>. Schade kan in korte tijd onbeheersbaar worden.';
    dmg = '€ 4,2 mln+';
    if (!bev.includes('sprinkler')) fl.push('Geen sprinklerinstallatie aanwezig. Bij de geconstateerde brandlast is dit een ernstig knelpunt.');
    if (mat.includes('accu')) fl.push("Lithium-accu's vragen om een specifiek koelsysteem, zoals watermist of het Pyro-Smart systeem. Een standaard sprinkler is onvoldoende.");
    if (mat.includes('chemisch')) fl.push('Chemische stoffen vragen om een schuimblussysteem conform NEN-EN 13565.');
    if (!bev.includes('bmo')) fl.push('Zonder brandmeldinstallatie is er geen vroege detectie. Elke minuut vertraging vergroot de schade.');
    fl.push('Directe actie gewenst. Een risico-inventarisatie door een gecertificeerde specialist is de eerste stap.');
  } else if (score >= 5) {
    level = 'middel'; pill = 'Matig risico'; em = 'aandacht vereist';
    head = 'Er zijn verbeterpunten in jouw brandbeveiliging.';
    body = 'Jouw locatie heeft een basis, maar er zijn <strong>lacunes die bij een brand snel kunnen escaleren</strong>. Met gerichte aanvullingen verlaag je het risicoprofiel flink.';
    dmg = '€ 1,8 mln';
    if (!bev.includes('sprinkler') && !bev.includes('schuim') && !bev.includes('nevel'))
      fl.push('Geen actief blussysteem aanwezig. Detectie alleen is niet voldoende om een brand te beheersen.');
    if (bev.includes('bmo') && !bev.includes('sprinkler'))
      fl.push('Brandmeldinstallatie aanwezig, maar zonder koppeling aan een blussysteem reageert alleen de brandweer. Dat kost kostbare tijd.');
    if (mat.includes('accu')) fl.push("E-waste en accu's vragen specifieke aandacht. Thermal runaway is niet te blussen met water alleen.");
    fl.push('Een quick scan op locatie brengt de exacte hiaten in kaart. Vaak beter haalbaar dan verwacht.');
  } else {
    level = 'laag'; pill = 'Beperkt risico'; em = 'solide';
    head = 'Jouw basisbeveiliging staat goed.';
    body = 'Je hebt al de nodige maatregelen genomen. Toch zijn er altijd <strong>mogelijkheden om te optimaliseren</strong>, zeker bij groei, verbouwing of nieuwe materiaalstromen.';
    dmg = '€ 480.000';
    fl.push('Periodiek onderhoud en inspectie van bestaande installaties is wettelijk verplicht en cruciaal voor betrouwbaarheid.');
    if (omg.includes('uitbreiding')) fl.push('Bij uitbreiding of verbouwing moet de bestaande installatie opnieuw worden beoordeeld. Dit is het juiste moment.');
    fl.push('Certificering van jouw installaties kan verzekeringspremies verlagen en verzekeringsgeschillen voorkomen.');
  }

  result = { level: pill, score };
  if (scan) Object.assign(scan, answers());
  document.getElementById('res-pill').className = 'pill ' + level;
  document.getElementById('res-pill').textContent = pill;
  document.getElementById('res-em').textContent = em;
  document.getElementById('res-callout').className = 'callout ' + level;
  document.getElementById('res-head').textContent = head;
  document.getElementById('res-body').innerHTML = body;
  document.getElementById('res-dmg').textContent = dmg;
  document.getElementById('res-findings').innerHTML = fl.map(f => '<li><span>' + f + '</span></li>').join('');
  go('result');
}

// ---------- Gegevens ----------
const fields = ['bedrijf', 'naam', 'contact'].map(n => document.getElementById('f-' + n));

// NL: 10 cijfers vanaf 0, of +31/0031 + 9 cijfers. Buitenland: + en 8 tot 15 cijfers.
// Zelfde regel staat in server.js.
function validPhone(v) {
  let d = v.replace(/\(0\)/g, '').replace(/[\s\-.()\/]/g, '');
  if (d.startsWith('0031')) d = '+31' + d.slice(4);
  if (d.startsWith('+31')) return /^\+31[1-9]\d{8}$/.test(d);
  return /^0[1-9]\d{8}$/.test(d) || /^\+[1-9]\d{7,14}$/.test(d);
}
function setHint(error) {
  const h = document.getElementById('contact-hint');
  h.classList.toggle('error', error);
  h.textContent = error
    ? 'Dit telefoonnummer klopt nog niet. Een Nederlands nummer heeft 10 cijfers, bijvoorbeeld 06 12345678'
    : 'Bijvoorbeeld 06 12345678';
}
function leadValid() {
  return fields[0].value.trim().length >= 2 && fields[1].value.trim().length >= 2
    && validPhone(fields[2].value.trim());
}
function refreshSend() { document.getElementById('btn-send').disabled = !leadValid(); }

fields.forEach(f => f.addEventListener('input', () => {
  f.classList.remove('invalid');
  if (f === fields[2] && validPhone(f.value.trim())) setHint(false);
  refreshSend();
}));
fields[2].addEventListener('blur', () => {
  const v = fields[2].value.trim();
  const bad = v !== '' && !validPhone(v);
  fields[2].classList.toggle('invalid', bad);
  setHint(bad);
});
fields.forEach((f, i) => f.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); fields[i + 1] ? fields[i + 1].focus() : f.blur(); }
}));
document.getElementById('lead-form').addEventListener('submit', submitLead);

function submitLead(e) {
  e.preventDefault();
  if (!leadValid()) return;
  const lead = {
    id: crypto.randomUUID(),
    scanId: scan ? scan.id : null,
    tijdstip: new Date().toISOString(),
    bedrijf: fields[0].value.trim(),
    naam: fields[1].value.trim(),
    telefoon: fields[2].value.trim(),
    ...answers(),
  };
  if (!queue('lead:' + lead.id, '/api/lead', lead)) {
    alert('Opslaan is niet gelukt. Meld dit even bij de stand, dan noteren we je gegevens met de hand.');
    return;
  }
  if (scan) { scan.uitkomst = 'lead'; saveScan(); }
  document.getElementById('thanks-title').textContent = 'Bedankt, ' + lead.naam.split(' ')[0] + '!';
  go('thanks');
}

reset();
flush();

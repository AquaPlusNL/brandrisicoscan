const $ = (id) => document.getElementById(id);
const td = (v) => { const el = document.createElement('td'); el.textContent = v ?? ''; return el; };

function balken(el, rijen) {
  const max = Math.max(1, ...rijen.map((r) => r.n));
  el.replaceChildren(...rijen.map((r) => {
    const rij = document.createElement('div');
    rij.className = 'balk';
    const label = document.createElement('span'); label.textContent = r.label;
    const balk = document.createElement('i'); balk.style.width = (100 * r.n / max) + '%';
    const n = document.createElement('em'); n.textContent = r.n;
    rij.append(label, document.createElement('div'), n);
    rij.children[1].append(balk);
    return rij;
  }));
  if (!rijen.length) el.textContent = 'Nog geen gegevens.';
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) alert('Dat is niet gelukt (' + r.status + '). Ververs de pagina en probeer opnieuw.');
  laad();
}

async function laad() {
  const r = await fetch('/admin/api/overzicht');
  if (r.status === 401) { location.reload(); return; }
  const d = await r.json();
  const resultaat = d.trechter[5].n;
  $('t-scans').textContent = d.scans;
  $('t-resultaat').textContent = resultaat;
  $('t-leads').textContent = d.leads;
  $('t-conversie').textContent = resultaat ? Math.round(100 * d.leads / resultaat) + '%' : '–';
  balken($('trechter'), d.trechter);
  balken($('risico'), d.risico.map((x) => ({ label: x.risico, n: x.n })));
  balken($('uitkomst'), d.uitkomst.map((x) => ({ label: x.uitkomst, n: x.n })));
  $('bewaar').textContent = 'Leads worden ' + d.bewaardagen + ' dagen na ontvangst automatisch verwijderd. Exporteer op tijd.';

  $('leads').replaceChildren(...d.leadsLijst.map((l) => {
    const tr = document.createElement('tr');
    tr.append(
      td(new Date(l.tijdstip).toLocaleString('nl-NL')), td(l.bedrijf), td(l.naam), td(l.telefoon),
      td(l.risico), td(l.activiteit), td(l.oppervlakte_m2), td(l.materialen), td(l.beveiliging), td(l.omgeving),
    );
    const knop = document.createElement('button');
    knop.className = 'btn rood klein';
    knop.textContent = 'Verwijder';
    knop.onclick = () => confirm('Lead van ' + l.naam + ' (' + l.bedrijf + ') definitief verwijderen?')
      && post('/admin/api/lead/' + encodeURIComponent(l.id) + '/verwijder');
    const cel = document.createElement('td'); cel.append(knop); tr.append(cel);
    return tr;
  }));
  if (!d.leadsLijst.length) $('leads').innerHTML = '<tr><td colspan="11" class="zacht">Nog geen leads.</td></tr>';
}

document.querySelectorAll('[data-wis]').forEach((b) => b.addEventListener('click', () => {
  if (confirm(b.textContent + '? Dit kan niet ongedaan worden gemaakt.')) post('/admin/api/wissen', { wat: b.dataset.wis });
}));

// Bewust geen automatisch verversen: dat zou de sessie eeuwig actief houden.
laad();

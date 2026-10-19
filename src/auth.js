/* ============================================================
   Beheer-login in twee stappen:
   1. Microsoft SSO (Entra ID, OpenID Connect, authorization code + PKCE)
   2. Een extra beheerwachtwoord (scrypt-hash in de omgeving)

   Sessies staan in het geheugen: na een herstart log je opnieuw in.
   ============================================================ */
import crypto from 'node:crypto';

const SESSIE_MS = 8 * 60 * 60 * 1000;    // werkdag; daarna opnieuw inloggen
const STIL_MS = 30 * 60 * 1000;          // 30 min niets gedaan: uitgelogd (vergeten op een gedeeld apparaat)
const LOGIN_MS = 10 * 60 * 1000;         // tijd om de Microsoft-login af te ronden
const COOKIE = 'brs_beheer';

export function laadConfig(env = process.env) {
  const c = {
    baseUrl: (env.BASE_URL || '').replace(/\/$/, ''),
    tenant: env.ENTRA_TENANT_ID || '',
    clientId: env.ENTRA_CLIENT_ID || '',
    clientSecret: env.ENTRA_CLIENT_SECRET || '',
    admins: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    wachtwoordHash: env.ADMIN_WACHTWOORD_HASH || '',
  };
  const fouten = [];
  if (!/^https?:\/\/[^/]+$/.test(c.baseUrl)) fouten.push('BASE_URL (bijv. https://scan.aqua.nl)');
  // Een vaste tenant-GUID, niet "common" of "organizations": anders kan elk
  // Microsoft-account de eerste stap halen.
  if (!/^[0-9a-f-]{36}$/i.test(c.tenant)) fouten.push('ENTRA_TENANT_ID (GUID)');
  if (!/^[0-9a-f-]{36}$/i.test(c.clientId)) fouten.push('ENTRA_CLIENT_ID (GUID)');
  if (c.clientSecret.length < 16) fouten.push('ENTRA_CLIENT_SECRET');
  if (c.admins.length === 0) fouten.push('ADMIN_EMAILS (komma-gescheiden)');
  if (!/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(c.wachtwoordHash)) {
    fouten.push('ADMIN_WACHTWOORD_HASH (maak met: npm run wachtwoord)');
  }
  if (fouten.length) throw new Error('Ontbrekende of ongeldige instellingen in .env:\n  ' + fouten.join('\n  '));
  c.redirectUri = c.baseUrl + '/admin/callback';
  c.secure = c.baseUrl.startsWith('https://');
  return c;
}

/* ---------- wachtwoord ---------- */
export function hashWachtwoord(wachtwoord) {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(wachtwoord, salt, 64).toString('hex')}`;
}
export function controleerWachtwoord(wachtwoord, opgeslagen) {
  const [, salt, hash] = opgeslagen.split(':');
  const poging = crypto.scryptSync(String(wachtwoord), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(poging, Buffer.from(hash, 'hex'));
}

/* ---------- id_token ----------
   Het token komt rechtstreeks van het token-endpoint van Microsoft, over TLS
   en in ruil voor ons client secret. OpenID Connect Core 3.1.3.7 staat dan toe
   de handtekening niet apart te controleren; de claims controleren we wel. */
export function controleerClaims(claims, { tenant, clientId, nonce, admins }, nu = Date.now()) {
  if (claims.iss !== `https://login.microsoftonline.com/${tenant}/v2.0`) return 'verkeerde uitgever';
  if (claims.tid !== tenant) return 'verkeerde tenant';
  if (claims.aud !== clientId) return 'token is niet voor deze app';
  if (!nonce || claims.nonce !== nonce) return 'nonce klopt niet';
  if (!(claims.exp * 1000 > nu)) return 'token verlopen';
  const email = emailVan(claims);
  if (!admins.includes(email)) return `${email || 'dit account'} heeft geen beheerrechten`;
  return null;
}
/* Alleen de UPN. De email-claim kan bij sommige accounttypes door de gebruiker zelf
   gezet en onbevestigd zijn; daar mag geen toegang van afhangen. */
export const emailVan = (claims) => String(claims.preferred_username || '').toLowerCase();
const decodeJwt = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[1] || '', 'base64url').toString());

/* ---------- sessies ---------- */
const sessies = new Map();   // id -> { verloopt, email?, wachtwoordOk?, login? }
const b64 = (n) => crypto.randomBytes(n).toString('base64url');

function nieuweSessie(res, cfg, data, ms) {
  const id = b64(32);
  sessies.set(id, { ...data, verloopt: Date.now() + ms, actief: Date.now() });
  res.cookie(COOKIE, id, { httpOnly: true, secure: cfg.secure, sameSite: 'lax', path: '/admin', maxAge: ms });
  return id;
}
function sessieVan(req) {
  const id = (req.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`))?.[1];
  const s = id && sessies.get(id);
  if (!s) return null;
  const nu = Date.now();
  if (s.verloopt < nu || s.actief + STIL_MS < nu) { sessies.delete(id); return null; }
  s.actief = nu;
  return { id, ...s };
}
setInterval(() => {
  const nu = Date.now();
  for (const [id, s] of sessies) if (s.verloopt < nu) sessies.delete(id);
}, 10 * 60 * 1000).unref();

/* ---------- routes ---------- */
export function beheerAuth(app, cfg, { begrens, pagina }) {
  const fout = (res, code, tekst) => res.status(code).type('html').send(pagina('melding', { tekst }));

  app.get('/admin/login', (req, res) => {
    if (!begrens(`login:${req.ip}`, 20, 60_000)) return fout(res, 429, 'Te veel pogingen. Wacht een minuut.');
    if (sessieVan(req)?.email) return res.redirect('/admin');   // al ingelogd: niet uitloggen via een link
    // ponytail: vaste bovengrens in plaats van opruimen per IP; ruim genoeg voor een handvol beheerders
    if (sessies.size > 10_000) return fout(res, 503, 'Even te druk. Probeer het over een paar minuten opnieuw.');
    const state = b64(24), nonce = b64(24), verifier = b64(48);
    nieuweSessie(res, cfg, { login: { state, nonce, verifier } }, LOGIN_MS);
    const url = new URL(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: cfg.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(url.href);
  });

  app.get('/admin/callback', async (req, res, next) => {
    try {
      if (!begrens(`login:${req.ip}`, 20, 60_000)) return fout(res, 429, 'Te veel pogingen. Wacht een minuut.');
      const s = sessieVan(req);
      // Alleen een lopende login opruimen (eenmalig, ook bij een fout); een ingelogde
      // sessie blijft staan, anders logt een link naar /admin/callback je uit.
      if (s?.login) sessies.delete(s.id);
      else if (s?.email) return res.redirect('/admin');
      if (req.query.error) return fout(res, 401, `Microsoft-login mislukt: ${req.query.error}`);
      if (!s?.login || typeof req.query.state !== 'string' || req.query.state !== s.login.state) {
        return fout(res, 400, 'Login verlopen of ongeldig. Probeer het opnieuw.');
      }
      const r = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: 'authorization_code',
          code: String(req.query.code || ''),
          redirect_uri: cfg.redirectUri,
          code_verifier: s.login.verifier,
        }),
      });
      const token = await r.json();
      if (!r.ok || !token.id_token) {
        console.warn('[beheer] token-endpoint:', token.error, token.error_description);
        return fout(res, 401, 'Microsoft-login mislukt.');
      }
      const claims = decodeJwt(token.id_token);
      const reden = controleerClaims(claims, { ...cfg, nonce: s.login.nonce });
      if (reden) {
        console.warn(`[beheer] geweigerd: ${reden}`);
        return fout(res, 403, `Geen toegang: ${reden}.`);
      }
      // Nieuwe sessie-id na inloggen (geen session fixation)
      nieuweSessie(res, cfg, { email: emailVan(claims), wachtwoordOk: false }, SESSIE_MS);
      res.redirect('/admin');
    } catch (e) { next(e); }
  });

  app.post('/admin/wachtwoord', (req, res) => {
    const s = sessieVan(req);
    if (!s?.email) return res.redirect('/admin/login');
    // Per account, niet per IP: anders kan iemand met SSO-toegang onbeperkt raden.
    if (!begrens(`wachtwoord:${s.email}`, 5, 15 * 60_000)) {
      return fout(res, 429, 'Te veel foute pogingen. Wacht een kwartier.');
    }
    if (!controleerWachtwoord(req.body?.wachtwoord || '', cfg.wachtwoordHash)) {
      console.warn(`[beheer] fout wachtwoord voor ${s.email}`);
      return res.status(401).type('html').send(pagina('wachtwoord', { email: s.email, fout: 'Wachtwoord klopt niet.' }));
    }
    // Nieuwe sessie-id na de tweede stap, met dezelfde eindtijd
    sessies.delete(s.id);
    nieuweSessie(res, cfg, { email: s.email, wachtwoordOk: true }, s.verloopt - Date.now());
    console.log(`[beheer] ingelogd: ${s.email}`);
    res.redirect('/admin');
  });

  app.post('/admin/uitloggen', (req, res) => {
    sessies.delete(sessieVan(req)?.id);
    res.clearCookie(COOKIE, { path: '/admin' });
    res.redirect('/admin/uitgelogd');
  });
  app.get('/admin/uitgelogd', (req, res) => res.type('html').send(pagina('melding', { tekst: 'Je bent uitgelogd.' })));

  /* Alles hierna onder /admin vraagt beide stappen. */
  return function vereisBeheer(req, res, next) {
    const s = sessieVan(req);
    const api = req.path.startsWith('/api/') || req.path.startsWith('/export/');
    if (!s?.email) return api ? res.status(401).json({ fout: 'Niet ingelogd.' }) : res.redirect('/admin/login');
    if (!s.wachtwoordOk) {
      return api
        ? res.status(401).json({ fout: 'Wachtwoord nodig.' })
        : res.type('html').send(pagina('wachtwoord', { email: s.email, fout: '' }));
    }
    req.beheerder = s.email;
    next();
  };
}

# Aqua+ Brandrisicoscan

De brandrisicoscan voor de beursstand (`brandrisicoscan.html`), nu als kleine
webapp. Bezoekers doen de scan op een tablet. Scans en leads gaan naar de server
in plaats van in localStorage van het apparaat. Beheer staat op `/admin` achter
**Microsoft SSO + een extra beheerwachtwoord**.

Dezelfde opzet als `aqua-challenge`: Node 24, Express, ingebouwde `node:sqlite`,
één proces achter Caddy.

`brandrisicoscan.html` is het origineel en blijft ongewijzigd. De app gebruikt `public/`.

## Snel starten

```bash
npm install
cp .env.example .env        # vul Entra-gegevens, ADMIN_EMAILS en de hash in
npm run wachtwoord          # geeft ADMIN_WACHTWOORD_HASH=...
npm start                   # http://localhost:3000, beheer op /admin
npm test
```

Zonder volledige `.env` start de server niet. Dat is bewust.

## Microsoft (Entra ID) instellen

1. Entra admin center → App registrations → New registration.
   - Supported account types: **alleen deze organisatie** (single tenant).
   - Redirect URI: platform **Web**, `https://beurs.aqua.nl/admin/callback`.
     Voor lokaal testen ook `http://localhost:3000/admin/callback`.
2. Certificates & secrets → New client secret → waarde in `ENTRA_CLIENT_SECRET`.
   Noteer de vervaldatum: na verloop werkt inloggen niet meer.
3. Overview → *Directory (tenant) ID* en *Application (client) ID* in `.env`.
4. Geen API-permissies nodig buiten de standaard `openid profile email`.
5. **Verplicht:** Enterprise applications → deze app → Properties →
   *Assignment required* = Ja, en alleen de beheerders toewijzen. Dan kan de rest
   van de tenant (ook gastaccounts) niet eens de eerste stap halen. `ADMIN_EMAILS`
   is de tweede controle, op de UPN (`preferred_username`).

`BASE_URL` in `.env` moet exact `https://beurs.aqua.nl` zijn, zonder slash aan het eind.
De app bouwt de redirect-URI zelf als `BASE_URL + /admin/callback`.

## Inloggen bij beheer

1. `/admin` → doorgestuurd naar Microsoft.
2. Terug op de site controleert de server tenant, app, nonce, verloop en of het
   account in `ADMIN_EMAILS` staat.
3. Daarna het beheerwachtwoord. Maximaal 5 pogingen per account per kwartier.
4. De sessie duurt maximaal 8 uur, en vervalt na 30 minuten zonder activiteit.
   Na elke stap krijgt de sessie een nieuw id. Het dashboard ververst niet vanzelf
   (anders zou de time-out nooit ingaan); herlaad de pagina voor nieuwe cijfers.
   Sessies staan in het geheugen: na een herstart van de server log je opnieuw in.

Op het dashboard zie je: tellers, hoe ver bezoekers komen per scherm,
risicoprofielen, uitkomsten, de leadlijst (los te verwijderen), CSV-export van
leads en scans (`;`, voor Excel NL) en een knop om alles te wissen. Beheeracties
komen met het account erbij in het serverlog.

## Beheer verborgen houden op de beurs

- **In de kiosk zit geen enkele verwijzing naar beheer.** Het oude
  5×-tikken-op-het-logo-scherm is weg; niets in `public/` linkt naar `/admin`.
- **Log nooit in op een kiosk-tablet.** Gebruik je eigen telefoon of laptop.
  Een open beheersessie op de tablet is de enige manier waarop een bezoeker bij
  de leads kan komen. De time-out van 30 minuten is een vangnet, geen vervanging.
- **Zet de tablets vast op de scan**: iPad *Begeleide toegang* (Guided Access),
  of Android *Scherm vastzetten* / een kioskbrowser. Dan is er geen adresbalk om
  `/admin` in te typen.
- `/admin` stuurt `X-Robots-Tag: noindex`, zodat zoekmachines het niet opnemen.
  Bewust geen `robots.txt`: die zou het pad juist publiek aanwijzen.
- Typt iemand toch `beurs.aqua.nl/admin`, dan komt hij op de Microsoft-login van
  Aqua+. Zonder account in `ADMIN_EMAILS` én het wachtwoord komt hij niet verder.

## Tablets koppelen (kioskcode)

Alleen gekoppelde tablets slaan scans en leads op. Wie `beurs.aqua.nl` gewoon
opent, kan de scan doen, maar er wordt niets bewaard. Dat houdt bots en
willekeurige bezoekers tegen. Het is één gedeelde code, geen echte login.

1. Zet per beurs een nieuwe `KIOSK_CODE` in `/etc/brandrisicoscan.env` en herstart de service:
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
2. Open op elke tablet `https://beurs.aqua.nl/#kiosk=<code>`. De code staat na het
   `#`, gaat dus nooit naar de server of in een log, en verdwijnt meteen uit de adresbalk.
3. Rechtsonder verschijnt kort *"Tablet gekoppeld"*. Staat er *"Tablet niet gekoppeld"*,
   dan klopt de code niet: opnieuw doen. Wat al ingevuld was blijft bewaard en gaat
   na koppelen alsnog mee.

Koppel de tablets **vlak voor elke beurs** opnieuw: Safari kan lokale opslag wissen
van sites die een week niet gebruikt zijn. Deel de koppel-URL niet via chat of mail
en laat hem niet zichtbaar op de stand liggen.

## Offline op de beursvloer

De tablet zet elke scan en lead eerst lokaal in een outbox en verstuurt daarna.
Valt de wifi weg, dan blijft alles staan en gaat het mee zodra er weer verbinding
is: bij het `online`-event, elke 30 seconden en bij het herladen van de pagina.
Rechtsonder in de voettekst staat *"n nog niet verzonden"* zolang er iets wacht.
**Sluit een tablet pas af of wis de browsergegevens pas als die melding weg is.**
De server slaat op op het id van de browser, dus twee keer versturen geeft geen
dubbele rij.

## Publieke API

| Methode | Pad | Wat |
| --- | --- | --- |
| `POST` | `/api/kiosk` | Controleert de kioskcode (204 of 403). |
| `POST` | `/api/scan` | Scanvoortgang (anoniem). Een eerder scherm overschrijft nooit een later scherm. |
| `POST` | `/api/lead` | Contactformulier. Bedrijf, naam en telefoon worden ook op de server gecontroleerd. |
| `GET` | `/api/gezond` | Statuscheck. |

Scan en lead vragen de header `x-kiosk-code`; zonder geldige code 403.
Alle antwoorden worden gecontroleerd tegen de vaste opties uit de scan. Per IP per
minuut maximaal 120 scan-updates en 20 leads: ruim voor een paar tablets achter
één beurs-IP, krap voor een script. Een 429 kost de kiosk niets, de outbox
probeert het later opnieuw. IP-adressen worden niet opgeslagen.

## Bewaartermijn

Leads (persoonsgegevens) worden **28 dagen na ontvangst** automatisch verwijderd,
conform het privacybeleid (`LEAD_BEWAARDAGEN`, standaard 28). De server
controleert dit bij het starten en daarna elke zes uur. **Exporteer en verwerk
leads dus binnen 28 dagen na de beurs**, en pas dezelfde termijn toe op
exportbestanden en back-ups. Scans zijn anoniem en blijven staan.

## Op een VM zetten

Zelfde werkwijze als `aqua-challenge/deploy/README.md`, met andere namen:

```sh
sudo useradd --system --home /opt/brandrisicoscan --shell /usr/sbin/nologin brandrisicoscan
sudo install -d -o brandrisicoscan -g brandrisicoscan -m 0700 /var/lib/brandrisicoscan /var/backups/brandrisicoscan
# code naar /opt/brandrisicoscan (eigenaar root), daarna:
cd /opt/brandrisicoscan && sudo npm ci --omit=dev && npm test
```

- `/etc/brandrisicoscan.env` (root, 0600) met `BASE_URL=https://beurs.aqua.nl`,
  de Entra-waarden, `ADMIN_EMAILS`, `ADMIN_WACHTWOORD_HASH` en `KIOSK_CODE`.
- `deploy/*.service` en `*.timer` naar `/etc/systemd/system/`, `deploy/Caddyfile.example`
  als `/etc/caddy/Caddyfile`, daarna `systemctl enable --now brandrisicoscan
  brandrisicoscan-backup.timer` en `systemctl reload caddy`.
- DNS `beurs.aqua.nl` → VM. Alleen 80/443 open, en SSH vanaf beheeradressen.
- Kopieer nooit je lokale `.env` of `data/` naar de VM.

Back-up: dagelijks om 03:00 naar `/var/backups/brandrisicoscan`, met
`scripts/backup.js`. Kopieer de back-ups versleuteld naar een andere plek; ze
bevatten namen en telefoonnummers.

## Nog te doen

1. **Header** noemt nog *"Afvalmanagement & Recyclingbeurs · Gorinchem"*; pas aan per beurs.
2. **Client secret verloopt**: zet een herinnering op de vervaldatum.

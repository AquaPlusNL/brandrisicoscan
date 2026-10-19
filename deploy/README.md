# Op de publieke VM zetten (Ubuntu, systemd, Caddy)

Eén Node-proces op `127.0.0.1:3001` achter Caddy. Geen Docker. Geschikt voor
dezelfde VM als aqua-challenge: die gebruikt poort 3000, deze app 3001.

Kopieer **nooit** een lokale `.env` of `data/` naar de VM.

## 0. Vooraf regelen

- **DNS**: A-record `beurs.aqua.nl` → publiek IP van de VM. Controleer met
  `nslookup beurs.aqua.nl`. Zonder DNS krijgt Caddy geen certificaat.
- **Azure NSG**: 80 en 443 open voor iedereen, SSH alleen vanaf beheeradressen,
  3001 **niet** open. Staat aqua-challenge er al, dan is dit al zo.
- **Entra ID** (zie hoofd-README):
  - redirect-URI `https://beurs.aqua.nl/admin/callback` (platform Web);
  - *Assignment required* = Ja, en de beheerders toegewezen;
  - client secret aangemaakt, met de vervaldatum genoteerd.

## 1. Eerst: welke poorten zijn vrij?

```sh
sudo ss -ltnp                          # alles wat nu luistert, met procesnaam
sudo ss -ltn | grep -q ':3001\b' && echo "3001 BEZET" || echo "3001 vrij"
grep -rn reverse_proxy /etc/caddy/     # poorten die Caddy al gebruikt
```

- **3001 vrij**: ga verder, er hoeft niets te veranderen.
- **3001 bezet**: kies een vrije poort (bijv. 3002, controleer die op dezelfde
  manier) en zet die op **beide** plekken, anders praat Caddy tegen de verkeerde app:
  - `deploy/brandrisicoscan.service`: `Environment=PORT=<poort>`
  - `deploy/Caddyfile.example`: `reverse_proxy 127.0.0.1:<poort>`

  Vervang in de controles van stap 8 ook `3001` door je poort.

Daarna:

```sh
node --version             # 24 of hoger, op /usr/bin/node
caddy version
```

Node of Caddy ontbreekt? Installeer ze volgens hun officiële handleiding. Staat
Node op een ander pad dan `/usr/bin/node`, pas dan de twee `.service`-bestanden aan.

## 2. Servicegebruiker en mappen

```sh
sudo useradd --system --home /opt/brandrisicoscan --shell /usr/sbin/nologin brandrisicoscan
sudo install -d -o brandrisicoscan -g brandrisicoscan -m 0700 \
  /var/lib/brandrisicoscan /var/backups/brandrisicoscan
```

## 3. Code ophalen

De repo is publiek, dus er is geen deploy key nodig. De code blijft van `root`;
de service mag hem lezen, niet wijzigen.

```sh
sudo git clone https://github.com/AquaPlusNL/brandrisicoscan.git /opt/brandrisicoscan
cd /opt/brandrisicoscan
sudo npm ci --omit=dev
sudo npm test
```

## 4. Omgevingsbestand

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/brandrisicoscan.env
node scripts/wachtwoord.js     # vraagt het beheerwachtwoord, geeft de hash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # kioskcode
sudo nano /etc/brandrisicoscan.env
```

Inhoud:

```dotenv
BASE_URL=https://beurs.aqua.nl
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<secret: kolom "Value", niet "Secret ID">
ADMIN_EMAILS=<upn1>,<upn2>
ADMIN_WACHTWOORD_HASH=<uitvoer van scripts/wachtwoord.js>
KIOSK_CODE=<uitvoer van het tweede commando>
LEAD_BEWAARDAGEN=28
```

`HOST`, `PORT`, `TRUST_PROXY`, `DB_PATH` en `NODE_ENV` staan al in de unit;
zet ze hier niet nog een keer. Het beheerwachtwoord zelf komt nergens op de
VM, alleen de hash. Bewaar het in een wachtwoordmanager.

## 5. Service starten

```sh
sudo cp deploy/brandrisicoscan.service deploy/brandrisicoscan-backup.service \
        deploy/brandrisicoscan-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now brandrisicoscan.service
sudo systemctl status brandrisicoscan.service
```

Start hij niet, kijk dan in `journalctl -u brandrisicoscan -n 30 --no-pager`.
Ontbreekt er een instelling of is er een ongeldig, dan staat dat er met naam in.

## 6. Caddy

Open `/etc/caddy/Caddyfile` en **voeg** het blok uit `deploy/Caddyfile.example`
onderaan toe. Vervang niets wat er al staat.

```sh
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 7. Back-ups

```sh
sudo systemctl enable --now brandrisicoscan-backup.timer
sudo systemctl start brandrisicoscan-backup.service
sudo ls -l /var/backups/brandrisicoscan
```

Dagelijks om 03:00. Kopieën ouder dan 7 dagen worden automatisch verwijderd.

## 8. Controleren

```sh
curl -fsS https://beurs.aqua.nl/api/gezond                       # {"ok":true}
curl -sI https://beurs.aqua.nl/admin | grep -i '^location'        # → /admin/login
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://beurs.aqua.nl/api/lead   # 403
sudo ss -ltnp | grep 3001                                         # alleen 127.0.0.1:3001
```

Daarna in de browser, op je eigen laptop:
1. `https://beurs.aqua.nl/admin`: Microsoft-login en daarna het wachtwoord, tot je het dashboard ziet.
2. Koppel een tablet via `https://beurs.aqua.nl/#kiosk=<code>`. Er moet kort *"Tablet gekoppeld"* verschijnen.
3. Doe een testscan met een lead en controleer dat die op het dashboard staat. Verwijder hem daarna weer.

## Bijwerken

```sh
cd /opt/brandrisicoscan
sudo git pull --ff-only
sudo npm ci --omit=dev
sudo npm test
sudo systemctl restart brandrisicoscan
```

Na een herstart moeten beheerders opnieuw inloggen. Wat al in de wachtrij van
de tablets staat, wordt daarna gewoon verstuurd.

## Per beurs

- **Ervoor:** zet een nieuwe `KIOSK_CODE`, herstart de service en koppel alle tablets opnieuw.
- **Erna:** exporteer en verwerk de leads **binnen 28 dagen**; daarna verwijdert de app ze.
  Stel de kioskcode dan in op een nieuwe waarde. Tablets die nog ergens liggen, kunnen dan niets meer insturen.

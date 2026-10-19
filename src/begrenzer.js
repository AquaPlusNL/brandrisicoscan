/* ============================================================
   Simpele snelheidsbegrenzer per sleutel (meestal een IP-hash).
   In geheugen, per proces: bij een herstart of een tweede
   instantie staan alle tellers weer op nul. Voldoende voor een
   enkele instantie achter een reverse proxy.
   ============================================================ */

export const VENSTER_MS = 60_000;

const tellers = new Map();

export function begrens(sleutel, max, vensterMs = VENSTER_MS) {
  const nu = Date.now();
  const rij = (tellers.get(sleutel) || []).filter((t) => nu - t < vensterMs);
  tellers.set(sleutel, rij);
  /* Een geweigerd verzoek telt niet mee. Anders houdt wie doorklikt zichzelf
     buiten tot hij een volle minuut stil is, en op een gedeeld IP (kantoor,
     school, beursstand) houdt die ene ongeduldige bezoeker de rest mee buiten. */
  if (rij.length >= max) return false;
  rij.push(nu);
  return true;
}

/* Alleen sleutels weggooien die buiten het venster vallen. Eerder werd de hele
   map geleegd, en dan kon je met een beetje timing rond die schoonmaak het
   dubbele van je limiet halen. */
export function ruimTellersOp(vensterMs = VENSTER_MS) {
  const grens = Date.now() - vensterMs;
  for (const [sleutel, rij] of tellers) {
    if (rij.every((t) => t < grens)) tellers.delete(sleutel);
  }
}

setInterval(() => ruimTellersOp(), 10 * 60 * 1000).unref();

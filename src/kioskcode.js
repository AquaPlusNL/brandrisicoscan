import crypto from 'node:crypto';

/* Geen i, l, o, 0 en 1: op een tablet-toetsenbord en op papier niet te verwarren.
   31 tekens, 12 posities: 31^12 ≈ 8·10^17 mogelijkheden. */
const TEKENS = 'abcdefghjkmnpqrstuvwxyz23456789';

export const maakKioskcode = () =>
  Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => TEKENS[crypto.randomInt(TEKENS.length)]).join('')).join('-');

/* Hoofdletters, streepjes en spaties tellen niet: "K7M4 PQX9-t2hw" = "k7m4-pqx9-t2hw". */
export const normaliseerKioskcode = (code) => String(code).toLowerCase().replace(/[\s-]/g, '');

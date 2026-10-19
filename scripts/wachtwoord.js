// Maakt de hash voor ADMIN_WACHTWOORD_HASH. Het wachtwoord zelf komt nergens in .env.
import readline from 'node:readline/promises';
import { hashWachtwoord } from '../src/auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ww = await rl.question('Nieuw beheerwachtwoord (min. 12 tekens): ');
rl.close();
if (ww.length < 12) {
  console.error('Te kort.');
  process.exit(1);
}
console.log(`\nZet in .env:\nADMIN_WACHTWOORD_HASH=${hashWachtwoord(ww)}`);

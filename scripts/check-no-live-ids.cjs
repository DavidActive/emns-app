// Fails if identifiers from the live VetProtect/Protect/Connect environments appear in the repo.
const fs = require('fs'), path = require('path');
const BAD = [
  /oakmlcbxyasnfxmhctyy/, /ewidbevvsjnrfmwqrekp/, /ydkzetgrtwymwwrsvfyt/,
  /sb_publishable_[A-Za-z0-9_-]{10,}/, /\+?1?888-?294-?8988/, /sb_secret_[A-Za-z0-9_-]{10,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, /AC[0-9a-f]{32}/,
];
const SKIP = new Set(['node_modules', 'dist', '.git', '.netlify']);
const SELF = path.basename(__filename);
let hits = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name === '.env.local') continue; // .env.local is git-ignored and holds real dev keys
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (e.name === SELF || /\.(png|jpg|ico|svg)$/i.test(e.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const re of BAD) if (re.test(text)) { console.error(`LIVE ID in ${full}: ${re}`); hits++; }
  }
})(process.cwd());
if (hits) process.exit(1);
console.log('check-no-live-ids: clean');

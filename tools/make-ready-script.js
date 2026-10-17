// Builds docs/sheets-sync-ready.gs (git-ignored) from docs/sheets-sync.gs with the secret token filled in.
// Token: $DL_TOKEN, else the one already in the ready file, else a new random 43-char url-safe token.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = path.join(__dirname, '..', 'docs'), out = path.join(dir, 'sheets-sync-ready.gs');
let token = process.env.DL_TOKEN;
if (!token && fs.existsSync(out)) { const m = fs.readFileSync(out, 'utf8').match(/const TOKEN = '([A-Za-z0-9_-]{32,})'/); if (m) token = m[1]; }
if (!token) token = crypto.randomBytes(32).toString('base64url');
let s = fs.readFileSync(path.join(dir, 'sheets-sync.gs'), 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('template changed: ' + a); s = s.replace(a, b); };
rep(" * Drive Logger → Google Sheet backup (Apps Script web app, container-bound to the backup spreadsheet).",
    " * Drive Logger → Google Sheet backup — READY TO PASTE for “Drive Logger – Notes Backup”. Contains the secret TOKEN: do not share or commit.");
rep("const TOKEN = 'REPLACE-WITH-A-LONG-RANDOM-STRING';   // must match the token entered in the app",
    `const TOKEN = '${token}';   // must match the token entered in the app (keep private)`);
rep("const SPREADSHEET_ID = '';        // optional: only for a standalone (unbound) script; then also delete @OnlyCurrentDoc",
    "const SPREADSHEET_ID = '';        // leave empty: bound to “Drive Logger – Notes Backup” (1BvJ3-oS9T6Pb5BrWOdkNW_IPMWn1T7CAx4sRBBHJ1RY)");
fs.writeFileSync(out, s, { mode: 0o600 });
console.log('wrote', out, '(token ' + token.length + ' chars)');

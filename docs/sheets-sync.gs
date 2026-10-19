/** @OnlyCurrentDoc  (authorization covers only the spreadsheet this script is bound to) */
/**
 * Drive Logger → Google Sheet backup (Apps Script web app, container-bound to the backup spreadsheet).
 *
 * Deploy: open the spreadsheet › Extensions › Apps Script › paste this file (replace Code.gs) › Save ›
 * Deploy › New deployment › type "Web app" › Execute as: Me · Who has access: Anyone › Deploy › authorize ›
 * copy the Web app URL ending in /exec.
 *
 * The app POSTs batches of note changes as a text/plain JSON body (no CORS preflight):
 *   { token, test?: true, events: [{ op, v, note: {id, ts, type, text, lat, lon, session, deleted, …},
 *                                    row: [Time (cmd+shift+:), Logtime (s), Type, Triage Priority, Comments], session, updated }] }
 * Each note is upserted by its Note ID under a script lock, so retries and re-sends never duplicate rows.
 * GET returns a health check with no data.
 */
const TOKEN = 'REPLACE-WITH-A-LONG-RANDOM-STRING';   // must match the token entered in the app
const SPREADSHEET_ID = '';        // optional: only for a standalone (unbound) script; then also delete @OnlyCurrentDoc
const TAB = 'Notes';
const KEY_HEADER = 'Note ID';     // rows are matched on this column (must be one of the headers below)
const VERSION_HEADER = 'Updated'; // an older version of a note never overwrites a newer one (optional column)

// ---------- Column mapping: the ONLY place to change the sheet layout ----------
// [header, value(note, event)] in column order. Columns are found by header name, so you can reorder columns in the
// sheet or add your own columns: the script only writes the cells for the headers listed here.
// event.row is the app's Copy/CSV export row (5 columns). Lat/Lon and internal columns come from the note.
// Change the layout here only: columns are matched by header name, so reordering the sheet is fine.
const COLUMNS = [
  ['Time (cmd+shift+:)', (n, ev) => (ev.row && ev.row[0]) || ''],
  ['Logtime (s)',        (n, ev) => (ev.row && ev.row[1]) || ''],   // left empty for Jason to fill later
  ['Type',               (n, ev) => (ev.row && ev.row[2]) || (n.type === 'Intervention' ? 'I' : 'Log')],
  ['Triage Priority',    (n, ev) => (ev.row && ev.row[3]) || ''],   // left empty; $ / $$ / $$$ stay in Comments
  ['Comments',           (n, ev) => (ev.row && ev.row[4] != null ? ev.row[4] : (n.text || ''))],
  ['Lat',                (n, ev) => (n.lat == null ? '' : n.lat)],
  ['Lon',                (n, ev) => (n.lon == null ? '' : n.lon)],
  ['Session',            (n, ev) => ev.session || n.session || ''],
  ['Note ID',            (n, ev) => n.id],
  ['Updated',            (n, ev) => ev.updated || ''],
  ['Deleted',            (n, ev) => (n.deleted ? 'TRUE' : '')],
  ['Received',           (n, ev) => new Date()],
];
const TEXT_HEADERS = ['Time (cmd+shift+:)', 'Logtime (s)', 'Triage Priority', 'Note ID', 'Updated'];   // plain text (no auto-dates)

function doGet() {
  return json_({ ok: true, app: 'drive-logger-backup', version: 1 });           // health check only, no data
}

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || ''); }
  catch (err) { return json_({ ok: false, error: 'bad json' }); }
  if (/^REPLACE-/.test(TOKEN)) return json_({ ok: false, error: 'token not set in script' });
  if (!body || typeof body.token !== 'string' || !sameToken_(body.token, TOKEN)) return json_({ ok: false, error: 'unauthorized' });
  const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy, retry' });
  try {
    const sh = sheet_();
    if (body.test) { headers_(sh); return json_({ ok: true, test: true, tab: TAB, rows: Math.max(0, sh.getLastRow() - 1) }); }
    return json_(Object.assign({ ok: true }, upsert_(sh, events)));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

function upsert_(sh, events) {
  const hdr = headers_(sh), width = hdr.names.length, key = hdr.index[KEY_HEADER], ver = hdr.index[VERSION_HEADER];
  const last = sh.getLastRow();
  const data = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  const at = {};                                    // note id → index into data
  data.forEach((r, i) => { if (r[key] !== '' && r[key] != null) at[String(r[key])] = i; });
  const origLen = data.length, dirty = {};
  let added = 0, updated = 0, skipped = 0;
  events.forEach(ev => {
    const n = ev && ev.note;
    if (!n || !n.id) { skipped++; return; }
    ev.row = Array.isArray(ev.row) ? ev.row : [];
    const id = String(n.id);
    let i = at[id];
    if (i !== undefined && ver !== undefined && ev.v) {
      const have = Date.parse(data[i][ver]);
      if (!isNaN(have) && have > ev.v) { skipped++; return; }      // sheet already has a newer version
    }
    const row = i !== undefined ? data[i].slice() : new Array(width).fill('');
    COLUMNS.forEach(([h, f]) => { row[hdr.index[h]] = cell_(f(n, ev)); });
    row[key] = id;
    if (i === undefined) { i = data.length; at[id] = i; data.push(row); added++; }
    else { data[i] = row; if (i < origLen) { dirty[i] = true; } updated++; }
  });
  Object.keys(dirty).forEach(k => { const i = +k; sh.getRange(i + 2, 1, 1, width).setValues([data[i]]); });
  if (data.length > origLen) sh.getRange(origLen + 2, 1, data.length - origLen, width).setValues(data.slice(origLen));
  return { received: events.length, added: added, updated: updated, skipped: skipped };
}

/** Header row → { names, index }. Creates the tab/headers if missing and appends any mapped header not present. */
function headers_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const names = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v || '').trim());
  while (names.length && !names[names.length - 1]) names.pop();
  const missing = COLUMNS.map(c => c[0]).filter(h => names.indexOf(h) < 0);
  if (missing.length) {
    const start = names.length;
    sh.getRange(1, start + 1, 1, missing.length).setValues([missing]);
    missing.forEach((h, k) => { if (TEXT_HEADERS.indexOf(h) >= 0) sh.getRange(1, start + k + 1, sh.getMaxRows(), 1).setNumberFormat('@'); });
    names.push.apply(names, missing);
    if (start === 0) sh.setFrozenRows(1);
  }
  const index = {}; names.forEach((h, i) => { if (h && index[h] === undefined) index[h] = i; });
  return { names: names, index: index };
}

function sheet_() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet: bind this script to the sheet or set SPREADSHEET_ID');
  return ss.getSheetByName(TAB) || ss.insertSheet(TAB);
}
/** Strings that Sheets would treat as a formula are stored as literal text. */
function cell_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }
function sameToken_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

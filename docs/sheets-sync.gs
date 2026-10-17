/**
 * Drive Logger → Google Sheet backup endpoint (Apps Script web app). NOT deployed / not enabled in the app yet.
 *
 * Setup (in the Google Sheet you own): Extensions › Apps Script, paste this file, replace TOKEN with a long random
 * string, then Deploy › New deployment › Web app: Execute as "Me", Who has access "Anyone". Copy the …/exec URL.
 * The app would POST batches of note changes; each note is upserted by its id, so retries never duplicate rows.
 */
const TOKEN = 'REPLACE-WITH-A-LONG-RANDOM-STRING';
const TAB = 'Drive Logger';
const HEAD = ['Note ID', 'Date', 'Time', 'ISO timestamp', 'Type', 'Note', 'Lat', 'Lon', 'Session', 'Deleted', 'Last change', 'Received'];

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  if (!body || body.token !== TOKEN) return out({ ok: false, error: 'unauthorized' });
  const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);                                   // serialize concurrent POSTs
  try {
    const sh = sheet_();
    const last = sh.getLastRow();
    const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
    events.forEach(ev => {
      const n = ev.note || {}, r = ev.row || [];
      if (!n.id) return;
      const row = [n.id, r[0] || '', r[1] || '', r[2] || '', n.type || '', n.text || '', n.lat == null ? '' : n.lat, n.lon == null ? '' : n.lon,
        n.session || '', n.deleted ? 'yes' : '', ev.op || '', new Date()];
      const i = ids.indexOf(String(n.id));
      if (i >= 0) sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
      else { sh.appendRow(row); ids.push(String(n.id)); }
    });
  } finally { lock.releaseLock(); }
  return out({ ok: true, received: events.length });
}
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TAB);
  if (!sh) { sh = ss.insertSheet(TAB); sh.appendRow(HEAD); sh.setFrozenRows(1); sh.getRange('A:A').setNumberFormat('@'); sh.getRange('B:D').setNumberFormat('@'); }
  return sh;
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

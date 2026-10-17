// Crash-safety tests: kill the page / whole browser mid-capture, wipe one store at a time, backup/restore round-trip,
// recently deleted, end-of-drive nudge, storage-failure warning.
// Run: NODE_PATH=/tmp/pw/node_modules node tools/durabilitytest.js   (BASE_URL to test another copy)
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';
const PROBE = BASE + '__probe_404.html';            // same origin, no app code: inspect raw storage
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let port = 9400 + Math.floor(Math.random() * 500);
const procs = [];

const INIT = () => {
  class FakeSR { constructor(){ window.__sr = this; this.res = []; } start(){ this.res = []; setTimeout(()=>this.onstart&&this.onstart(),5);} stop(){ setTimeout(()=>this.onend&&this.onend(),5);} abort(){ this.stop(); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  Object.defineProperty(window, 'speechSynthesis', { value: { speak(u){ setTimeout(()=>u.onend&&u.onend(), 20); }, cancel(){} } });
  window.SpeechSynthesisUtterance = function(t){ this.text=t; };
  window.__say = (t, final) => { const sr = window.__sr; const r=[{transcript:t}]; r.isFinal=!!final; const last = sr.res[sr.res.length-1];
    if (last && !last.isFinal) sr.res[sr.res.length-1] = r; else sr.res.push(r); sr.onresult({ results: sr.res.slice(), resultIndex: sr.res.length-1 }); return Date.now(); };
  const fix = { coords: { latitude: 42.501234, longitude: -83.444321, accuracy: 6 }, timestamp: Date.now() };
  Object.defineProperty(navigator, 'geolocation', { value: { watchPosition(ok){ setTimeout(()=>ok(fix), 10); return 1; }, clearWatch(){}, getCurrentPosition(ok){ ok(fix); } } });
  const q = navigator.permissions && navigator.permissions.query.bind(navigator.permissions);
  if (q) navigator.permissions.query = d => d && d.name === 'geolocation' ? Promise.resolve({ state: 'granted' }) : q(d);
};

async function launch(dir) {
  const p = port++;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${p}`,
    `--user-data-dir=${dir}`, 'about:blank'], { detached: true, stdio: 'ignore' });
  procs.push(proc);
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { await sleep(250); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`); } catch (e) {} }
  if (!browser) throw new Error('chrome did not start');
  const ctx = browser.contexts()[0];
  await ctx.addInitScript(INIT);
  return { proc, browser, ctx };
}
function hardKill(b) { try { process.kill(-b.proc.pid, 'SIGKILL'); } catch (e) { try { b.proc.kill('SIGKILL'); } catch (e2) {} } }
async function app(ctx, page) {
  page = page || await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__dl && __dl.ready(), null, { timeout: 10000 });
  return page;
}
const say = (p, t, f) => p.evaluate(([t, f]) => __say(t, f), [t, f]);
const live = p => p.evaluate(() => __dl.db().notes.filter(n => !n.deleted).map(n => ({ id: n.id, ts: n.ts, type: n.type, text: n.text, lat: n.lat, lon: n.lon, session: n.session })));
/** Raw contents of both stores, read from a same-origin page that runs no app code. */
async function probe(ctx) {
  const p = await ctx.newPage(); await p.goto(PROBE);
  const r = await p.evaluate(() => new Promise(res => {
    let ls = null, drafts = null; try { ls = JSON.parse(localStorage.getItem('driveLogger.v1')); drafts = JSON.parse(localStorage.getItem('driveLogger.drafts')); } catch (e) {}
    const lsLive = ls ? ls.notes.filter(n => !n.deleted).length : null;
    const req = indexedDB.open('driveLogger');
    req.onupgradeneeded = () => { req.transaction.abort(); };
    req.onerror = () => res({ lsLive, lsDrafts: drafts ? drafts.length : 0, idb: null });
    req.onsuccess = () => { const d = req.result;
      if (!d.objectStoreNames.contains('notes')) { d.close(); return res({ lsLive, lsDrafts: drafts ? drafts.length : 0, idb: null }); }
      const t = d.transaction(['notes', 'drafts', 'journal']); const o = {};
      t.objectStore('notes').getAll().onsuccess = e => o.notes = e.target.result;
      t.objectStore('drafts').getAll().onsuccess = e => o.drafts = e.target.result;
      t.objectStore('journal').getAll().onsuccess = e => o.journal = e.target.result;
      t.oncomplete = () => { d.close(); res({ lsLive, lsDrafts: drafts ? drafts.length : 0, lsDraftText: drafts && drafts[0] && drafts[0].text,
        idbLive: o.notes.filter(n => !n.deleted).length, idbDrafts: o.drafts.length, idbDraftText: o.drafts[0] && o.drafts[0].text,
        journal: o.journal.map(e => e.op).join(',') }); };
    };
  }));
  await p.close(); return r;
}
async function probeEval(ctx, fn) { const p = await ctx.newPage(); await p.goto(PROBE); const r = await p.evaluate(fn); await p.close(); return r; }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-dur-'));
  const results = [];
  const pass = m => { results.push(m); console.log('PASS ', m); };

  // ---------- A: renderer crash mid-capture ----------
  let B = await launch(path.join(tmp, 'A'));
  let p = await app(B.ctx);
  await p.click('#micBtn'); await sleep(150);
  await say(p, 'log baseline note one', true); await sleep(1200);
  const tKw = await say(p, 'intervention took over at the light', false); await sleep(800);
  let pr = await probe(B.ctx);
  console.log('   before crash:', JSON.stringify(pr));
  assert.strictEqual(pr.lsDrafts, 1); assert.strictEqual(pr.idbDrafts, 1);
  assert.strictEqual(pr.lsDraftText, 'took over at the light');
  const cdp = await B.ctx.newCDPSession(p);
  await Promise.race([cdp.send('Page.crash').catch(() => {}), sleep(1500)]);
  console.log('   renderer crashed');
  await p.close().catch(() => {});
  p = await app(B.ctx);
  let notes = await live(p);
  let rec = notes.find(n => /\(recovered\)$/.test(n.text));
  console.log('   after reload:', JSON.stringify(notes.map(n => n.type + ': ' + n.text)));
  assert.ok(rec, 'recovered note present');
  assert.strictEqual(rec.text, 'took over at the light (recovered)');
  assert.strictEqual(rec.type, 'Intervention');
  assert.ok(Math.abs(rec.ts - tKw) < 50, 'recovered note keeps the keyword timestamp');
  assert.deepStrictEqual([rec.lat, rec.lon], [42.501234, -83.444321]);
  assert.strictEqual(notes.length, 2);
  pr = await probe(B.ctx);
  assert.strictEqual(pr.lsDrafts + pr.idbDrafts, 0, 'drafts cleared after recovery');
  assert.ok(/recover/.test(pr.journal), 'journal has the recover event');
  pass(`renderer crash mid-capture → "${rec.text}" restored with keyword time (Δ${rec.ts - tKw} ms) + GPS; drafts cleared`);
  p = await app(B.ctx, p);
  assert.strictEqual((await live(p)).length, 2); pass('second reload does not recover the same draft again');

  // ---------- C: clear localStorage only → notes come back from IndexedDB ----------
  await probeEval(B.ctx, () => localStorage.clear());
  p = await app(B.ctx, p);
  notes = await live(p);
  assert.strictEqual(notes.length, 2);
  assert.ok(notes.some(n => n.text === 'took over at the light (recovered)'));
  pr = await probe(B.ctx); assert.strictEqual(pr.lsLive, 2, 'localStorage repopulated');
  pass('localStorage wiped → both notes restored from IndexedDB, localStorage repopulated');

  // ---------- D: delete IndexedDB only → notes come back from localStorage ----------
  await p.goto('about:blank');
  const del = await probeEval(B.ctx, () => new Promise(r => { const q = indexedDB.deleteDatabase('driveLogger'); q.onsuccess = () => r('deleted'); q.onerror = () => r('error'); q.onblocked = () => r('blocked'); }));
  assert.strictEqual(del, 'deleted');
  p = await app(B.ctx, p);
  assert.strictEqual((await live(p)).length, 2);
  await sleep(300);
  pr = await probe(B.ctx); assert.strictEqual(pr.idbLive, 2, 'IndexedDB repopulated');
  pass('IndexedDB deleted → notes kept from localStorage, IndexedDB repopulated');

  // ---------- E: corrupt localStorage JSON → IndexedDB wins ----------
  await probeEval(B.ctx, () => localStorage.setItem('driveLogger.v1', '{"sessions":[{"id"'));
  p = await app(B.ctx, p);
  notes = await live(p);
  assert.strictEqual(notes.length, 2);
  pass('corrupt localStorage JSON → notes restored from IndexedDB');

  // ---------- F: recently deleted + restore, and voice undo ----------
  await p.click('#micBtn'); await sleep(150);
  await say(p, 'log pothole on the right shoulder', true); await sleep(1200);
  await say(p, 'scratch that', true); await sleep(1500);
  assert.strictEqual((await live(p)).length, 2);
  await p.click('#micBtn'); await sleep(200);                       // Stop → nudge (unexported)
  if (await p.isVisible('#nudge')) await p.click('#nudgeLater');
  await p.click('#moreBtn'); await sleep(500);
  await p.click('#deletedBox summary');
  const delTxt = await p.textContent('#deleted');
  assert.ok(/pothole on the right shoulder/.test(delTxt));
  await p.click('#deleted button[data-i="0"]'); await sleep(300);
  notes = await live(p);
  assert.ok(notes.some(n => n.text === 'pothole on the right shoulder'));
  pass('deleted note listed under Recently deleted and restored with one tap');
  pr = await probe(B.ctx);
  assert.ok(/create.*delete.*restore/.test(pr.journal), 'journal: ' + pr.journal);
  pass(`journal records every change: ${pr.journal}`);

  // ---------- G: backup → restore into a fresh profile (merge, idempotent) ----------
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#backupBtn')]);
  const bfile = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(bfile);
  const backup = JSON.parse(fs.readFileSync(bfile, 'utf8'));
  assert.strictEqual(backup.app, 'drive-logger'); assert.ok(backup.journal.length >= 4);
  const nBackup = backup.state.notes.filter(n => !n.deleted).length;
  const b2 = await launch(path.join(tmp, 'G'));
  let q = await app(b2.ctx);
  await q.click('#micBtn'); await sleep(150);
  await say(q, 'log note made on the other phone', true); await sleep(1200);
  await q.click('#micBtn'); await sleep(200); if (await q.isVisible('#nudge')) await q.click('#nudgeLater');
  await q.click('#moreBtn'); await sleep(400);
  await q.setInputFiles('#restoreFile', bfile); await sleep(800);
  const t1 = await q.textContent('#toast');
  let qn = await live(q);
  assert.strictEqual(qn.length, nBackup + 1);
  assert.ok(qn.some(n => n.text === 'note made on the other phone'));
  assert.ok(qn.some(n => n.text === 'took over at the light (recovered)'));
  await q.setInputFiles('#restoreFile', bfile); await sleep(800);
  const t2 = await q.textContent('#toast');
  assert.strictEqual((await live(q)).length, nBackup + 1);
  assert.ok(/0 new, 0 updated/.test(t2));
  pass(`backup (${dl.suggestedFilename()}, ${nBackup} notes, ${backup.journal.length} journal entries) restored by merge into a profile with its own note: "${t1}"; repeat: "${t2}"`);
  const sel = await q.$$eval('#sessionSel option', o => o.map(x => x.textContent));
  assert.ok(sel.length >= 3); pass(`restored sessions appear alongside local ones (${sel.length - 1} sessions)`);
  await b2.browser.close().catch(() => {}); hardKill(b2);

  // ---------- H: end-of-drive nudge + export tracking ----------
  await p.click('[data-close].pill'); await sleep(400);
  await p.click('#micBtn'); await sleep(150);
  await say(p, 'log merge was smooth', true); await sleep(1200);
  await p.click('#micBtn'); await sleep(200);
  assert.ok(await p.isVisible('#nudge'));
  const nt = await p.textContent('#nudgeTitle');
  const [d2] = await Promise.all([p.waitForEvent('download'), p.click('#nudgeCsv')]);
  const csv = fs.readFileSync(await d2.path(), 'utf8');
  assert.ok(/merge was smooth/.test(csv));
  assert.strictEqual(await p.textContent('#nudgeTitle'), '✓ Downloaded');
  await p.click('#nudgeLater');
  await p.click('#moreBtn'); await sleep(400);
  const info = await p.textContent('#exportInfo');
  assert.ok(/^All exported · last export \d\d:\d\d$/.test(info), info);
  await p.click('[data-close].pill'); await sleep(400);
  await p.click('#micBtn'); await sleep(200); assert.ok(!(await p.isVisible('#nudge')), 'no nudge when everything is exported');
  await p.click('#micBtn'); await sleep(150);
  pass(`Stop with unexported notes → nudge "${nt}" → Download → "✓ Downloaded"; More shows "${info}"; no nudge once exported`);
  await say(p, 'log one more after export', true); await sleep(1200);
  await p.click('#micBtn'); await sleep(200); if (await p.isVisible('#nudge')) await p.click('#nudgeLater');
  const before = await p.evaluate(() => __dl.db().current);
  await p.click('#moreBtn'); await sleep(400);
  assert.ok(/1 note not exported/.test(await p.textContent('#exportInfo')));
  await p.click('#newSessionBtn'); await sleep(200);
  assert.ok(await p.isVisible('#nudge')); assert.strictEqual(await p.textContent('#nudgeLater'), 'Skip, start new drive');
  await p.click('#nudgeLater'); await sleep(200);
  assert.notStrictEqual(await p.evaluate(() => __dl.db().current), before);
  pass('New session with an unexported note → nudge → "Skip, start new drive" starts the new session');

  // ---------- I: storage failure is surfaced ----------
  await p.click('[data-close].pill'); await sleep(400);
  await p.evaluate(() => { Storage.prototype.setItem = function () { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }; });
  await p.click('#micBtn'); await sleep(150);
  await say(p, 'log storage is full now', true); await sleep(1200);
  const warn = await p.textContent('#warnBar'); const wv = await p.isVisible('#warnBar');
  assert.ok(wv && /localStorage failed \(QuotaExceededError\)/.test(warn), warn);
  await p.click('#micBtn'); await sleep(200); if (await p.isVisible('#nudge')) await p.click('#nudgeLater');
  await p.goto('about:blank');
  pr = await probe(B.ctx);
  assert.ok(pr.idbLive >= 5);
  pass(`localStorage quota failure → visible warning "${warn}"; the note still reached IndexedDB`);
  await B.browser.close().catch(() => {}); hardKill(B);

  // ---------- B: SIGKILL the whole browser mid-capture, relaunch the same profile ----------
  const dirB = path.join(tmp, 'B');
  B = await launch(dirB);
  p = await app(B.ctx);
  await p.click('#micBtn'); await sleep(150);
  await say(p, 'log baseline before kill', true); await sleep(1500);
  const tK = await say(p, 'log lead car braked hard and we', false); await sleep(1500);
  hardKill(B); await sleep(1000);
  B = await launch(dirB);
  pr = await probe(B.ctx);
  console.log('   on disk after SIGKILL:', JSON.stringify(pr));
  p = await app(B.ctx);
  notes = await live(p);
  rec = notes.find(n => /\(recovered\)$/.test(n.text));
  assert.ok(rec, 'recovered after SIGKILL');
  assert.strictEqual(rec.text, 'lead car braked hard and we (recovered)');
  assert.ok(Math.abs(rec.ts - tK) < 50);
  assert.ok(notes.some(n => n.text === 'baseline before kill'), 'baseline note survived');
  const src = pr.lsDrafts && pr.idbDrafts ? 'both stores' : pr.idbDrafts ? 'IndexedDB only (localStorage had not reached disk)' : 'localStorage only';
  pass(`browser SIGKILL'd mid-capture → "${rec.text}" recovered on relaunch; on-disk draft found in ${src}; baseline note in LS=${pr.lsLive} IDB=${pr.idbLive}`);
  const persisted = await p.evaluate(() => navigator.storage.persisted());
  await B.browser.close().catch(() => {}); hardKill(B);

  console.log(`\nDurability tests passed (${results.length}). navigator.storage.persisted() in headless Chrome: ${persisted}`);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); procs.forEach(pr => { try { process.kill(-pr.pid, 'SIGKILL'); } catch (x) {} }); process.exit(1); });

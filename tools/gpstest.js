// GPS tests with mocked geolocation. Run: NODE_PATH=/tmp/pw/node_modules node tools/gpstest.js
const { chromium } = require('playwright-core');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';   // e.g. https://jkippy.github.io/drive-logger/
const fs = require('fs');
const assert = require('assert');
const URL = BASE;
function init() {
  localStorage.setItem('driveLogger.v1.seenHelp', '1');
  window.__skew = 0; const realNow = Date.now; Date.now = () => realNow() + window.__skew;   // lets us age a GPS fix
  class FakeSR { constructor(){ window.__sr = this; this.res = []; } start(){ this.res = []; setTimeout(()=>this.onstart&&this.onstart(),5);} stop(){ setTimeout(()=>this.onend&&this.onend(),5);} abort(){ this.stop(); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  Object.defineProperty(window, 'speechSynthesis', { value: { speak(u){ setTimeout(()=>u.onend&&u.onend(), 30); }, cancel(){} } });
  window.SpeechSynthesisUtterance = function(t){ this.text=t; };
  window.__say = (t, final) => { const sr = window.__sr; const last = sr.res[sr.res.length-1]; const r=[{transcript:t}]; r.isFinal=!!final;
    if (last && !last.isFinal) sr.res[sr.res.length-1] = r; else sr.res.push(r); sr.onresult({results: sr.res.slice(), resultIndex: sr.res.length-1}); };
}
const notesOf = p => p.evaluate(() => JSON.parse(localStorage.getItem('driveLogger.v1')).notes.map(n => ({ type: n.type, text: n.text, lat: n.lat, lon: n.lon, acc: n.acc })));
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  // ---- A: granted. The fix is taken at the KEYWORD moment, not at save time ----
  let ctx = await b.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true,
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'], geolocation: { latitude: 42.480610, longitude: -83.475520, accuracy: 6 } });
  await ctx.addInitScript(init);
  let p = await ctx.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(URL);
  console.log('A0 GPS default ON:', await p.evaluate(() => document.getElementById('gpsChk').checked), '| status before start:', await p.textContent('#gpsText'));
  await p.click('#micBtn'); await p.waitForTimeout(800);
  console.log('A1 status after start:', await p.textContent('#gpsText'));
  await p.evaluate(() => __say('log brake fade on the downhill', false));            // keyword heard here, at point 1
  await p.waitForTimeout(300);
  await ctx.setGeolocation({ latitude: 42.501220, longitude: -83.444760, accuracy: 4 }); // car moves before the note is saved
  await p.waitForTimeout(800);
  await p.evaluate(() => __say('log brake fade on the downhill', true));             // saved at point 2
  await p.waitForTimeout(800);
  await p.evaluate(() => __say('intervention took over at the light', true));        // keyword at point 2
  await p.waitForTimeout(800);
  let n = await notesOf(p);
  console.log('A2 notes:', JSON.stringify(n));
  assert.strictEqual(n[0].lat, 42.48061); assert.strictEqual(n[0].lon, -83.47552);   // keyword-time fix
  assert.strictEqual(n[1].lat, 42.50122); assert.strictEqual(n[1].lon, -83.44476);
  // Copy button → clipboard TSV (no header by default, then with header)
  await p.click('#copyBtn'); await p.waitForTimeout(200);
  let clip = await p.evaluate(() => navigator.clipboard.readText());
  console.log('A3 clipboard TSV:\n' + clip);
  assert.strictEqual(clip.split('\n')[0].split('\t').length, 5);
  assert.ok(clip.includes('Log\t\t') || /\tLog\t\t/.test(clip));
  assert.ok(!clip.includes('42.480610'));   // Lat/Lon stay on the note, not in Copy/CSV
  // CSV download from the sheet
  await p.click('#moreBtn'); await p.waitForTimeout(500);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#csvBtn')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  console.log('A4 CSV file (' + dl.suggestedFilename() + '):\n' + csv.trim());
  assert.ok(csv.includes('Time (cmd+shift+:),Logtime (s),Type,Triage Priority,Comments'));  // may start with a UTF-8 BOM
  assert.ok(csv.includes(',,I,,') || csv.includes(',I,'));
  assert.ok(!csv.includes('42.501220'));
  // Header-row checkbox → Jason's exact header; GPS on/off does not change export columns
  await p.click('#hdrChk'); await p.click('[data-close].pill'); await p.waitForTimeout(500);
  await p.click('#copyBtn'); await p.waitForTimeout(200);
  clip = await p.evaluate(() => navigator.clipboard.readText());
  console.log('A5 with header:', JSON.stringify(clip.split('\n')[0]), '| status:', await p.textContent('#gpsText'));
  assert.strictEqual(clip.split('\n')[0], 'Time (cmd+shift+:)\tLogtime (s)\tType\tTriage Priority\tComments');
  // ---- C: stale fix → blank lat/lon ----
  await p.click('#moreBtn'); await p.waitForTimeout(400); await p.click('#gpsChk'); await p.click('[data-close].pill'); await p.waitForTimeout(800);
  // Chromium keeps re-delivering the mocked fix, so freeze the watcher to simulate losing signal, then age the last fix by 45 s
  await p.evaluate(() => { navigator.geolocation.watchPosition = () => 0; });
  await p.evaluate(() => { const g = navigator.geolocation; g.clearWatch = () => {}; window.__skew = 45000; });
  await ctx.setGeolocation(null).catch(() => {});
  await p.waitForTimeout(1200);
  const staleTxt = await p.textContent('#gpsText');
  await p.evaluate(() => __say('log fix should be stale here', true)); await p.waitForTimeout(800);
  n = await notesOf(p);
  console.log('C1 stale status:', staleTxt, '| note:', JSON.stringify(n[n.length - 1]));
  await ctx.close();

  // ---- B: permission denied → blank lat/lon, subtle status ----
  ctx = await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(init);
  await ctx.addInitScript(() => {   // deterministic denial (what Safari does when the user taps "Don't Allow")
    const deny = (ok, err) => { setTimeout(() => err && err({ code: 1, message: 'User denied Geolocation' }), 50); return 1; };
    Object.defineProperty(navigator, 'geolocation', { value: { watchPosition: deny, getCurrentPosition: deny, clearWatch(){} } });
  });
  p = await ctx.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(URL);
  await p.click('#micBtn'); await p.waitForTimeout(600);
  await p.evaluate(() => __say('intervention cyclist cut in front', true)); await p.waitForTimeout(800);
  n = await notesOf(p);
  await p.click('#hdrChk', { force: true }).catch(() => {});
  const tsv = await p.evaluate(() => DLCore.toTSV(JSON.parse(localStorage.getItem('driveLogger.v1')).notes, true));
  console.log('B1 denied status:', await p.textContent('#gpsText'), '| class:', await p.getAttribute('#gpsStatus', 'class'));
  console.log('B2 note:', JSON.stringify(n[0]));
  console.log('B3 TSV:', JSON.stringify(tsv));
  assert.strictEqual(n[0].lat, null);
  assert.strictEqual(tsv.split('\n')[0], 'Time (cmd+shift+:)\tLogtime (s)\tType\tTriage Priority\tComments');
  assert.ok(/\tI\t\t/.test(tsv.split('\n')[1]));   // Type I, empty Triage Priority, Comments last
  await ctx.close();
  await b.close();
  console.log('\nGPS tests passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });

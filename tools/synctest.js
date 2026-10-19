// Sheets backup end to end: app ⇄ fake Apps Script (real docs/sheets-sync.gs, Google's 302 → googleusercontent flow).
// Run: NODE_PATH=/tmp/pw/node_modules node tools/synctest.js   (local http only: the fake endpoint is http)
const { chromium } = require('playwright-core');
const assert = require('assert'), fs = require('fs');
const FAKE = require('./fake-gas.js');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';
const TOKEN = 'synctest-' + Math.random().toString(36).slice(2) + 'abcdefghijklmnop';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const INIT = () => {
  class FakeSR { constructor(){ window.__sr = this; this.res = []; } start(){ this.res = []; setTimeout(()=>this.onstart&&this.onstart(),5);} stop(){ setTimeout(()=>this.onend&&this.onend(),5);} abort(){ this.stop(); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  Object.defineProperty(window, 'speechSynthesis', { value: { speak(u){ setTimeout(()=>u.onend&&u.onend(), 20); }, cancel(){} } });
  window.SpeechSynthesisUtterance = function(t){ this.text=t; };
  window.__say = (t, final) => { const sr = window.__sr; const r=[{transcript:t}]; r.isFinal=!!final; sr.res.push(r); sr.onresult({ results: sr.res.slice(), resultIndex: sr.res.length-1 }); };
};
async function until(fn, ms = 8000, step = 100) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(step); } return v; }

(async () => {
  const fake = await FAKE.start({ token: TOKEN });
  const pass = m => console.log('PASS ', m);
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'America/Detroit' });
  await ctx.addInitScript(INIT);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const ready = async () => p.waitForFunction(() => window.__dl && __dl.ready());
  const say = async t => { await p.evaluate(t => __say(t, true), t); await sleep(1000); };
  const rows = () => fake.rows().slice(1);
  const ind = () => p.evaluate(() => { const e = document.getElementById('syncInd'), n = e.textContent.trim(), st = e.getAttribute('data-state');
    return e.hidden ? 'hidden' : st === 'ok' ? 'Synced' : st === 'err' ? 'Sync error' : n + ' pending'; });
  try {
    await p.goto(BASE); await ready();
    assert.strictEqual(await ind(), 'hidden'); pass('sync indicator hidden while backup is off');
    await p.click('#micBtn'); await sleep(100);
    await say('log lead car braked hard near exit 12');
    await say('intervention took over at the light');
    await p.click('#micBtn'); await sleep(200); if (await p.isVisible('#nudge')) await p.click('#nudgeLater');
    assert.strictEqual(fake.log.length, 0, 'nothing sent before pairing');

    // ---- pairing link ----
    const link = BASE + '#sync=' + encodeURIComponent(fake.url) + '&token=' + encodeURIComponent(TOKEN);
    await p.goto(link); await ready();
    const href = await p.evaluate(() => location.href);
    assert.ok(!href.includes('#') && !href.includes(TOKEN), 'hash stripped: ' + href);
    assert.ok(await p.isVisible('#pair'));
    const pairTxt = (await p.textContent('#pair')).replace(/\s+/g, ' ').trim();
    assert.ok(/2 notes on this device will be sent/.test(pairTxt), pairTxt);
    assert.strictEqual(fake.log.length, 0, 'nothing sent before the user confirms');
    pass(`pairing link opened → token stripped from the URL (${href}) → confirmation card: "${pairTxt}"`);
    await p.click('#pairOk');
    const toast1 = await p.textContent('#toast');
    await until(async () => rows().length === 2);
    let r = rows();
    assert.deepStrictEqual(r.map(x => [x[2], x[4]]).sort(), [['I', 'took over at the light'], ['Log', 'lead car braked hard near exit 12']]);
    assert.ok(/^(1[0-2]|[1-9]):\d\d:\d\d (AM|PM)$/.test(r[0][0]) && r[0][1] === '' && r[0][3] === '' && /^Drive \d{4}-\d\d-\d\d \d\d:\d\d$/.test(r[0][7]) && r[0][8]);
    assert.strictEqual(await until(async () => (await ind()) === 'Synced' && 'ok'), 'ok');
    pass(`"${toast1}" → backfill put both existing notes in the sheet (ISO ${r[0][2]}, session "${r[0][7]}"); status row shows "Synced"`);
    const posts = fake.log.filter(x => x.method === 'POST');
    assert.ok(posts.every(x => /^text\/plain/.test(x.ct)), 'text/plain only');
    assert.strictEqual(fake.log.filter(x => x.method === 'OPTIONS').length, 0);
    assert.ok(fake.log.some(x => x.echo), 'followed the 302 to the googleusercontent-style echo URL');
    pass(`${posts.length} POST(s), all Content-Type text/plain, 0 preflight OPTIONS, 302 → echo URL followed, JSON reply read`);

    // ---- live changes ----
    await p.click('#micBtn'); await sleep(100);
    await say('log cyclist cut in front at the merge');
    await until(async () => rows().length === 3);
    await say('mark that high priority');
    await until(async () => rows().some(x => x[4] === 'cyclist cut in front at the merge $$$' && x[2] === 'Log'));
    await say('scratch that');
    await until(async () => rows().some(x => x[4].startsWith('cyclist') && x[10] === 'TRUE'));
    r = rows();
    assert.strictEqual(r.length, 3);
    pass('new note → row added; "mark that high priority" → same row updated to "… $$$"; "scratch that" → Deleted=TRUE (no duplicates)');

    // ---- endpoint down → error + pending, then recovery ----
    fake.setMode('down');
    await say('log construction zone lane shift');
    assert.strictEqual(await until(async () => (await ind()) === 'Sync error' && 'err'), 'err');
    await p.click('#micBtn'); await sleep(200); if (await p.isVisible('#nudge')) await p.click('#nudgeLater');
    await p.click('#moreBtn'); await sleep(500);
    const stDown = await p.textContent('#syncStatus'), errDown = await p.textContent('#syncErr');
    assert.ok(/1 pending/.test(stDown) && /Couldn’t reach the script/.test(errDown), stDown + ' | ' + errDown);
    fake.setMode('ok');
    await p.click('#syncNow');
    await until(async () => rows().some(x => x[4] === 'construction zone lane shift'));
    await until(async () => /0 pending/.test(await p.textContent('#syncStatus')));
    const stUp = await p.textContent('#syncStatus');
    assert.ok(/^Last synced \d\d:\d\d:\d\d · 0 pending$/.test(stUp), stUp);
    assert.strictEqual(await p.textContent('#syncErr'), '');
    pass(`endpoint down → indicator "Sync error", More: "${stDown}" / "${errDown}"; back up + Sync now → "${stUp}"`);

    // ---- offline queue ----
    await p.click('[data-close].pill'); await sleep(400);
    await ctx.setOffline(true);
    await p.click('#micBtn'); await sleep(100);
    await say('log offline note in the tunnel');
    await sleep(800);
    const offInd = await ind();
    assert.strictEqual(offInd, '1 pending');
    await ctx.setOffline(false);
    await until(async () => rows().some(x => x[4] === 'offline note in the tunnel'), 10000);
    assert.strictEqual(await until(async () => (await ind()) === 'Synced' && 'ok'), 'ok');
    pass(`offline: note queued (indicator "${offInd}") and sent automatically when back online`);
    await p.click('#micBtn'); await sleep(200); if (await p.isVisible('#nudge')) await p.click('#nudgeLater');

    // ---- survives reload; queue persists across a reload while the endpoint is down ----
    fake.setMode('down');
    await p.click('#micBtn'); await sleep(100); await say('log queued across reload'); await p.click('#micBtn'); await sleep(200);
    await p.reload(); await ready();
    assert.strictEqual(await p.evaluate(() => __dl.db().settings.sheetSync.enabled), true);
    assert.ok((await p.evaluate(() => DLSync.pending())) >= 1);
    fake.setMode('ok'); await p.evaluate(() => DLSync.flush());
    await until(async () => rows().some(x => x[4] === 'queued across reload'));
    pass('config and unsent queue survive a reload; queued note delivered after it');

    // ---- Send test: OK, wrong token, wrong URL, access not "Anyone" ----
    await p.click('#moreBtn'); await sleep(500);
    await p.click('#syncTest');
    await until(async () => /Test OK/.test(await p.textContent('#syncStatus')));
    const okTxt = await p.textContent('#syncStatus');
    const tryTest = async (url, token, mode) => {
      if (mode) fake.setMode(mode);
      await p.fill('#syncUrl', url); await p.fill('#syncToken', token);
      await p.evaluate(() => { document.getElementById('toast').textContent = ''; });
      await p.click('#syncTest');
      const t = await until(async () => { const s = await p.textContent('#toast'); return /Test failed/.test(s) && s; });
      fake.setMode('ok'); return t;
    };
    const tTok = await tryTest(fake.url, 'wrong-token');
    const tUrl = await tryTest(fake.badUrl, TOKEN);
    const tPriv = await tryTest(fake.url, TOKEN, 'private');
    assert.ok(/Token rejected/.test(tTok) && /Couldn’t reach/.test(tUrl) && /Couldn’t reach/.test(tPriv), [tTok, tUrl, tPriv].join(' | '));
    pass(`Send test: "${okTxt}" · wrong token → "${tTok}" · wrong URL → "${tUrl}" · access not Anyone → "${tPriv}"`);
    assert.strictEqual(await p.evaluate(() => __dl.db().settings.sheetSync.token), TOKEN, 'tests did not change saved config');

    // ---- backup file must not contain the token ----
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#backupBtn')]);
    const bk = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(!bk.includes(TOKEN) && bk.includes(fake.url));
    pass('JSON backup keeps the endpoint URL but not the token');

    // ---- turn off ----
    await p.fill('#syncUrl', fake.url); await p.fill('#syncToken', TOKEN);
    await p.click('#syncChk'); await sleep(300);
    assert.strictEqual(await ind(), 'hidden');
    const before = fake.log.length;
    await p.click('[data-close].pill'); await sleep(400);
    await p.click('#micBtn'); await sleep(100); await say('log not sent while off'); await p.click('#micBtn'); await sleep(1500);
    if (await p.isVisible('#nudge')) await p.click('#nudgeLater');
    assert.strictEqual(fake.log.length, before);
    pass('switch off → indicator hidden, nothing sent');

    // ---- manual setup in a fresh profile: paste the pairing link into the URL field ----
    const ctx2 = await b.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'America/Detroit' });
    await ctx2.addInitScript(INIT);
    const q = await ctx2.newPage(); await q.goto(BASE); await q.waitForFunction(() => __dl.ready());
    await q.click('#micBtn'); await sleep(100); await q.evaluate(() => __say('log second phone note', true)); await sleep(1000); await q.click('#micBtn'); await sleep(200);
    if (await q.isVisible('#nudge')) await q.click('#nudgeLater');
    await q.click('#moreBtn'); await sleep(500);
    await q.click('#syncChk'); await sleep(200);
    const noCfg = await q.textContent('#toast'); assert.strictEqual(await q.isChecked('#syncChk'), false);
    await q.fill('#syncUrl', link); await q.dispatchEvent('#syncUrl', 'change');
    assert.strictEqual(await q.inputValue('#syncUrl'), fake.url); assert.strictEqual(await q.inputValue('#syncToken'), TOKEN);
    await q.click('#syncChk');
    await until(async () => rows().some(x => x[4] === 'second phone note'));
    pass(`manual setup: toggle without config → "${noCfg}"; pasting the pairing link fills URL + token; toggle on → backfilled`);

    // ---- hostile pairing link is refused ----
    await q.goto(BASE + '#sync=' + encodeURIComponent('https://evil.example.com/collect') + '&token=x'); await q.waitForFunction(() => __dl.ready());
    const evil = await q.textContent('#toast');
    assert.ok(/not an Apps Script/.test(evil) && !(await q.isVisible('#pair')) && !(await q.evaluate(() => location.hash)));
    assert.strictEqual(await q.evaluate(() => __dl.db().settings.sheetSync.url), fake.url);
    pass(`non-Apps-Script pairing link refused: "${evil}" (hash stripped, existing config untouched)`);

    const final = rows();
    const ids = final.map(x => x[8]);
    assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate note ids in the sheet');
    assert.deepStrictEqual(errs, []);
    pass(`sheet ends with ${final.length} rows, no duplicate Note IDs; no page errors`);
    await p.screenshot({ path: '/tmp/sync-main.png' });
    await q.screenshot({ path: '/tmp/sync-more.png' });
    console.log('\nSheets sync tests passed');
  } finally { await b.close(); fake.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });

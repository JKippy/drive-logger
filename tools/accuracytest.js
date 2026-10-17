// End-to-end accuracy features in the real app with a fake recognizer. Run: NODE_PATH=/tmp/pw/node_modules node tools/accuracytest.js
const { chromium } = require('playwright-core');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';   // e.g. https://jkippy.github.io/drive-logger/
const assert = require('assert');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('driveLogger.v1.seenHelp', '1');
    class FakeSR { constructor(){ window.__sr = this; this.res = []; } start(){ this.res = []; window.__maxAlt = this.maxAlternatives; setTimeout(()=>this.onstart&&this.onstart(),5);} stop(){ setTimeout(()=>this.onend&&this.onend(),5);} abort(){ this.stop(); } }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
    Object.defineProperty(window, 'speechSynthesis', { value: { speak(u){ setTimeout(()=>u.onend&&u.onend(), 20); }, cancel(){} } });
    window.SpeechSynthesisUtterance = function(t){ this.text=t; };
    window.__sayAlts = (alts, final) => { const sr = window.__sr; const r = alts.map(t => ({ transcript: t, confidence: 0 })); r.isFinal = !!final;
      const last = sr.res[sr.res.length-1]; if (last && !last.isFinal) sr.res[sr.res.length-1] = r; else sr.res.push(r);
      sr.onresult({ results: sr.res.slice(), resultIndex: sr.res.length-1 }); };
  });
  const p = await ctx.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(BASE);
  await p.click('#micBtn'); await p.waitForTimeout(150);
  const notes = () => p.evaluate(() => JSON.parse(localStorage.getItem('driveLogger.v1')).notes.map(n => n.type[0] + ': ' + n.text));
  const say = async (alts, label) => {
    await p.evaluate(a => __sayAlts(a, true), alts);
    await p.waitForTimeout(150);
    const fresh = await p.evaluate(() => { const el = document.querySelector('.hcard.fresh'); return el ? getComputedStyle(el).backgroundColor : null; });
    await p.waitForTimeout(650);
    const n = await notes(); console.log(label.padEnd(52), JSON.stringify(n[n.length - 1]), fresh ? '(flat highlight ' + fresh + ')' : '');
    return n[n.length - 1];
  };
  console.log('maxAlternatives requested:', await p.evaluate(() => window.__maxAlt));
  assert.strictEqual(await say(['the blog post near exit 3', 'log pothole near exit 3'], 'alt #2 has the keyword'), 'L: pothole near exit 3');
  assert.strictEqual(await say(['In convention took over at the light'], 'fuzzy: "In convention …"'), 'I: took over at the light');
  assert.strictEqual(await say(['blog sun glare washed out the camera'], 'fuzzy: "blog …"'), 'L: sun glare washed out the camera');
  assert.strictEqual(await say(['log way mo van cut in, lie dar fault suspected'], 'corrections: "way mo", "lie dar"'), 'L: Waymo van cut in, lidar fault suspected');
  const before = (await notes()).length;
  await p.evaluate(a => __sayAlts(a, true), ['we took the long way around the lock']); await p.waitForTimeout(600);
  assert.strictEqual((await notes()).length, before); console.log('no false trigger: "we took the long way around the lock"'.padEnd(52), 'no note ✓');
  // user-added correction through the sheet UI
  await p.click('#moreBtn'); await p.waitForTimeout(400);
  await p.fill('#corrFrom', 'grand rivers'); await p.fill('#corrTo', 'Grand River'); await p.click('#corrForm button');
  await p.click('#sheetClose'); await p.waitForTimeout(500);
  assert.strictEqual(await say(['log merge onto grand rivers was smooth'], 'user correction added in the sheet'), 'L: merge onto Grand River was smooth');
  assert.strictEqual(await say(['Log, high priority. Way mo stopped in the crosswalk.'], 'corrections + inline priority'), 'L: Waymo stopped in the crosswalk $$$');
  console.log('\nAccuracy flow passed');
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });

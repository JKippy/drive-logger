// When does a note get its timestamp? Run: NODE_PATH=/tmp/pw/node_modules node tools/timestamptest.js
const { chromium } = require('playwright-core');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';   // e.g. https://jkippy.github.io/drive-logger/
const assert = require('assert');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Detroit' });
  await ctx.addInitScript(() => {
    class FakeSR { constructor(){ window.__sr = this; this.res = []; } start(){ this.res = []; setTimeout(()=>this.onstart&&this.onstart(),5);} stop(){ setTimeout(()=>this.onend&&this.onend(),5);} abort(){ this.stop(); } }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
    Object.defineProperty(window, 'speechSynthesis', { value: { speak(u){ setTimeout(()=>u.onend&&u.onend(), 20); }, cancel(){} } });
    window.SpeechSynthesisUtterance = function(t){ this.text=t; };
    window.__say = (t, final) => { const sr = window.__sr; const r=[{transcript:t}]; r.isFinal=!!final; const last = sr.res[sr.res.length-1];
      if (last && !last.isFinal) sr.res[sr.res.length-1] = r; else sr.res.push(r); sr.onresult({ results: sr.res.slice(), resultIndex: sr.res.length-1 }); return Date.now(); };
  });
  const p = await ctx.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(BASE);
  await p.click('#micBtn'); await p.waitForTimeout(150);
  const last = () => p.evaluate(() => { const n = JSON.parse(localStorage.getItem('driveLogger.v1')).notes; const x = n[n.length-1];
    return { ts: x.ts, text: x.text, iso: DLCore.row(x)[2], time: DLCore.row(x)[1] }; });
  const say = (t, f) => p.evaluate(([t, f]) => __say(t, f), [t, f]);

  // A: keyword opens the utterance; recognizer shows "okay" first, the keyword 700 ms later
  const t0 = await say('okay', false); await p.waitForTimeout(700);
  const t1 = await say('okay log brake fade on the downhill', false); await p.waitForTimeout(600);
  await say('okay log brake fade on the downhill', true); await p.waitForTimeout(800);
  let n = await last();
  console.log(`A  leading keyword: note.ts - first words = ${n.ts - t0} ms, keyword appeared at +${t1 - t0} ms → ${n.time}  ${n.iso}`);
  assert.ok(Math.abs(n.ts - t0) < 30, 'stamped at utterance start');
  assert.ok(/-04:00$/.test(n.iso));

  // B: keyword in the middle of an utterance → stamped when the keyword itself first appears
  const t2 = await say('traffic is heavy here', false); await p.waitForTimeout(800);
  const t3 = await say('traffic is heavy here intervention took over at the merge', false); await p.waitForTimeout(500);
  await say('traffic is heavy here intervention took over at the merge', true); await p.waitForTimeout(800);
  n = await last();
  console.log(`B  mid-utterance keyword: note.ts - keyword appeared = ${n.ts - t3} ms (utterance began ${t3 - t2} ms earlier) → ${n.time}  ${n.iso}`);
  assert.ok(Math.abs(n.ts - t3) < 30);

  // C: on-screen "Now" clock uses the same clock/format as note times
  const clock = await p.textContent('#clock'), local = await p.evaluate(() => DLCore.localTime(new Date()));
  console.log(`C  Now clock "${clock}" vs device local time "${local}"; status row: "${await p.textContent('#gpsText')}" / "Drive ${await p.textContent('#elapsed')}"`);
  assert.ok(/^\d\d:\d\d:\d\d$/.test(clock));
  console.log('\nTimestamp tests passed');
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });

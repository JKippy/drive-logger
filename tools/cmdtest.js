const { chromium } = require('playwright-core');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';   // e.g. https://jkippy.github.io/drive-logger/
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('driveLogger.v1.seenHelp', '1');
    window.__log = [];
    class FakeSR { constructor(){ window.__sr = this; this.running=false; }
      start(){ this.running=true; window.__log.push('rec:start'); setTimeout(()=>this.onstart&&this.onstart(),5);} 
      stop(){ this.abort(); } abort(){ if(!this.running) return; this.running=false; window.__log.push('rec:abort'); setTimeout(()=>this.onend&&this.onend(),5);} }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
    // fake TTS: records what is said and whether the mic was off while speaking
    window.__spoken = [];
    const fake = { speaking:false, speak(u){ if(!u.text.trim()) return; window.__spoken.push(u.text); window.__log.push('tts:'+u.text+' (mic '+(window.__sr.running?'ON!':'off')+')');
        setTimeout(()=>u.onend&&u.onend(), 300); }, cancel(){} };
    Object.defineProperty(window, 'speechSynthesis', { value: fake });
    window.SpeechSynthesisUtterance = function(t){ this.text=t; };
    window.__say = (t, final) => { const sr = window.__sr; sr.res = sr.res || [];
      const last = sr.res[sr.res.length-1]; const r=[{transcript:t}]; r.isFinal=!!final;
      if (last && !last.isFinal) sr.res[sr.res.length-1] = r; else sr.res.push(r);
      sr.onresult({results: sr.res.slice(), resultIndex: sr.res.length-1}); };
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(BASE);
  await p.click('#micBtn'); await p.waitForTimeout(100);
  const say = async (t, final, wait) => { await p.evaluate(([t,f]) => __say(t, f), [t, final]); await p.waitForTimeout(wait || 1200); };
  const notes = () => p.evaluate(() => JSON.parse(localStorage.getItem('driveLogger.v1')).notes.map(n => n.type[0] + ': ' + n.text));
  const step = async (label, t, final, wait) => { await say(t, final, wait); console.log(label.padEnd(44), JSON.stringify(await notes())); };

  await step('log brake fade (final)', 'okay log brake fade on the downhill', true);
  await step('"give that last one a high priority" (silence)', 'give that last one a high priority', false, 2000);
  await step('"make it medium" → replace', 'make it medium', true);
  await step('"log high priority pothole…" inline', 'log high priority pothole in the right lane', true);
  await step('"give the one before that low priority"', 'give the one before that low priority', true);
  await step('"scratch that"', 'scratch that', true);
  await step('"bring that back"', 'bring that back', true);
  await step('"add to that, it was raining"', 'add to that, it was raining', true);
  await step('"pause notes"', 'pause notes', true);
  console.log('   status while paused:', await p.textContent('#statusText'), '/', await p.textContent('#orbLabel'), '/ orb:', await p.getAttribute('#orb','class'));
  await step('(paused) "log should be ignored"', 'log should be ignored', true);
  await step('(paused) "mark that high priority"', 'mark that high priority', true);
  await step('"resume notes"', 'resume notes', true);
  console.log('   status after resume:', await p.textContent('#statusText'));
  await step('"mark" (silence)', 'mark', false, 3800);
  await step('"add to that cut off by a truck"', 'add to that cut off by a truck', true);
  await step('"change that to an intervention"', 'change that to an intervention', true);
  await step('"log driver said that was a high speed merge"', 'log driver said that was a high speed merge', true);
  await step('"how many interventions"', 'how many interventions', true);
  // echo check: results arriving while TTS is speaking must be dropped
  await p.evaluate(() => __say('log brake fade on the downhill', true)); await p.waitForTimeout(50);
  await p.evaluate(() => __say('log this is the app talking', true));
  await p.waitForTimeout(1200);
  console.log('echo check (2nd result during TTS dropped)'.padEnd(44), JSON.stringify(await notes()));
  console.log('\nSPOKEN:', JSON.stringify(await p.evaluate(() => __spoken)));
  const log = await p.evaluate(() => __log);
  console.log('TTS with mic ON (should be 0):', log.filter(l => l.includes('mic ON!')).length, '| tts count:', log.filter(l=>l.startsWith('tts:')).length, '| rec restarts:', log.filter(l=>l==='rec:start').length);
  console.log('FEED:', JSON.stringify(await p.textContent('#feed')));
  await b.close();
})();

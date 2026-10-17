// Screenshots with sample notes seeded in THIS headless context only. Run: NODE_PATH=/tmp/pw/node_modules node tools/shot.js
const { chromium } = require('playwright-core');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';   // e.g. https://jkippy.github.io/drive-logger/
const OUT = require('path').join(__dirname, '..') + '/';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
function seed() {
  const start = Date.now() - (47 * 60 + 12) * 1000, s = 'demo1';
  const pts = [[42.47702, -83.48120], [42.48061, -83.47552], [42.48390, -83.46811], [42.49012, -83.45930], [42.49530, -83.45102], [42.50122, -83.44476]];
  const notes = [
    [-2650, 'Log', 'Waymo van double-parked, slow pass on the left'],
    [-2400, 'Log', 'left lane drift near exit 12 $'],
    [-1900, 'Log', 'phantom braking under the overpass $$'],
    [-1300, 'Intervention', 'swerved toward cones in construction zone'],
    [-700, 'Log', 'smooth unprotected left onto Grand River'],
    [-95, 'Intervention', 'took over at the light, car did not yield to pedestrian $$$'],
  ].map(([dt, type, text], i) => ({ id: 'n' + i, session: s, ts: Date.now() + dt * 1000, type, text, source: 'voice', created: Date.now(),
     lat: pts[i][0], lon: pts[i][1], acc: 5 }));
  localStorage.setItem('driveLogger.v1', JSON.stringify({ sessions: [{ id: s, name: 'Drive 2026-10-16 14:02', start }], notes, current: s, view: s,
    settings: { v: 3, gps: true, replies: 'voice', side: 'left', night: false } }));
  class FakeSR { constructor(){ window.__sr = this; } start(){ setTimeout(()=>this.onstart&&this.onstart(),10);} stop(){} abort(){} }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  Object.defineProperty(window, 'speechSynthesis', { value: { speak(u){ setTimeout(()=>u.onend&&u.onend(), 30); }, cancel(){} } });
  window.SpeechSynthesisUtterance = function(t){ this.text=t; };
  if (!navigator.share) { navigator.share = () => Promise.resolve(); navigator.canShare = () => true; }   // show Share like iOS does
}
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [w, h, file] of [[390, 844, 'screenshot.png'], [844, 390, 'screenshot-landscape.png']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA,
      permissions: ['geolocation'], geolocation: { latitude: 42.50122, longitude: -83.44476, accuracy: 5 } });
    await ctx.addInitScript(seed);
    const p = await ctx.newPage();
    await p.goto(BASE);
    await p.click('#micBtn'); await p.waitForTimeout(400);
    await p.evaluate(() => window.__dl.exec({ cmd: 'priority', level: 'high', target: 1 }));   // feed line: "✓ Marked last note high priority"
    await p.waitForTimeout(500);
    await p.evaluate(() => { const r=[{transcript:'okay log merging truck drifting onto the right shoulder near the on-ramp'}]; r.isFinal=false; window.__sr.onresult({results:[r], resultIndex:0}); });
    await p.waitForTimeout(1500);   // let animations settle (silence commit is at 2.5 s)
    await p.screenshot({ path: OUT + file });
    if (w === 390) {
      await p.click('#micBtn'); await p.waitForTimeout(300);   // stop, so nothing commits behind the sheet
      await p.click('#moreBtn'); await p.waitForTimeout(700);
      await p.screenshot({ path: OUT + 'screenshot-sheet.png' });
      await p.evaluate(() => { document.getElementById('help').open = true; document.querySelector('.sheet').scrollTop = 1e5; });
      await p.waitForTimeout(300);
      await p.screenshot({ path: OUT + 'screenshot-help.png' });
    }
    await ctx.close();
  }
  await b.close();
})();

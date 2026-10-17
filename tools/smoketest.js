// Smoke test a deployed copy: loads, service worker registers with the right scope, manifest valid, no console errors.
// Run: BASE_URL=https://jkippy.github.io/drive-logger/ NODE_PATH=/tmp/pw/node_modules node tools/smoketest.js
const { chromium } = require('playwright-core');
const assert = require('assert');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787/';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errors = [], failed = [];
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('requestfailed', r => failed.push(r.url() + ' ' + (r.failure() && r.failure().errorText)));
  p.on('response', r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
  const resp = await p.goto(BASE, { waitUntil: 'networkidle' });
  console.log('page:', resp.status(), resp.url(), '| title:', await p.title());
  assert.strictEqual(resp.status(), 200);
  const sw = await p.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('SW not ready in 15s')), 15000))]);
    return { scope: reg.scope, script: (reg.active || reg.waiting || reg.installing).scriptURL, state: (reg.active || {}).state };
  });
  console.log('service worker:', JSON.stringify(sw));
  assert.strictEqual(sw.scope, new URL('./', BASE).href);
  const man = await p.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]').href, r = await fetch(href), j = await r.json();
    const abs = u => new URL(u, href).href;
    const icons = await Promise.all(j.icons.map(async i => ({ src: abs(i.src), sizes: i.sizes, status: (await fetch(abs(i.src))).status })));
    const touch = document.querySelector('link[rel=apple-touch-icon]').href;
    return { href, status: r.status, ctype: r.headers.get('content-type'), name: j.name, display: j.display,
      start_url: abs(j.start_url), scope: abs(j.scope), id: abs(j.id || j.start_url), icons, touch, touchStatus: (await fetch(touch)).status };
  });
  console.log('manifest:', JSON.stringify(man, null, 1));
  assert.strictEqual(man.status, 200);
  assert.strictEqual(man.display, 'standalone');
  assert.strictEqual(man.start_url, new URL('./', BASE).href);
  assert.strictEqual(man.scope, new URL('./', BASE).href);
  assert.ok(man.icons.length >= 2 && man.icons.every(i => i.status === 200) && man.touchStatus === 200);
  const ui = await p.evaluate(() => ({ orb: !!document.getElementById('orb'), status: document.getElementById('statusText').textContent,
    cache: null }));
  const caches = await p.evaluate(async () => (await caches.keys()));
  console.log('ui:', JSON.stringify(ui), '| caches:', JSON.stringify(caches));
  console.log('console errors:', errors.length ? errors : 'none', '| failed requests:', failed.length ? failed : 'none');
  assert.strictEqual(errors.length, 0); assert.strictEqual(failed.length, 0);
  console.log('\nSmoke test passed for ' + BASE);
  await b.close();
})().catch(e => { console.error('FAIL', e.message || e); process.exit(1); });

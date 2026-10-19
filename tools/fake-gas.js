// Fake Google Apps Script web app that behaves like the real one (checked against a live deployment):
//  POST/GET https://script.google.com/macros/s/<id>/exec → runs doPost/doGet, then 302 (access-control-allow-origin: *)
//  → https://script.googleusercontent.com/macros/echo?user_content_key=… → 200 application/json (ACAO *), one-time.
//  Unknown deployment id → 404 HTML without CORS headers. OPTIONS (preflight) → 405, Apps Script can't answer it.
//  mode 'private' → 200 HTML sign-in page without CORS headers (deployment access not set to "Anyone").
//  mode 'down' → 500 HTML. Runs the REAL docs/sheets-sync.gs on a mock Sheets runtime (tools/gas-mock.js).
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const GAS = require('./gas-mock.js');

function start({ token, scriptPath, id = 'AKfycbFAKEdeploymentID0123456789' } = {}) {
  const src = fs.readFileSync(scriptPath || path.join(__dirname, '..', 'docs', 'sheets-sync.gs'), 'utf8');
  const tmp = path.join(os.tmpdir(), 'dl-fake-gas-' + process.pid + '.gs');
  fs.writeFileSync(tmp, src.replace("'REPLACE-WITH-A-LONG-RANDOM-STRING'", JSON.stringify(token)));
  const gas = GAS.load(tmp, { preTab: 'Notes', headers: ['Time (cmd+shift+:)', 'Logtime (s)', 'Type', 'Triage Priority', 'Comments', 'Lat', 'Lon', 'Session', 'Note ID', 'Updated', 'Deleted', 'Received'] });
  const echo = new Map(), log = [];
  let mode = 'ok', scriptPort, contentPort;
  const html = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!DOCTYPE html><html><body>' + body + '</body></html>'); };
  const script = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      log.push({ method: req.method, path: u.pathname, ct: req.headers['content-type'] || '', origin: req.headers.origin || '', body });
      if (req.method === 'OPTIONS') return html(res, 405, 'Method Not Allowed');
      if (u.pathname !== `/macros/s/${id}/exec`) return html(res, 404, 'Sorry, unable to open the file at this time.');
      if (mode === 'private') return html(res, 200, 'Sign in – Google Accounts');
      if (mode === 'down') return html(res, 500, 'Internal error');
      let out;
      try { out = req.method === 'POST' ? gas.post(body) : req.method === 'GET' ? gas.get() : null; } catch (e) { return html(res, 200, 'Script error: ' + e.message); }
      if (!out) return html(res, 405, 'Method Not Allowed');
      const key = crypto.randomBytes(12).toString('hex');
      echo.set(key, JSON.stringify(out.json));
      res.writeHead(302, { 'access-control-allow-origin': '*', 'content-type': 'application/binary',
        location: `http://localhost:${contentPort}/macros/echo?user_content_key=${key}&lib=FAKE` });
      res.end();
    });
  });
  const content = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), key = u.searchParams.get('user_content_key');
    log.push({ method: req.method, path: u.pathname, echo: true });
    if (req.method !== 'GET' || u.pathname !== '/macros/echo' || !echo.has(key)) return html(res, 404, 'Not found');
    const b = echo.get(key); echo.delete(key);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(b);
  });
  return new Promise(r => script.listen(0, '127.0.0.1', () => content.listen(0, '127.0.0.1', () => {
    scriptPort = script.address().port; contentPort = content.address().port;
    r({ url: `http://127.0.0.1:${scriptPort}/macros/s/${id}/exec`, badUrl: `http://127.0.0.1:${scriptPort}/macros/s/AKfycbWRONGid000000000/exec`,
      gas, log, rows: () => gas.tab('Notes')._rows(), setMode: m => { mode = m; },
      close: () => { script.close(); content.close(); try { fs.unlinkSync(tmp); } catch (e) {} } });
  })));
}
module.exports = { start };
if (require.main === module) start({ token: process.env.DL_TOKEN || 'dev-token' }).then(f => console.log('fake Apps Script at', f.url));

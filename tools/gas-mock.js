// Minimal Apps Script runtime (SpreadsheetApp / LockService / ContentService) to run docs/sheets-sync.gs in Node.
// Strict where real Apps Script is strict: setValues() must match the range size exactly.
const vm = require('vm'), fs = require('fs');

function makeSheet(name) {
  const grid = [], fmt = {}, quoted = {};
  let frozen = 0;
  const lastRow = () => { for (let r = grid.length; r > 0; r--) if ((grid[r - 1] || []).some(v => v !== '' && v != null)) return r; return 0; };
  const lastCol = () => grid.reduce((m, row) => { for (let c = (row || []).length; c > 0; c--) if (row[c - 1] !== '' && row[c - 1] != null) return Math.max(m, c); return m; }, 0);
  const sh = {
    getName: () => name, getLastRow: lastRow, getLastColumn: lastCol, getMaxRows: () => 1000,
    setFrozenRows: n => { frozen = n; }, getFrozenRows: () => frozen,
    getRange(r, c, nr = 1, nc = 1) {
      if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`);
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v == null ? '' : v; })),
        setValues(vals) {
          if (!Array.isArray(vals) || vals.length !== nr || vals.some(row => !Array.isArray(row) || row.length !== nc))
            throw new Error(`The number of rows or columns in the data does not match the range (${nr}x${nc})`);
          vals.forEach((row, i) => row.forEach((v, j) => {
            const R = r - 1 + i, C = c - 1 + j; grid[R] = grid[R] || [];
            if (typeof v === 'string' && v[0] === "'") { grid[R][C] = v.slice(1); quoted[R + ',' + C] = true; }
            else { grid[R][C] = v; delete quoted[R + ',' + C]; }
          }));
          return this;
        },
        setNumberFormat(f) { for (let j = 0; j < nc; j++) fmt[c - 1 + j] = f; return this; },
      };
    },
    _grid: grid, _fmt: fmt, _quoted: quoted,
    _rows() { const n = lastRow(), w = lastCol(); return sh.getRange(1, 1, Math.max(n, 1), Math.max(w, 1)).getValues().slice(0, n); },
  };
  return sh;
}

function load(scriptPath, opts = {}) {
  const sheets = {};
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet(n)), _sheets: sheets };
  if (opts.preTab) { const s = ss.insertSheet(opts.preTab); if (opts.headers) s.getRange(1, 1, 1, opts.headers.length).setValues([opts.headers]); }
  const locks = { held: 0, taken: 0 };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    LockService: { getScriptLock: () => ({ tryLock() { locks.held++; locks.taken++; return true; }, waitLock() { locks.held++; locks.taken++; }, releaseLock() { locks.held--; } }) },
    ContentService: { MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: s => ({ content: s, mime: 'text/plain', setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } }) },
    Date, JSON, Math, String, Array, Object, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), ctx, { filename: scriptPath });
  const post = body => { const o = ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: 'text/plain' } }); return { mime: o.mime, json: JSON.parse(o.content) }; };
  const get = () => { const o = ctx.doGet({ parameter: {} }); return { mime: o.mime, json: JSON.parse(o.content) }; };
  return { post, get, ss, locks, tab: name => sheets[name] };
}
module.exports = { load };

/* Drive Logger storage adapter: every write goes to BOTH localStorage (synchronous) and IndexedDB (async,
   strict durability). Exposes health so the UI can warn when either store fails. window.DLStore */
(function () {
  'use strict';
  var LS_KEY = 'driveLogger.v1', LS_DRAFTS = 'driveLogger.drafts', LS_OUTBOX = 'driveLogger.outbox', LS_JOURNAL = 'driveLogger.journal';
  var LS_JOURNAL_MAX = 500;   // localStorage keeps a mirror of the newest journal entries; IndexedDB keeps all of them
  var DB_NAME = 'driveLogger', DB_VER = 1;
  var health = { ls: 'ok', idb: 'pending', lsErr: '', idbErr: '' }, listeners = [];
  function setHealth(k, v, err) {
    var e = err ? String(err.name || err.message || err) : '';
    if (health[k] === v && health[k + 'Err'] === e) return;
    health[k] = v; health[k + 'Err'] = e;
    listeners.forEach(function (f) { try { f(health); } catch (x) {} });
  }

  // ---------- localStorage ----------
  function readLS() {
    var raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { setHealth('ls', 'fail', e); return { state: null, error: e }; }
    if (!raw) return { state: null };
    try { return { state: JSON.parse(raw) }; } catch (e) { return { state: null, error: e, corrupt: true }; }
  }
  function writeLS(db) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); setHealth('ls', 'ok'); return true; }
    catch (e) { setHealth('ls', 'fail', e); return false; }
  }
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeJSON(key, v) {
    try { if (v == null || (Array.isArray(v) && !v.length)) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); return true; }
    catch (e) { setHealth('ls', 'fail', e); return false; }
  }

  // ---------- IndexedDB ----------
  var idbP = null;
  function open() {
    if (idbP) return idbP;
    idbP = new Promise(function (resolve) {
      if (!window.indexedDB) { setHealth('idb', 'unavailable'); return resolve(null); }
      var done = false, req;
      var t = setTimeout(function () { if (!done) { done = true; setHealth('idb', 'fail', 'timeout'); resolve(null); } }, 4000);
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { done = true; clearTimeout(t); setHealth('idb', 'fail', e); return resolve(null); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        if (!d.objectStoreNames.contains('journal')) d.createObjectStore('journal', { autoIncrement: true });
        if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'key' });
      };
      req.onsuccess = function () {
        var d = req.result;
        if (done) { try { d.close(); } catch (e) {} return; }
        done = true; clearTimeout(t);
        d.onversionchange = function () { d.close(); idbP = null; };
        setHealth('idb', 'ok'); resolve(d);
      };
      req.onerror = function () { if (done) return; done = true; clearTimeout(t); setHealth('idb', 'fail', req.error); resolve(null); };
    });
    return idbP;
  }
  function tx(stores, mode, fn) {
    return open().then(function (d) {
      if (!d) throw new Error('IndexedDB unavailable');
      return new Promise(function (res, rej) {
        var t;
        try { t = d.transaction(stores, mode, { durability: 'strict' }); } catch (e) { try { t = d.transaction(stores, mode); } catch (e2) { return rej(e2); } }
        var out = {}; fn(t, out);
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('IndexedDB write aborted')); };
      });
    });
  }
  function getAll(store, out, key) { var r = store.getAll(); r.onsuccess = function () { out[key] = r.result; }; }

  /** Everything IndexedDB holds: { state|null, drafts[] }. Never rejects. */
  function readIDB() {
    return tx(['notes', 'meta', 'drafts'], 'readonly', function (t, out) {
      getAll(t.objectStore('notes'), out, 'notes'); getAll(t.objectStore('drafts'), out, 'drafts');
      var m = t.objectStore('meta').get('state'); m.onsuccess = function () { out.meta = m.result; };
    }).then(function (o) {
      var notes = o.notes || [], meta = o.meta;
      var state = meta || notes.length ? { sessions: (meta && meta.sessions) || [], notes: notes, settings: (meta && meta.settings) || {},
        current: meta && meta.current, view: meta && meta.view, savedAt: (meta && meta.savedAt) || 0 } : null;
      return { state: state, drafts: o.drafts || [] };
    }).catch(function (e) { if (health.idb === 'ok') setHealth('idb', 'fail', e); return { state: null, drafts: [], error: e }; });
  }
  function metaOf(db) { return { sessions: db.sessions, settings: db.settings, current: db.current, view: db.view, savedAt: db.savedAt }; }

  // IndexedDB writes are chained so they land in order. The chain is held closed until the app has READ IndexedDB at
  // boot (release()), so a placeholder state written before the read can't clobber what IndexedDB already holds.
  var releaseGate, chain = new Promise(function (r) { releaseGate = r; });
  function release() { if (releaseGate) { releaseGate(); releaseGate = null; } }
  function queue(fn) {
    chain = chain.then(fn).then(function () { setHealth('idb', 'ok'); }, function (e) { if (health.idb !== 'unavailable') setHealth('idb', 'fail', e); });
    return chain;
  }

  /** Save the state. `notes` = notes that changed ('all' for a full resync), `journal` = change events to append. */
  function write(db, notes, journal) {
    db.savedAt = Date.now();
    var okLS = writeLS(db);
    var meta = JSON.parse(JSON.stringify(metaOf(db)));
    var list = notes === 'all' ? db.notes : (notes || []);
    list = JSON.parse(JSON.stringify(list));
    var entries = journal ? JSON.parse(JSON.stringify(journal)) : [];
    if (entries.length) { var lj = readJSON(LS_JOURNAL); lj = (Array.isArray(lj) ? lj : []).concat(entries); writeJSON(LS_JOURNAL, lj.slice(-LS_JOURNAL_MAX)); }
    queue(function () {
      return tx(['notes', 'meta', 'journal'], 'readwrite', function (t) {
        var ns = t.objectStore('notes'); list.forEach(function (n) { ns.put(n); });
        t.objectStore('meta').put(meta, 'state');
        var js = t.objectStore('journal'); entries.forEach(function (e) { js.add(e); });
      });
    });
    return okLS;
  }
  function flushed() { return chain; }

  // ---------- drafts ----------
  var lastDrafts = '[]';
  function writeDrafts(list, force) {
    var s = JSON.stringify(list || []);
    if (s === lastDrafts && !force) return;
    lastDrafts = s; writeJSON(LS_DRAFTS, list);
    var copy = JSON.parse(s);
    queue(function () { return tx(['drafts'], 'readwrite', function (t) { var st = t.objectStore('drafts'); st.clear(); copy.forEach(function (d) { st.put(d); }); }); });
  }
  function readLSDrafts() { var d = readJSON(LS_DRAFTS); return Array.isArray(d) ? d : []; }

  // ---------- journal ----------
  /** Journal from both stores, merged and deduped; whichever store is missing entries (wiped/evicted) is healed. */
  function readJournal() {
    var lj = readJSON(LS_JOURNAL); lj = Array.isArray(lj) ? lj : [];
    return tx(['journal'], 'readonly', function (t, out) { getAll(t.objectStore('journal'), out, 'j'); })
      .then(function (o) { return o.j || []; }, function () { return null; })
      .then(function (ij) {
        var m = window.DLPersist.mergeJournal(ij || [], lj);
        if (ij && m.length > ij.length) replaceJournal(m);
        if (lj.length < Math.min(m.length, LS_JOURNAL_MAX)) writeJSON(LS_JOURNAL, m.slice(-LS_JOURNAL_MAX));
        return m;
      });
  }
  function replaceJournal(entries) {
    var copy = JSON.parse(JSON.stringify(entries || []));
    return queue(function () { return tx(['journal'], 'readwrite', function (t) { var st = t.objectStore('journal'); st.clear(); copy.forEach(function (e) { st.add(e); }); }); });
  }

  // ---------- durability info ----------
  function persist() {
    var s = navigator.storage;
    if (!s || !s.persisted) return Promise.resolve(null);
    return s.persisted().then(function (p) { return p || (s.persist ? s.persist() : false); }).catch(function () { return null; });
  }
  function estimate() {
    var s = navigator.storage; if (!s || !s.estimate) return Promise.resolve(null);
    return s.estimate().catch(function () { return null; });
  }
  /** Best-effort Private Browsing detection (WebKit heuristics). Resolves true / false / null (unknown). */
  function detectPrivate() {
    return new Promise(function (resolve) {
      try { localStorage.setItem('__dl_t', '1'); localStorage.removeItem('__dl_t'); } catch (e) { return resolve(true); }
      var isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|CriOS|Chromium|Edg|Android/.test(navigator.userAgent);
      if (!isWebKit) return resolve(false);
      if (navigator.storage && navigator.storage.getDirectory) {       // Safari 17+: OPFS is refused in Private Browsing
        navigator.storage.getDirectory().then(function () { resolve(false); },
          function (e) { resolve(/unknown transient reason/i.test(String(e && e.message))); });
        return;
      }
      try {                                                            // Safari 13–16: Blobs can't be stored in private IDB
        var name = '__dl_p' + Math.random(), req = indexedDB.open(name, 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          try { d.createObjectStore('t', { autoIncrement: true }).put(new Blob()); resolve(false); }
          catch (e) { resolve(/not yet supported/i.test(String(e && e.message))); }
          finally { d.close(); indexedDB.deleteDatabase(name); }
        };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  window.DLStore = {
    LS_KEY: LS_KEY, LS_DRAFTS: LS_DRAFTS, LS_OUTBOX: LS_OUTBOX, DB_NAME: DB_NAME,
    health: function () { return health; }, onHealth: function (f) { listeners.push(f); },
    readLS: readLS, readIDB: readIDB, open: open, write: write, flushed: flushed, release: release,
    writeDrafts: writeDrafts, readLSDrafts: readLSDrafts, readJournal: readJournal, replaceJournal: replaceJournal,
    readJSON: readJSON, writeJSON: writeJSON, persist: persist, estimate: estimate, detectPrivate: detectPrivate
  };
})();

/* Sheets backup: every note change is queued in an outbox (localStorage) and POSTed to a Google Apps Script web app
   (docs/sheets-sync.gs), which upserts it into the sheet by note id. Off until configured in More › Sheets backup. */
(function () {
  'use strict';
  var P = window.DLPersist, S = window.DLStore, LS_STATE = 'driveLogger.syncState', BATCH = 50;
  var cfg = null, timer = null, busy = false, tries = 0, listeners = [], describe = function () { return {}; };
  var st = S.readJSON(LS_STATE) || {};
  st = { lastSync: st.lastSync || 0, lastError: st.lastError || '', lastErrorAt: st.lastErrorAt || 0 };
  function box() { var b = S.readJSON(S.LS_OUTBOX); return Array.isArray(b) ? b : []; }
  function setBox(b) { S.writeJSON(S.LS_OUTBOX, b); }
  function status() { return { enabled: !!cfg, pending: box().length, busy: busy, lastSync: st.lastSync, lastError: st.lastError, lastErrorAt: st.lastErrorAt }; }
  function emit() { var x = status(); listeners.forEach(function (f) { try { f(x); } catch (e) {} }); }
  function keep(patch) { for (var k in patch) st[k] = patch[k]; S.writeJSON(LS_STATE, st); emit(); }

  /** Endpoint must be an Apps Script /exec URL (127.0.0.1/localhost allowed for development). */
  function validUrl(u) {
    return /^https:\/\/script\.google\.com\/(a\/macros\/[^\/\s]+|macros)\/s\/[\w-]{10,}\/exec$/.test(u || '') ||
      /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\S*$/.test(u || '');
  }
  /** "…#sync=<encoded url>&token=<token>" (a whole link or just the hash) → { url, token } | null */
  function parsePairing(text) {
    var i = String(text || '').indexOf('sync='); if (i < 0) return null;
    var q = new URLSearchParams(String(text).slice(i).replace(/^#/, '')), url = q.get('sync'), token = q.get('token');
    return url && token ? { url: url.trim(), token: token.trim() } : null;
  }

  function configure(c) {
    var on = !!(c && c.enabled && validUrl(c.url) && c.token);
    cfg = on ? { url: c.url, token: c.token } : null;
    clearTimeout(timer); if (cfg) schedule(400); emit();
  }
  function enqueue(op, n) { if (!cfg || !n || !n.id) return; setBox(P.outboxAdd(box(), op, n)); emit(); schedule(800); }
  /** Queue every given note (used when sync is switched on, the endpoint changes, or after a restore). */
  function backfill(notes) {
    if (!cfg) return 0;
    var b = box(); (notes || []).forEach(function (n) { b = P.outboxAdd(b, 'backfill', n); });
    setBox(b); emit(); schedule(100); return notes.length;
  }
  function schedule(ms) { clearTimeout(timer); if (cfg) timer = setTimeout(flush, ms); }

  function payload(e) {
    var C = window.DLCore, d = describe(e.note) || {};
    return { op: e.op, v: e.v, note: e.note, row: C ? C.row(e.note, { gps: true }) : null, session: d.session || '',
      updated: C && e.v ? C.isoLocal(new Date(e.v)) : '' };
  }
  /** POST a text/plain JSON body (a CORS "simple request": Apps Script can't answer a preflight) and read the JSON reply,
      which Apps Script serves after a 302 to script.googleusercontent.com. Rejects with a readable message. */
  function post(c, body) {
    return fetch(c.url, { method: 'POST', redirect: 'follow', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = JSON.parse(t); } catch (e) {}
          if (!j) throw new Error(/<html|<!doctype/i.test(t) ? 'Got a web page, not JSON: check the URL ends in /exec and access is “Anyone”' : 'Bad response (HTTP ' + r.status + ')');
          if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'Token rejected by the script' : (j.error || 'Rejected'));
          return j;
        });
      }, function () {
        // Google's error pages carry no CORS header, so a wrong URL, access not "Anyone", or a server error all look the same here
        throw new Error(navigator.onLine === false ? 'Offline: will retry' : 'Couldn’t reach the script (network, CORS or server error): check the /exec URL and that access is “Anyone”');
      });
  }
  function flush() {
    timer = null;
    if (!cfg || busy) return Promise.resolve(false);
    var batch = box().slice(0, BATCH);
    if (!batch.length) return Promise.resolve(true);
    if (navigator.onLine === false) { keep({ lastError: 'Offline: will retry', lastErrorAt: Date.now() }); schedule(P.backoff(tries)); return Promise.resolve(false); }
    busy = true; emit();
    var c = cfg;
    return post(c, { token: c.token, events: batch.map(payload) }).then(function () {
      busy = false; tries = 0;
      setBox(P.outboxAck(box(), batch));
      keep({ lastSync: Date.now(), lastError: '' });
      if (box().length) schedule(150);
      return true;
    }, function (e) {
      busy = false; tries++;
      keep({ lastError: e.message, lastErrorAt: Date.now() });
      schedule(P.backoff(tries));
      return false;
    });
  }
  /** Round trip with the given (or current) settings: checks URL, access and token. Resolves the script's reply. */
  function test(c) {
    c = c || cfg;
    if (!c || !validUrl(c.url) || !c.token) return Promise.reject(new Error('Enter the /exec URL and token first'));
    return post(c, { token: c.token, test: true, events: [] }).then(function (j) { keep({ lastError: '' }); return j; },
      function (e) { keep({ lastError: e.message, lastErrorAt: Date.now() }); throw e; });
  }
  // Best effort when the page is hidden/closed: fire the pending batch as a beacon. The outbox is NOT cleared, so it is
  // re-sent later; the script upserts by note id, so the repeat is harmless.
  function beacon() {
    if (!cfg || !navigator.sendBeacon) return;
    var batch = box().slice(0, BATCH); if (!batch.length) return;
    try { navigator.sendBeacon(cfg.url, new Blob([JSON.stringify({ token: cfg.token, events: batch.map(payload) })], { type: 'text/plain;charset=utf-8' })); } catch (e) {}
  }
  window.addEventListener('online', function () { tries = 0; schedule(500); });
  window.addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedule(1000); else beacon(); });
  setInterval(function () { if (cfg && !busy && box().length && !timer) schedule(0); }, 60000);

  window.DLSync = { configure: configure, enqueue: enqueue, backfill: backfill, flush: flush, test: test, status: status,
    onStatus: function (f) { listeners.push(f); }, setDescribe: function (f) { describe = f; },
    validUrl: validUrl, parsePairing: parsePairing, pending: function () { return box().length; },
    clear: function () { setBox([]); keep({ lastError: '' }); } };
})();

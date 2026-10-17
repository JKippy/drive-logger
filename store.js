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

/* Off-phone backup to a Google Sheet via an Apps Script web app. NOT enabled: it does nothing until
   db.settings.sheetSync = { url, token } is set (no UI for that yet). See README "Backing up to Google Sheets". */
(function () {
  'use strict';
  var P = window.DLPersist, S = window.DLStore, cfg = null, timer = null, busy = false, tries = 0;
  function box() { var b = S.readJSON(S.LS_OUTBOX); return Array.isArray(b) ? b : []; }
  function configure(c) { cfg = c && c.url ? c : null; if (cfg) schedule(500); }
  function enqueue(op, n) { if (!cfg) return; S.writeJSON(S.LS_OUTBOX, P.outboxAdd(box(), op, n)); schedule(300); }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(flush, ms); }
  function flush() {
    if (!cfg || busy) return Promise.resolve(false);
    var batch = box().slice(0, 50); if (!batch.length) return Promise.resolve(true);
    if (navigator.onLine === false) { schedule(P.backoff(tries)); return Promise.resolve(false); }
    busy = true;
    // text/plain keeps this a CORS "simple request": Apps Script can't answer an OPTIONS preflight.
    return fetch(cfg.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, events: batch.map(function (e) { return { op: e.op, note: e.note, row: window.DLCore ? DLCore.row(e.note) : null }; }) }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || 'rejected');
        S.writeJSON(S.LS_OUTBOX, P.outboxAck(box(), batch)); tries = 0; busy = false;
        if (box().length) schedule(200);
        return true;
      })
      .catch(function () { busy = false; tries++; schedule(P.backoff(tries)); return false; });
  }
  window.addEventListener('online', function () { schedule(500); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedule(1000); });
  window.DLSync = { configure: configure, enqueue: enqueue, flush: flush, pending: function () { return box().length; } };
})();

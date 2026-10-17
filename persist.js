/* Drive Logger persistence logic (pure, no DOM): note versions, two-store merge, draft recovery,
   journal, backup/restore and export tracking. Browser: window.DLPersist; Node: require('./persist'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DLPersist = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var BACKUP_APP = 'drive-logger', BACKUP_FORMAT = 1;
  var RECOVERED = '(recovered)';

  function ver(n) { return (n && (n.updatedAt || n.updated || n.created || n.ts)) || 0; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function isState(d) { return !!(d && typeof d === 'object' && Array.isArray(d.sessions) && Array.isArray(d.notes)); }

  /** Bring any saved state (v1–v5 or partial) up to the current shape. Old `trash` entries become tombstones. */
  function normalize(d) {
    if (!isState(d)) return null;
    d.notes = d.notes.filter(function (n) { return n && n.id; });
    d.notes.forEach(function (n) { if (!n.updatedAt) n.updatedAt = ver(n); });
    if (Array.isArray(d.trash)) {
      var have = {}; d.notes.forEach(function (n) { have[n.id] = 1; });
      d.trash.forEach(function (n) {
        if (!n || !n.id || have[n.id]) return;
        n.deleted = true; n.deletedAt = n.deletedAt || ver(n); n.updatedAt = Math.max(ver(n), n.deletedAt);
        d.notes.push(n); have[n.id] = 1;
      });
    }
    delete d.trash;
    d.sessions = d.sessions.filter(function (s) { return s && s.id; });
    // notes whose session record is missing (e.g. one store lost its metadata) get a placeholder session
    var sess = {}; d.sessions.forEach(function (s) { sess[s.id] = s; });
    d.notes.forEach(function (n) {
      if (!n.session) return;
      var s = sess[n.session];
      if (!s) { s = sess[n.session] = { id: n.session, name: 'Drive (recovered)', start: n.ts || 0, synthetic: true }; d.sessions.push(s); }
      else if (s.synthetic && n.ts && n.ts < s.start) s.start = n.ts;
    });
    d.settings = d.settings || {};
    d.savedAt = d.savedAt || 0;
    return d;
  }

  /** Merge two states. Notes: union by id, newest updatedAt wins (deletes are tombstones, so they win too).
      Sessions: union by id, exportedAt = max. Settings/current/view: from `prefer` ('a', 'b' or 'newest' by savedAt). */
  function merge(a, b, prefer) {
    a = normalize(clone(a)); b = normalize(clone(b));
    if (!a && !b) return { db: null, stats: { added: 0, updated: 0 } };
    if (!b) return { db: a, stats: { added: 0, updated: 0 } };
    if (!a) return { db: b, stats: { added: b.notes.length, updated: 0 } };
    var byId = {}, order = [], stats = { added: 0, updated: 0, revived: 0 };
    a.notes.forEach(function (n) { byId[n.id] = n; order.push(n.id); });
    b.notes.forEach(function (n) {
      var cur = byId[n.id];
      if (!cur) { byId[n.id] = n; order.push(n.id); stats.added++; }
      else if (ver(n) > ver(cur)) { byId[n.id] = n; stats.updated++; }
    });
    var sById = {}, sOrder = [];
    a.sessions.concat(b.sessions).forEach(function (s) {
      var cur = sById[s.id];
      if (!cur) { sById[s.id] = s; sOrder.push(s.id); return; }
      cur.exportedAt = Math.max(cur.exportedAt || 0, s.exportedAt || 0) || undefined;
      if ((!cur.name || cur.synthetic) && s.name && !s.synthetic) { cur.name = s.name; delete cur.synthetic; }
      if (!cur.start || (s.start && s.start < cur.start)) cur.start = s.start;
    });
    var meta = prefer === 'b' ? b : prefer === 'a' ? a : (b.savedAt > a.savedAt ? b : a);
    var out = {
      sessions: sOrder.map(function (id) { return sById[id]; }).sort(function (x, y) { return (x.start || 0) - (y.start || 0); }),
      notes: order.map(function (id) { return byId[id]; }),
      settings: meta.settings, current: meta.current, view: meta.view, savedAt: Math.max(a.savedAt, b.savedAt)
    };
    if (!sById[out.current]) out.current = (meta === a ? b : a).current;
    if (!sById[out.view] && out.view !== 'all') out.view = out.current;
    return { db: out, stats: stats };
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function live(db) { return db.notes.filter(function (n) { return !n.deleted; }); }

  // ---------- drafts (in-progress captures) ----------
  function draftKey(ts, type) { return 'd' + ts + (type === 'Intervention' ? 'I' : 'L'); }
  /** Turn leftover drafts into notes tagged "(recovered)". Skips drafts already saved as a note (same session, ts, type).
      Returns the new notes (already pushed into db). */
  function recoverDrafts(db, drafts, now) {
    var out = [];
    (drafts || []).forEach(function (d) {
      if (!d || !d.ts || !d.type) return;
      var dup = db.notes.some(function (n) { return n.ts === d.ts && n.type === d.type && (!d.session || n.session === d.session); })
        || db.notes.some(function (n) { return n.draftKey && n.draftKey === d.key; });
      if (dup) return;
      var text = String(d.text || '').trim();
      var n = { id: 'r' + d.ts.toString(36) + Math.random().toString(36).slice(2, 6), session: d.session || db.current, ts: d.ts,
        type: d.type, text: (text ? text + ' ' : '') + RECOVERED, source: 'recovered', recovered: true, draftKey: d.key,
        created: now, updatedAt: now, lat: d.lat == null ? null : d.lat, lon: d.lon == null ? null : d.lon, acc: d.acc == null ? null : d.acc };
      if (!db.sessions.some(function (s) { return s.id === n.session; })) n.session = db.current;
      db.notes.push(n); out.push(n);
    });
    return out;
  }
  function mergeDrafts(a, b) {
    var m = {};
    (a || []).concat(b || []).forEach(function (d) { if (d && d.key && (!m[d.key] || (d.updatedAt || 0) > (m[d.key].updatedAt || 0))) m[d.key] = d; });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  // ---------- journal ----------
  function jEntry(op, n, t) { return { t: t || Date.now(), op: op, id: n.id, session: n.session, note: clone(n) }; }
  function jKey(e) { return e.t + '|' + e.op + '|' + e.id; }
  function mergeJournal(a, b) {
    var seen = {}, out = [];
    (a || []).concat(b || []).forEach(function (e) { if (!e || !e.id) return; var k = jKey(e); if (!seen[k]) { seen[k] = 1; out.push(e); } });
    return out.sort(function (x, y) { return x.t - y.t; });
  }
  /** Deleted notes, newest deletion first: tombstones in the state, plus journal deletes for ids the state no longer has. */
  function recentlyDeleted(db, journal) {
    var have = {}, out = [];
    db.notes.forEach(function (n) { have[n.id] = n; if (n.deleted) out.push(n); });
    var lastDel = {};
    (journal || []).forEach(function (e) { if (e.op === 'delete') lastDel[e.id] = e; });
    Object.keys(lastDel).forEach(function (id) {
      if (have[id]) return;
      var n = clone(lastDel[id].note); n.deleted = true; n.deletedAt = n.deletedAt || lastDel[id].t; n.fromJournal = true; out.push(n);
    });
    return out.sort(function (x, y) { return (y.deletedAt || 0) - (x.deletedAt || 0); });
  }

  // ---------- backup ----------
  function buildBackup(db, journal, now) {
    var d = new Date(now || Date.now());
    return { app: BACKUP_APP, format: BACKUP_FORMAT, exportedAt: d.getTime(), exportedAtISO: d.toISOString(),
      state: { sessions: db.sessions, notes: db.notes, settings: db.settings, current: db.current, savedAt: db.savedAt },
      journal: journal || [] };
  }
  /** Parse a backup file. Also accepts a bare saved state ({sessions, notes}). Throws with a readable message. */
  function parseBackup(text) {
    var o; try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw new Error('Not a JSON file'); }
    if (o && o.app === BACKUP_APP && isState(o.state)) return { state: o.state, journal: Array.isArray(o.journal) ? o.journal : [] };
    if (isState(o)) return { state: o, journal: [] };
    throw new Error('Not a Drive Logger backup');
  }
  /** Restore = merge, never overwrite: newest version of each note wins; local settings and current session are kept. */
  function restore(db, backupText, journal) {
    var b = parseBackup(backupText), m = merge(db, b.state, 'a');
    return { db: m.db, stats: m.stats, journal: mergeJournal(journal, b.journal) };
  }

  // ---------- export tracking ----------
  /** Live notes in a session created or changed after its last export. */
  function unexported(db, sessionId) {
    var s = db.sessions.filter(function (x) { return x.id === sessionId; })[0], t = (s && s.exportedAt) || 0;
    return live(db).filter(function (n) { return n.session === sessionId && ver(n) > t; }).length;
  }
  function markExported(db, sessionIds, now) {
    db.sessions.forEach(function (s) { if (sessionIds.indexOf(s.id) >= 0) s.exportedAt = now || Date.now(); });
  }

  // ---------- off-phone sync outbox (not enabled yet; see README "Backing up to Google Sheets") ----------
  /** Outbox of change events waiting to be POSTed. Coalesces by note id (only the newest version is sent). */
  function outboxAdd(box, op, n) {
    box = (box || []).filter(function (e) { return e.id !== n.id; });
    box.push({ id: n.id, op: op, v: ver(n), note: clone(n), tries: 0 });
    return box;
  }
  function outboxAck(box, sent) {
    var v = {}; sent.forEach(function (e) { v[e.id] = e.v; });
    return box.filter(function (e) { return !(e.id in v) || e.v > v[e.id]; });   // keep anything changed while in flight
  }
  function backoff(tries) { return Math.min(5 * 60000, 2000 * Math.pow(2, tries || 0)); }

  return { ver: ver, normalize: normalize, merge: merge, same: same, live: live, clone: clone, isState: isState,
    draftKey: draftKey, recoverDrafts: recoverDrafts, mergeDrafts: mergeDrafts, RECOVERED: RECOVERED,
    jEntry: jEntry, mergeJournal: mergeJournal, recentlyDeleted: recentlyDeleted,
    buildBackup: buildBackup, parseBackup: parseBackup, restore: restore,
    unexported: unexported, markExported: markExported,
    outboxAdd: outboxAdd, outboxAck: outboxAck, backoff: backoff };
});

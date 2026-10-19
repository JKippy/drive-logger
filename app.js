/* Drive Logger app: speech capture, voice commands, spoken replies, UI. */
(function () {
  'use strict';
  var C = window.DLCore;
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'driveLogger.v1';
  var SILENCE_MS = 2500, FAST_SILENCE_MS = 1200, RECENT_MS = 60000;

  // ================= storage =================
  // Every change is written immediately to BOTH localStorage (sync) and IndexedDB (strict durability), see store.js.
  // On load both are read and merged by note id (newest updatedAt wins). Deletes are tombstones (deleted: true).
  var P = window.DLPersist, Store = window.DLStore;
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  var lsRead = Store.readLS();
  var db = P.normalize(lsRead.state);
  var freshStart = !db;
  function sessionName(ts) { var d = new Date(ts); return 'Drive ' + C.localDate(d) + ' ' + C.localTime(d).slice(0, 5); }
  function newSession() {
    var s = { id: uid(), name: sessionName(Date.now()), start: Date.now() };
    db.sessions.push(s); db.current = s.id; db.view = s.id; save(); return s;
  }
  if (!db) { db = { sessions: [], notes: [], settings: {}, current: null, view: null, savedAt: 0 }; newSession(); }
  function applyDefaults() {
    if (!db.view) db.view = db.current;
    db.settings = db.settings || {};
    if (!db.settings.replies) db.settings.replies = 'voice';   // 'voice' | 'chime'
    if ((db.settings.v || 0) < 3) { db.settings.gps = true; db.settings.v = 3; }   // v3: GPS on by default
    if (db.settings.night == null) db.settings.night = false;
    if (!db.settings.side) db.settings.side = 'left';
    if (!Array.isArray(db.settings.corrections)) db.settings.corrections = C.DEFAULT_CORRECTIONS.map(function (c) { return { from: c.from, to: c.to }; });
  }
  applyDefaults();
  function corrected(t) { return C.applyCorrections(t, db.settings.corrections); }
  var journal = null;   // loaded from IndexedDB when the More sheet opens
  /** Persist now. `notes` = changed note(s); `op` = journal event (create/edit/delete/priority/retype/restore/recover). */
  function save(notes, op) {
    var list = notes ? [].concat(notes) : null, entries = null;
    if (list && op) { var t = Date.now(); entries = list.map(function (n) { return P.jEntry(op, n, t); }); }
    Store.write(db, list, entries);
    if (entries && journal) journal.push.apply(journal, entries);
    if (entries && window.DLSync) list.forEach(function (n) { DLSync.enqueue(op, n); });   // Sheets backup (no-op when off)
  }
  /** Record a change to one note. */
  function change(n, op) { n.updatedAt = Date.now(); n.updated = n.updatedAt; save(n, op); }
  function byTs(a, b) { return a.ts - b.ts; }
  function viewNotes() {
    var n = db.view === 'all' ? P.live(db) : P.live(db).filter(function (x) { return x.session === db.view; });
    return n.sort(byTs);
  }
  function sessionNotes() { return db.notes.filter(function (x) { return !x.deleted && x.session === db.current; }).sort(byTs); }
  function getNote(id) { for (var i = 0; i < db.notes.length; i++) if (db.notes[i].id === id) return db.notes[i]; }
  /** target 1 = last note in the current session, 2 = the one before it */
  function lastNote(target) { var n = sessionNotes(); return n[n.length - (target || 1)] || null; }
  function lastActivity() {
    var n = sessionNotes(), t = 0;
    n.forEach(function (x) { t = Math.max(t, x.updated || x.created || x.ts); });
    return t;
  }

  // ================= rendering =================
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var PRI_LABEL = { high: 'HIGH $$$', medium: 'MED $$', low: 'LOW $' };
  function priHtml(level) { return level ? '<span class="pri pri-' + level + '">' + PRI_LABEL[level] + '</span>' : ''; }
  function renderSessions() {
    var sel = $('sessionSel'), html = '';
    db.sessions.slice().reverse().forEach(function (s) {
      var count = db.notes.filter(function (n) { return !n.deleted && n.session === s.id; }).length;
      html += '<option value="' + s.id + '">' + (s.id === db.current ? '● ' : '') + esc(s.name.replace(/^Drive /, '')) + ' · ' + count + '</option>';
    });
    html += '<option value="all">All sessions · ' + P.live(db).length + '</option>';
    sel.innerHTML = html; sel.value = db.view;
    renderExportInfo();
  }
  var freshId = null, freshT = null;
  function renderHistory() {
    var all = sessionNotes(), ul = $('history');
    $('sessCount').textContent = all.length + ' note' + (all.length === 1 ? '' : 's');
    if (!all.length) { ul.innerHTML = '<li class="hcard empty">No notes yet. Say “log …” or “intervention …”</li>'; return; }
    ul.innerHTML = all.slice().reverse().slice(0, 60).map(function (n, i) {
      var p = C.splitPriority(n.text);
      return '<li class="hcard ' + n.type + (i === 0 ? ' newest' : '') + (n.id === freshId ? ' fresh' : '') + '" data-id="' + n.id + '">' +
        '<div class="hmeta"><span class="htime">' + C.localTime(new Date(n.ts)) + '</span><span class="chip ' + n.type + '">' + n.type + '</span>' + priHtml(p.level) + '</div>' +
        '<div class="htext">' + (p.base ? esc(p.base) : '(no details)') + '</div></li>';
    }).join('');
  }
  /** Flat save confirmation: the new card is briefly tinted, then fades back to normal. */
  function highlightNote(id) {
    freshId = id; renderHistory(); $('history').scrollTop = 0;
    clearTimeout(freshT);
    freshT = setTimeout(function () {
      freshId = null; var el = $('history').querySelector('.fresh'); if (el) el.classList.remove('fresh');
    }, 700);
  }
  function renderList() {
    var notes = viewNotes(), ul = $('notes');
    $('countLbl').textContent = 'Notes · ' + notes.length;
    if (!notes.length) { ul.innerHTML = '<li class="empty-list">No notes in this session yet.</li>'; return; }
    ul.innerHTML = notes.slice().reverse().map(function (n) {
      var r = C.row(n), p = C.splitPriority(n.text);
      var loc = n.lat != null ? ' · ' + n.lat.toFixed(5) + ', ' + n.lon.toFixed(5) : ' · no GPS';
      return '<li class="note ' + n.type + '" data-id="' + n.id + '">' +
        '<div class="meta"><span class="time">' + r[1] + '</span><span class="chip ' + n.type + '">' + n.type + '</span>' + priHtml(p.level) +
        '<span class="acts"><button data-act="edit">Edit</button><button data-act="del" class="del">Delete</button></span></div>' +
        '<div class="text' + (p.base ? '' : ' empty') + '" data-act="edit">' + (p.base ? esc(p.base) : '(no details)') + '</div>' +
        '<div class="sub">' + r[0] + loc + '</div></li>';
    }).join('');
  }
  function render() { renderHistory(); if (sheetOpen) { renderSessions(); renderList(); renderCorrections(); renderDeleted(); renderStorage(); } }
  $('notes').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act'); if (!act) return;
    var li = e.target.closest('.note'), n = li && getNote(li.getAttribute('data-id')); if (!n) return;
    if (act === 'edit') {
      var t = prompt('Edit ' + n.type + ' note (' + C.row(n)[1] + ')\n$$$ = high, $$ = medium, $ = low priority', n.text);
      if (t !== null) { n.text = t.trim(); n.edited = true; change(n, 'edit'); render(); }
    } else if (act === 'del') {
      if (confirm('Delete this note?\n\n' + (n.text || '(no details)'))) deleteNote(n);
    }
  });
  $('sessionSel').addEventListener('change', function () { db.view = this.value; save(); render(); });
  function startNewSession() { var s = newSession(); render(); toast('Started ' + s.name); }
  $('newSessionBtn').addEventListener('click', function () {
    if (P.unexported(db, db.current) > 0) nudge('new'); else startNewSession();
  });

  // ---- More sheet ----
  var sheetOpen = false;
  function openSheet() {
    sheetOpen = true; render(); syncSettingsUI(); syncUI();
    Store.readJournal().then(function (j) { journal = P.mergeJournal(j, journal || []); if (sheetOpen) renderDeleted(); });
    var w = $('sheetWrap'); w.hidden = false; void w.offsetWidth; w.classList.add('open');
  }
  function closeSheet() {
    sheetOpen = false; var w = $('sheetWrap'); w.classList.remove('open');
    setTimeout(function () { if (!sheetOpen) w.hidden = true; }, 420);
  }
  $('moreBtn').addEventListener('click', openSheet);
  $('sheetWrap').addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) closeSheet(); });

  /** loc = GPS snapshot taken when the keyword was heard (or null → blank lat/lon). */
  function addNote(type, text, ts, source, loc) {
    var now = Date.now();
    var n = { id: uid(), session: db.current, ts: ts, type: type, text: text, source: source || 'voice', created: now, updatedAt: now,
      lat: null, lon: null, acc: null };
    if (loc === undefined) loc = gpsSnapshot();
    if (loc) { n.lat = loc.lat; n.lon = loc.lon; n.acc = Math.round(loc.acc); }
    db.notes.push(n);
    if (db.view !== 'all') db.view = db.current;
    save(n, 'create'); render(); highlightNote(n.id);
    return n;
  }
  function deleteNote(n) {
    n.deleted = true; n.deletedAt = Date.now(); change(n, 'delete'); render();
  }

  // ================= feedback: chime, flash, speech, assistant feed =================
  var actx = null;
  function unlockAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator(), g = actx.createGain(); g.gain.value = 0.0001;
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.02);
    } catch (e) {}
    try { // iOS needs one speak() inside a tap before later speech works
      if (window.speechSynthesis && !unlockAudio.tts) { var u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); unlockAudio.tts = true; }
    } catch (e) {}
  }
  function beep(freq, at, dur) {
    var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + at;
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  var CHIMES = {
    Log: [[880, 0, 0.15]], Intervention: [[660, 0, 0.12], [660, 0.18, 0.12]],
    ok: [[990, 0, 0.08], [1320, 0.1, 0.1]], del: [[520, 0, 0.1], [390, 0.12, 0.14]], info: [[740, 0, 0.1]]
  };
  function chime(kind) {
    try {
      if (actx) { if (actx.state === 'suspended') actx.resume(); (CHIMES[kind] || CHIMES.ok).forEach(function (b) { beep(b[0], b[1], b[2]); }); }
    } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(kind === 'Intervention' ? [80, 60, 80] : 100); } catch (e) {}
  }
  var toastT;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  var feedT;
  function feed(msg, kind) {
    var el = $('feed'); el.textContent = msg; el.className = 'feed show ' + (kind || 'ok'); el.parentNode.classList.add('has-feed');
    clearTimeout(feedT); feedT = setTimeout(function () { el.classList.remove('show'); el.parentNode.classList.remove('has-feed'); }, 6000);
  }
  /** Acknowledge like a person: speak (voice mode) or chime (chime-only mode). */
  function reply(text, chimeKind) {
    if (db.settings.replies === 'voice' && window.speechSynthesis) speak(text);
    else chime(chimeKind || 'ok');
  }
  function shortText(t, n) { t = C.splitPriority(t).base || '(no details)'; return t.length > (n || 40) ? t.slice(0, n || 40) + '…' : t; }
  function confirmNote(n, level) {
    var phrase = n.type === 'Intervention' ? 'Intervention noted.' : ['Logged.', 'Got it.', 'Noted.'][Math.floor(Math.random() * 3)];
    if (level) phrase = phrase.replace(/\.$/, ', ' + level + ' priority.');
    feed('✓ ' + n.type + (level ? ' (' + level + ')' : '') + ': ' + shortText(n.text), n.type === 'Intervention' ? 'warn' : 'ok');
    reply(phrase, n.type);
  }

  // ---- speech synthesis; recognition is paused while speaking so we never transcribe ourselves ----
  var ttsPending = 0, ttsBusy = false, ttsResumeT = null;
  function speak(text) {
    try {
      ttsBusy = true; ttsPending++; clearTimeout(ttsResumeT);
      if (listening) { setStatus('speaking', 'Replying…'); try { rec && rec.abort(); } catch (e) {} }
      var u = new SpeechSynthesisUtterance(text), done = false;
      u.lang = 'en-US'; u.rate = 1.05;
      var finish = function () { if (done) return; done = true; ttsPending = Math.max(0, ttsPending - 1); if (!ttsPending) ttsResumeT = setTimeout(afterSpeech, 400); };
      u.onend = finish; u.onerror = finish;
      setTimeout(finish, 2500 + text.length * 90);           // iOS sometimes never fires onend
      speechSynthesis.speak(u);
    } catch (e) { ttsBusy = false; chime('ok'); }
  }
  function afterSpeech() {
    ttsBusy = false;
    if (listening) { setStatus('starting', 'Resuming…'); rec = null; startRec(); }
  }

  // ================= voice commands =================
  var voicePaused = false;
  function pausedStatus() { setStatus('paused', 'Paused'); }
  function exec(c, u) {
    if (voicePaused && c.cmd !== 'resume') return;
    var n, now = Date.now();
    switch (c.cmd) {
      case 'priority':
        n = lastNote(c.target);
        if (!n) return reply('There is no note to mark yet.', 'info');
        n.text = C.setPriority(n.text, c.level); change(n, 'priority'); render();
        var which = c.target === 2 ? 'the note before last' : 'last note';
        if (c.level) { feed('✓ Marked ' + which + ' ' + c.level + ' priority'); reply('Marked ' + c.level + ' priority.'); }
        else { feed('✓ Removed priority from ' + which); reply('Priority removed.'); }
        break;
      case 'delete':
        if (c.recentOnly && now - lastActivity() > RECENT_MS) return;     // "never mind" only right after a note
        n = lastNote(c.target);
        if (!n) return reply('Nothing to delete.', 'info');
        deleteNote(n); feed('✕ Deleted: ' + shortText(n.text), 'warn'); reply('Deleted.', 'del');
        break;
      case 'undo':
        n = lastDeleted();
        if (!n) return reply('Nothing to bring back.', 'info');
        restoreNote(n);
        break;
      case 'amend':
        n = lastNote(1);
        if (!n) return;
        if (!c.explicit && now - lastActivity() > RECENT_MS) return;      // "also …" only right after a note
        n.text = C.amendText(n.text, corrected(c.text)); change(n, 'edit'); render();
        feed('✎ Added to last note: ' + shortText(c.text)); reply('Added.');
        break;
      case 'retype':
        n = lastNote(c.target);
        if (!n) return reply('There is no note to change.', 'info');
        n.type = c.type; change(n, 'retype'); render();
        feed('⇄ Changed ' + (c.target === 2 ? 'the note before last' : 'last note') + ' to ' + c.type);
        reply(c.type === 'Intervention' ? 'Changed to intervention.' : 'Changed to log.');
        break;
      case 'readback':
        n = lastNote(1);
        if (!n) return reply('No notes yet.', 'info');
        var p = C.splitPriority(n.text), d = new Date(n.ts);
        var hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        feed('“ ' + n.type + ' ' + C.localTime(d) + ': ' + shortText(n.text, 60), 'info');
        if (db.settings.replies === 'voice' && window.speechSynthesis)
          speak('Last note, ' + n.type.toLowerCase() + ' at ' + hm + ': ' + (p.base || 'no details') + (p.level ? '. ' + p.level + ' priority.' : '.'));
        else { chime('info'); toast(n.type + ': ' + (p.base || '(no details)')); }
        break;
      case 'count':
        var all = sessionNotes(), iv = all.filter(function (x) { return x.type === 'Intervention'; }).length, lg = all.length - iv;
        var pl = function (k, w) { return k + ' ' + w + (k === 1 ? '' : 's'); };
        var say = c.what === 'interventions' ? pl(iv, 'intervention') + ' so far, out of ' + pl(all.length, 'note') + '.'
          : c.what === 'logs' ? pl(lg, 'log') + ' so far, out of ' + pl(all.length, 'note') + '.'
          : pl(all.length, 'note') + ' this session: ' + pl(lg, 'log') + ' and ' + pl(iv, 'intervention') + '.';
        feed('# ' + say, 'info');
        if (db.settings.replies === 'voice' && window.speechSynthesis) speak(say); else { chime('info'); toast(say); }
        break;
      case 'pause':
        voicePaused = true; pausedStatus(); feed('‖ Notes paused. Say “resume notes”', 'info'); reply('Pausing notes.', 'info');
        break;
      case 'resume':
        if (!voicePaused) return;
        voicePaused = false; setStatus('listening', 'Listening'); feed('› Notes resumed'); reply('Resuming notes.');
        break;
      case 'mark':
        n = addNote('Log', C.PLACEHOLDER, (u && u.firstHeard) || now, 'mark', u ? u.firstLoc || null : undefined);
        feed('⚑ Marked event at ' + C.localTime(new Date(n.ts)) + '. Say “add to that …” later'); reply('Marked.');
        break;
    }
  }

  // ================= wake lock =================
  var wakeLock = null;
  function acquireWake() {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function (l) {
        wakeLock = l; $('wakeInfo').textContent = 'Screen stays on (Wake Lock)';
        l.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () { fallbackWake(); });
    } else fallbackWake();
  }
  function fallbackWake() {
    var v = $('nosleep'), p = v.play && v.play();
    $('wakeInfo').textContent = 'Wake Lock unsupported: using video fallback. Set Auto-Lock to Never if the screen still sleeps.';
    if (p && p.catch) p.catch(function () { $('wakeInfo').textContent = 'Screen may sleep. Set Settings › Display › Auto-Lock › Never.'; });
  }
  function releaseWake() {
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    try { $('nosleep').pause(); } catch (e) {}
    $('wakeInfo').textContent = '';
  }

  // ================= GPS =================
  // watchPosition keeps a fresh fix ready; each note takes the fix current at its keyword moment.
  var STALE_MS = 30000;
  var fix = null, geoWatch = null, gpsState = 'off';   // off | wait | good | weak | stale | denied | unavailable
  function gpsSnapshot() {
    if (!db.settings.gps || !fix || Date.now() - fix.t > STALE_MS) return null;
    return { lat: fix.lat, lon: fix.lon, acc: fix.acc };
  }
  function startGps() {
    if (!db.settings.gps) { gpsState = 'off'; renderGps(); return; }
    if (!navigator.geolocation) { gpsState = 'unavailable'; renderGps(); return; }
    if (geoWatch != null) return;
    if (gpsState !== 'good' && gpsState !== 'weak') gpsState = 'wait';
    renderGps();
    geoWatch = navigator.geolocation.watchPosition(function (p) {
      fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy || 0, t: Date.now() };
      gpsState = fix.acc <= 50 ? 'good' : 'weak'; renderGps();
    }, function (err) {
      if (err.code === 1) { gpsState = 'denied'; stopWatch(); fix = null; }
      else if (!fix) gpsState = 'unavailable';        // timeout / no signal: keep watching
      renderGps();
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  function stopWatch() { if (geoWatch != null && navigator.geolocation) navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  function stopGps() { stopWatch(); fix = null; gpsState = 'off'; renderGps(); }
  function renderGps() {
    var el = $('gpsStatus'), t = $('gpsText');
    if ((gpsState === 'good' || gpsState === 'weak') && fix && Date.now() - fix.t > STALE_MS) gpsState = 'stale';
    var map = {
      off: ['gps-off', 'GPS off'], wait: ['gps-wait', 'GPS…'], denied: ['gps-denied', 'GPS denied'],
      unavailable: ['gps-wait', 'No GPS'], stale: ['gps-wait', 'GPS stale'],
      good: ['gps-good', fix ? 'GPS ±' + Math.round(fix.acc) + ' m' : 'GPS'], weak: ['gps-weak', fix ? 'GPS ±' + Math.round(fix.acc) + ' m' : 'GPS']
    };
    var m = map[gpsState] || map.off;
    el.className = 'st ' + m[0]; t.textContent = m[1];
  }

  // ================= speech recognition =================
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false, gen = 0, utt = {}, silenceT = null, restartT = null, fails = 0, lastStart = 0;

  var ORB_LABEL = { listening: 'Listening', speaking: 'Replying…', starting: 'Starting…', paused: 'Paused', error: 'Tap to retry', idle: 'Tap to start' };
  function setStatus(kind, text) {
    var k = kind === 'paused' && !listening ? 'idle' : kind;
    $('status').className = 'st st-' + k; $('statusText').textContent = k === 'idle' ? 'Ready' : text;
    $('orb').className = 'orb ' + k;
    $('orbLabel').textContent = k === 'paused' ? 'Paused · say “resume notes”' : ORB_LABEL[k] || '';
  }
  function setMicBtn() { var b = $('micBtn'); $('micLabel').textContent = listening ? 'Stop' : 'Start'; b.classList.toggle('on', listening); }

  /** Commit one utterance segment (u.text from u.base). Called on a final result, after silence, or when recognition ends.
      After a silence commit the segment is closed; anything iOS appends later becomes a fresh segment. */
  function commit(u, endSegment, force) {
    var seg = u.text.slice(u.base), plan = C.planSegment(seg);
    if (!u.cmdDone) { u.cmdDone = true; plan.commands.forEach(function (c) { exec(c, u); }); }
    var notes = plan.notes, last = notes[notes.length - 1], hold = null;
    // a bare keyword followed by silence ("log …") stays pending so the next words become its text
    if (endSegment && !force && last && !last.text && !last.level && !u.ids[notes.length - 1]) hold = notes.pop();
    notes.forEach(function (o, k) {
      var body = corrected(o.text), text = o.level ? C.setPriority(body, o.level) : body;
      var existing = u.ids[k] && getNote(u.ids[k]);
      if (existing) {
        if (!existing.deleted && !existing.edited && (existing.text !== text || existing.type !== o.type)) { existing.text = text; existing.type = o.type; change(existing, 'edit'); render(); }
      } else if (!voicePaused) {
        var n = addNote(o.type, text, u.stamps[k] || Date.now(), 'voice', u.stamps[k] ? u.locs[k] || null : undefined);
        u.ids[k] = n.id; confirmNote(n, o.level);
      } else u.ids[k] = 'ignored';
    });
    if (hold) { var st = u.stamps[notes.length], lc = u.locs[notes.length]; u.base += hold.offset; u.stamps = [st]; u.locs = [lc]; u.ids = []; u.cmdDone = false; }
    else if (endSegment) { u.base = u.text.length; u.stamps = []; u.locs = []; u.ids = []; u.cmdDone = false; u.firstHeard = 0; u.firstLoc = null; }
  }
  function flushAll(force) {
    clearTimeout(silenceT);
    Object.keys(utt).forEach(function (k) { if (!utt[k].final) commit(utt[k], true, force === true); });
    syncDrafts();
  }
  /** In-progress captures are saved as drafts the moment a keyword is heard (timestamp + GPS of that moment),
      and removed once they become notes. Drafts left over after a crash are restored as "(recovered)" notes on the next load. */
  function currentDrafts() {
    var list = [];
    if (voicePaused) return list;
    Object.keys(utt).forEach(function (key) {
      var u = utt[key], seg = u.text.slice(u.base);
      if (!seg.trim() || !u.stamps.length) return;
      C.planSegment(seg).notes.forEach(function (o, k) {
        if (u.ids[k] || !u.stamps[k]) return;
        var loc = u.locs[k], body = corrected(o.text);
        list.push({ key: P.draftKey(u.stamps[k], o.type), session: db.current, ts: u.stamps[k], type: o.type,
          text: o.level ? C.setPriority(body, o.level) : body, lat: loc ? loc.lat : null, lon: loc ? loc.lon : null,
          acc: loc ? Math.round(loc.acc) : null, updatedAt: u.lastAt || u.stamps[k] });
      });
    });
    return list;
  }
  function syncDrafts() { Store.writeDrafts(currentDrafts()); }
  var FAST = { priority: 1, delete: 1, undo: 1, retype: 1, readback: 1, count: 1, pause: 1, resume: 1 };
  function pendingIsClosedCommand() {
    var keys = Object.keys(utt).filter(function (k) { return !utt[k].final && utt[k].text.length > utt[k].base; });
    if (!keys.length) return false;
    return keys.every(function (k) {
      var p = C.planSegment(utt[k].text.slice(utt[k].base));
      return !p.notes.length && p.commands.length && p.commands.every(function (c) { return FAST[c.cmd]; });
    });
  }
  function highlight(t) { return esc(t).replace(/\b(log|intervention)\b/gi, '<span class="kw">$1</span>'); }

  function buildRec() {
    var r = new SR();
    r.lang = 'en-US'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 5;
    r.onstart = function () {
      gen++; utt = {}; lastStart = Date.now();
      if (ttsBusy) return;
      voicePaused ? pausedStatus() : setStatus('listening', 'Listening');
    };
    r.onresult = function (e) {
      if (ttsBusy) return;                                  // never transcribe our own voice
      var now = Date.now(), finalTxt = '', interimTxt = '';
      for (var i = 0; i < e.results.length; i++) {
        var res = e.results[i], alts = [];
        for (var j = 0; j < res.length; j++) if (res[j] && res[j].transcript != null) alts.push(res[j].transcript);
        var text = C.chooseAlternative(alts), key = gen + ':' + i;   // prefer the alternative with a keyword/command
        if (res.isFinal) finalTxt += text + ' '; else interimTxt += text + ' ';
        if (i < e.resultIndex) continue;
        var u = utt[key] || (utt[key] = { text: '', base: 0, stamps: [], locs: [], ids: [], final: false, cmdDone: false, firstHeard: 0, firstLoc: null });
        if (u.final) continue;
        if (u.text !== text) u.lastAt = now;
        u.text = text;
        if (u.base > text.length) u.base = text.length;
        if (!u.firstHeard && text.slice(u.base).trim()) { u.firstHeard = now; u.firstLoc = gpsSnapshot(); }
        // Timestamp = device clock when the keyword first shows up in a (usually interim) result. If the keyword
        // opens the utterance ("log …", "okay log …") use the moment this utterance produced its first words,
        // which is the closest observable point to when the speaking started.
        var seg = text.slice(u.base), lead = C.startsWithKeyword(seg);
        C.keywordsIn(seg).forEach(function (o, k) {
          if (u.stamps[k]) return;
          var early = k === 0 && lead && u.firstHeard;
          u.stamps[k] = early ? u.firstHeard : now; u.locs[k] = early ? u.firstLoc : gpsSnapshot();
        });
        if (res.isFinal) { u.final = true; commit(u, false); }
      }
      fails = 0;
      syncDrafts();
      var tail = (finalTxt + interimTxt).trim();
      $('live').innerHTML = tail ? highlight(finalTxt) + '<span class="interim">' + highlight(interimTxt) + '</span>' : '…';
      var lv = $('live'); lv.classList.toggle('dim', voicePaused);
      lv.classList.remove('overflow');
      if (lv.scrollWidth > lv.clientWidth + 1) { lv.classList.add('overflow'); lv.scrollLeft = lv.scrollWidth; }   // show the newest words
      clearTimeout(silenceT);
      silenceT = setTimeout(function () { flushAll(false); }, pendingIsClosedCommand() ? FAST_SILENCE_MS : SILENCE_MS);
    };
    r.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false; setMicBtn(); releaseWake();
        setStatus('error', 'Error: mic / speech not allowed');
        toast('Allow the microphone, and make sure Siri & Dictation is on.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted' && !ttsBusy) {
        setStatus('error', 'Error: ' + e.error + ' (retrying)');
      }
    };
    r.onend = function () {
      flushAll(true);
      if (!listening) { setStatus('idle', 'Ready'); return; }
      if (ttsBusy) return;                                  // afterSpeech() restarts us
      if (Date.now() - lastStart < 1000) fails++; else fails = 0;
      var delay = Math.min(250 * Math.pow(2, fails), 5000);
      if (fails > 0) setStatus('starting', 'Restarting…');
      clearTimeout(restartT); restartT = setTimeout(startRec, delay);
    };
    return r;
  }
  function startRec() {
    if (!listening || ttsBusy) return;
    if (document.visibilityState === 'hidden') return;
    try { if (!rec) rec = buildRec(); lastStart = Date.now(); rec.start(); }
    catch (e) {
      if (!/already|InvalidState/i.test(String(e && (e.name + e.message)))) { rec = null; clearTimeout(restartT); restartT = setTimeout(startRec, 1000); }
    }
  }
  function startListening() {
    if (!SR) { setStatus('error', 'Speech recognition unsupported'); toast('This browser has no speech recognition. Use Safari on iPhone or Chrome.'); return; }
    unlockAudio(); acquireWake(); startGps(); checkPersistence(true);
    listening = true; voicePaused = false; fails = 0; setMicBtn(); setStatus('starting', 'Starting…');
    startRec();
  }
  function stopListening() {
    listening = false; setMicBtn(); clearTimeout(restartT);
    try { rec && rec.stop(); } catch (e) {}
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
    ttsBusy = false; ttsPending = 0;
    flushAll(true); releaseWake(); setStatus('idle', 'Ready');
  }
  function toggleListening() {
    if (!listening) return startListening();
    stopListening();
    if (P.unexported(db, db.current) > 0) nudge('stop');      // end-of-drive safety nudge
  }
  $('micBtn').addEventListener('click', toggleListening);
  $('orb').addEventListener('click', toggleListening);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && listening) {
      acquireWake(); setStatus('starting', 'Resuming…');
      try { rec && rec.abort(); } catch (e) {}
      rec = null; clearTimeout(restartT); restartT = setTimeout(startRec, 300);
    } else if (document.visibilityState === 'hidden') flushAll(true);
  });
  window.addEventListener('pagehide', function () { flushAll(true); });

  // ================= settings =================
  function syncSettingsUI() {
    [].forEach.call($('repliesSeg').children, function (b) { b.classList.toggle('on', b.getAttribute('data-v') === db.settings.replies); });
    [].forEach.call($('sideSeg').children, function (b) { b.classList.toggle('on', b.getAttribute('data-v') === db.settings.side); });
    $('gpsChk').checked = db.settings.gps; $('nightChk').checked = db.settings.night;
    document.body.classList.toggle('night', db.settings.night);
    $('app').classList.toggle('side-right', db.settings.side === 'right');
  }
  $('repliesSeg').addEventListener('click', function (e) {
    var v = e.target.getAttribute('data-v'); if (!v) return;
    db.settings.replies = v; save(); syncSettingsUI(); unlockAudio();
    reply(v === 'voice' ? 'Spoken replies on.' : '', 'ok');
  });
  $('sideSeg').addEventListener('click', function (e) {
    var v = e.target.getAttribute('data-v'); if (!v) return; db.settings.side = v; save(); syncSettingsUI();
  });
  $('gpsChk').addEventListener('change', function () {
    db.settings.gps = this.checked; save();
    if (this.checked) startGps(); else stopGps();
  });
  $('nightChk').addEventListener('change', function () { db.settings.night = this.checked; save(); syncSettingsUI(); });

  // ---- corrections list ----
  function renderCorrections() {
    var list = db.settings.corrections, box = $('corrList');
    box.innerHTML = list.length ? list.map(function (c, i) {
      return '<div class="setting corr"><span class="from">' + esc(c.from) + '</span><span class="arrow">→</span><span class="to">' + esc(c.to) +
        '</span><button class="x" data-i="' + i + '" aria-label="Remove">✕</button></div>';
    }).join('') : '<div class="setting corr"><span class="from">No corrections</span></div>';
    box.hidden = false;
  }
  $('corrList').addEventListener('click', function (e) {
    var i = e.target.getAttribute('data-i'); if (i == null) return;
    db.settings.corrections.splice(+i, 1); save(); renderCorrections();
  });
  $('corrForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = $('corrFrom').value.trim(), t = $('corrTo').value.trim(); if (!f) return;
    db.settings.corrections = db.settings.corrections.filter(function (c) { return c.from.toLowerCase() !== f.toLowerCase(); });
    db.settings.corrections.unshift({ from: f, to: t }); save();
    $('corrFrom').value = ''; $('corrTo').value = ''; renderCorrections(); toast('Correction added');
  });
  $('corrReset').addEventListener('click', function () {
    var have = {}; db.settings.corrections.forEach(function (c) { have[c.from.toLowerCase()] = 1; });
    C.DEFAULT_CORRECTIONS.forEach(function (c) { if (!have[c.from.toLowerCase()]) db.settings.corrections.push({ from: c.from, to: c.to }); });
    save(); renderCorrections(); toast('Default AV terms restored');
  });

  // session elapsed + GPS staleness, once a second (text only, no motion)
  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    s = s % 60; return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function tick() {
    var sess = db.sessions.filter(function (x) { return x.id === db.current; })[0];
    $('elapsed').textContent = fmtElapsed(Date.now() - (sess ? sess.start : Date.now()));
    $('clock').textContent = C.localTime(new Date());      // same clock + format as note timestamps
    renderGps();
  }
  setInterval(tick, 1000);

  // ================= export =================
  function exportOpts() { return {}; }   // Copy/CSV/Share use Jason's fixed 5 columns (no Lat/Lon)
  function exportNotes() { var n = viewNotes(); if (!n.length) { toast('No notes to export'); return null; } return n; }
  function sessionsOf(notes) { var o = {}; notes.forEach(function (n) { o[n.session] = 1; }); return Object.keys(o); }
  function exported(notes) { P.markExported(db, sessionsOf(notes), Date.now()); save(); if (sheetOpen) renderExportInfo(); }
  function fileName(sessId) {
    var s = db.sessions.filter(function (x) { return x.id === (sessId || db.view); })[0];
    return (s ? s.name : 'Drive all sessions').replace(/[^\w\-]+/g, '_') + '.csv';
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta); return ok;
  }
  function downloadBlob(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  // Each export runs synchronously inside the tap handler (iOS requires that for clipboard and share). done(ok) after.
  function doCopy(n, done) {
    var text = C.toTSV(n, $('hdrChk').checked, exportOpts());
    var msg = 'Copied ' + n.length + ' row' + (n.length === 1 ? '' : 's') + '. Paste into your sheet.';
    var fin = function (ok) { toast(ok ? msg : 'Copy failed. Try Download CSV.'); if (ok) exported(n); if (done) done(ok, 'Copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { fin(true); }, function () { fin(legacyCopy(text)); });
    else fin(legacyCopy(text));
  }
  function doCsv(n, name, done) {
    downloadBlob(new Blob(['\ufeff' + C.toCSV(n, exportOpts())], { type: 'text/csv;charset=utf-8' }), name);
    exported(n); if (done) done(true, 'Downloaded');
  }
  function doShare(n, name, done) {
    var csv = C.toCSV(n, exportOpts()), file = null, p = null;
    try { file = new File([csv], name, { type: 'text/csv' }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) p = navigator.share({ files: [file], title: 'Drive Logger notes' });
    else if (navigator.share) p = navigator.share({ title: 'Drive Logger notes', text: C.toTSV(n, true, exportOpts()) });
    else { toast('Sharing not supported here. Use Download CSV.'); return; }
    p.then(function () { exported(n); if (done) done(true, 'Shared'); }, function () {});
  }
  $('copyBtn').addEventListener('click', function () { var n = exportNotes(); if (n) doCopy(n); });
  $('csvBtn').addEventListener('click', function () { var n = exportNotes(); if (n) doCsv(n, fileName()); });
  $('shareBtn').addEventListener('click', function () { var n = exportNotes(); if (n) doShare(n, fileName()); });
  if (!navigator.share) { $('shareBtn').hidden = true; $('nudgeShare').hidden = true; }

  function fmtAgo(t) {
    var d = new Date(t), today = C.localDate(new Date()) === C.localDate(d);
    return (today ? '' : C.localDate(d) + ' ') + C.localTime(d).slice(0, 5);
  }
  function renderExportInfo() {
    var el = $('exportInfo'), id = db.view === 'all' ? db.current : db.view;
    var s = db.sessions.filter(function (x) { return x.id === id; })[0], k = P.unexported(db, id);
    if (!s) { el.textContent = ''; return; }
    el.className = 'fine export-info' + (k ? ' pending' : '');
    el.textContent = (k ? k + ' note' + (k === 1 ? '' : 's') + ' not exported' : (s.exportedAt ? 'All exported' : 'Nothing to export yet')) +
      (s.exportedAt ? ' · last export ' + fmtAgo(s.exportedAt) : '');
  }

  // ---- end-of-drive nudge (Stop, or New session with unexported notes) ----
  var nudgeMode = null;
  function nudge(mode) {
    nudgeMode = mode;
    var k = P.unexported(db, db.current);
    $('nudgeTitle').textContent = k + ' note' + (k === 1 ? '' : 's') + ' not exported yet';
    $('nudgeSub').textContent = 'Save a copy off the phone before you go.';
    $('nudgeLater').textContent = mode === 'new' ? 'Skip, start new drive' : 'Not now';
    $('nudge').hidden = false;
  }
  function nudgeDone(ok, what) {
    if (!ok) return;
    $('nudgeTitle').textContent = '✓ ' + what;
    $('nudgeSub').textContent = 'Notes from this drive are saved off the phone.';
    $('nudgeLater').textContent = nudgeMode === 'new' ? 'Start new drive' : 'Done';
  }
  function closeNudge(go) { $('nudge').hidden = true; if (go && nudgeMode === 'new') startNewSession(); nudgeMode = null; }
  function curNotes() { return sessionNotes(); }
  $('nudgeCopy').addEventListener('click', function () { doCopy(curNotes(), nudgeDone); });
  $('nudgeCsv').addEventListener('click', function () { doCsv(curNotes(), fileName(db.current), nudgeDone); });
  $('nudgeShare').addEventListener('click', function () { doShare(curNotes(), fileName(db.current), nudgeDone); });
  $('nudgeLater').addEventListener('click', function () { closeNudge(true); });
  $('nudgeScrim').addEventListener('click', function () { closeNudge(false); });

  // ================= durability: warnings, persistence, recently deleted, backup =================
  var isPrivate = null, persisted = null, standalone = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  function renderWarn() {
    var h = Store.health(), el = $('warnBar'), msg = '', level = '';
    if (isPrivate) { msg = 'Private Browsing: notes are erased when this tab closes. Open Drive Logger in a normal Safari tab or from the Home Screen, and export now.'; level = 'bad'; }
    else if (h.ls === 'fail' && h.idb !== 'ok' && h.idb !== 'pending') { msg = 'Notes are NOT being saved (storage full or blocked: ' + (h.lsErr || h.idbErr) + '). Copy or export now.'; level = 'bad'; }
    else if (h.ls === 'fail') { msg = 'localStorage failed (' + h.lsErr + '). Notes are saved in IndexedDB only. Export soon.'; level = 'warn'; }
    else if (h.idb === 'fail') { msg = 'Backup store (IndexedDB) failed' + (h.idbErr ? ' (' + h.idbErr + ')' : '') + '. Notes are saved in localStorage only.'; level = 'warn'; }
    el.textContent = msg; el.className = 'warnbar ' + level; el.hidden = !msg;
    if (sheetOpen) renderStorage();
  }
  Store.onHealth(renderWarn);
  function checkPersistence(ask) {
    var p = ask ? Store.persist() : (navigator.storage && navigator.storage.persisted ? navigator.storage.persisted().catch(function () { return null; }) : Promise.resolve(null));
    return p.then(function (v) { persisted = v; if (sheetOpen) renderStorage(); });
  }
  function renderStorage() {
    var h = Store.health(), mark = function (v) { return v === 'ok' ? '✓' : v === 'pending' ? '…' : v === 'unavailable' ? 'n/a' : '✕ failing'; };
    $('stStores').textContent = 'Local ' + mark(h.ls) + ' · IndexedDB ' + mark(h.idb);
    $('stStores').className = 'st-val' + (h.ls !== 'ok' || (h.idb !== 'ok' && h.idb !== 'pending') ? ' bad' : '');
    $('stPersist').textContent = persisted === true ? 'Persistent ✓' : persisted === false ? 'Best effort' : 'Unknown';
    $('stPersist').className = 'st-val' + (persisted === true ? '' : ' warn');
    $('stMode').textContent = isPrivate ? 'Private Browsing ✕' : standalone ? 'Home Screen app' : 'Browser tab';
    $('stMode').className = 'st-val' + (isPrivate ? ' bad' : '');
    var tips = [];
    if (isPrivate) tips.push('Private Browsing erases everything when the tab closes.');
    if (persisted !== true && !standalone) tips.push('Safari can clear site data after 7 days without visiting. Add to Home Screen to keep notes safe.');
    if (persisted !== true && standalone) tips.push('Home Screen apps are exempt from Safari’s 7-day cleanup; iOS can still evict data if the phone runs out of space.');
    tips.push('Every change is saved instantly to two stores on this phone. Export or back up after each drive.');
    $('stTip').textContent = tips.join(' ');
  }

  function lastDeleted() {
    var best = null;
    db.notes.forEach(function (n) { if (n.deleted && (!best || (n.deletedAt || 0) > (best.deletedAt || 0))) best = n; });
    return best;
  }
  function restoreNote(n) {
    var cur = getNote(n.id);
    if (!cur) { cur = P.clone(n); delete cur.fromJournal; db.notes.push(cur); }
    cur.deleted = false; delete cur.deletedAt; change(cur, 'restore'); render();
    feed('↩ Restored: ' + shortText(cur.text)); reply('Restored.');
    return cur;
  }
  var deletedCache = [];
  function renderDeleted() {
    deletedCache = P.recentlyDeleted(db, journal).slice(0, 50);
    $('delCount').textContent = deletedCache.length ? '· ' + deletedCache.length : '';
    $('deleted').innerHTML = deletedCache.length ? deletedCache.map(function (n, i) {
      return '<li class="note ' + n.type + '"><div class="meta"><span class="time">' + C.localTime(new Date(n.ts)) + '</span><span class="chip ' + n.type + '">' + n.type +
        '</span><span class="acts"><button data-i="' + i + '">Restore</button></span></div><div class="text">' + esc(C.splitPriority(n.text).base || '(no details)') +
        '</div><div class="sub">' + C.localDate(new Date(n.ts)) + ' · deleted ' + (n.deletedAt ? fmtAgo(n.deletedAt) : '') + '</div></li>';
    }).join('') : '<li class="empty-list">Nothing deleted.</li>';
  }
  $('deleted').addEventListener('click', function (e) {
    var i = e.target.getAttribute('data-i'); if (i == null) return;
    var n = deletedCache[+i]; if (n) restoreNote(n);
  });

  // ---- full backup (JSON) and merge-restore ----
  $('backupBtn').addEventListener('click', function () {
    Store.readJournal().then(function (j) {
      journal = P.mergeJournal(j, journal || []);
      var b = P.buildBackup(db, journal, Date.now()), d = new Date();
      var name = 'drive-logger-backup-' + C.localDate(d) + '-' + C.localTime(d).replace(/:/g, '').slice(0, 4) + '.json';
      downloadBlob(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }), name);
      toast('Backup saved: ' + P.live(db).length + ' notes, ' + journal.length + ' journal entries');
    });
  });
  $('restoreBtn').addEventListener('click', function () { $('restoreFile').value = ''; $('restoreFile').click(); });
  $('restoreFile').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      Store.readJournal().then(function (j) {
        var r;
        try { r = P.restore(db, String(rd.result), P.mergeJournal(j, journal || [])); }
        catch (e) { toast('Restore failed: ' + e.message); return; }
        db = r.db; applyDefaults(); journal = r.journal;
        Store.write(db, 'all', null); Store.replaceJournal(journal);
        if (Sync.status().enabled) Sync.backfill(P.live(db));
        render(); syncSettingsUI();
        toast('Restored: ' + r.stats.added + ' new, ' + r.stats.updated + ' updated. Nothing was overwritten.');
      });
    };
    rd.readAsText(f);
  });

  // ================= Sheets backup (Apps Script web app) =================
  var Sync = window.DLSync;
  function syncCfg() { return db.settings.sheetSync || (db.settings.sheetSync = { url: '', token: '', enabled: false }); }
  Sync.setDescribe(function (n) { var s = db.sessions.filter(function (x) { return x.id === n.session; })[0]; return { session: s ? s.name : '' }; });
  function applySync(backfillAll) {
    Sync.configure(syncCfg());
    if (backfillAll && Sync.status().enabled) return Sync.backfill(P.live(db));
    return 0;
  }
  function shortUrl(u) {
    var m = /^https?:\/\/([^\/]+)\/.*\/s\/([\w-]+)\/exec/.exec(u || '');
    return m ? m[1] + '/…/' + m[2].slice(0, 6) + '…' + m[2].slice(-4) + '/exec' : u;
  }
  /** Status-row glyph: grey cloud = all synced, amber cloud + count = waiting, red cloud + "!" = failing. */
  function renderSyncInd(x) {
    var el = $('syncInd'), t = $('syncText');
    if (!x.enabled) { el.hidden = true; return; }
    el.hidden = false;
    if (x.lastError && x.pending && !/^Offline/.test(x.lastError)) { el.className = 'st sync-err'; t.textContent = '!'; el.title = 'Sheets backup error: ' + x.lastError; }
    else if (x.pending) { el.className = 'st sync-pending'; t.textContent = String(x.pending); el.title = x.pending + ' pending for Google Sheets'; }
    else { el.className = 'st sync-ok'; t.textContent = ''; el.title = 'Synced to Google Sheets'; }
    el.setAttribute('data-state', el.className.replace('st sync-', ''));
  }
  function renderSyncStatus(x) {
    x = x || Sync.status();
    var c = syncCfg(), parts = [];
    if (!x.enabled) parts.push(c.url && c.token ? 'Off' : 'Off: add the /exec URL and token, or open a pairing link');
    else {
      parts.push(x.lastSync ? 'Last synced ' + C.localTime(new Date(x.lastSync)) : 'Not synced yet');
      parts.push(x.pending + ' pending');
    }
    $('syncStatus').textContent = parts.join(' · ');
    $('syncErr').textContent = x.lastError ? 'Last error' + (x.lastErrorAt ? ' ' + C.localTime(new Date(x.lastErrorAt)) : '') + ': ' + x.lastError : '';
  }
  Sync.onStatus(function (x) { renderSyncInd(x); if (sheetOpen) renderSyncStatus(x); });
  function syncUI() {
    var c = syncCfg();
    $('syncChk').checked = !!c.enabled; $('syncUrl').value = c.url || ''; $('syncToken').value = c.token || '';
    renderSyncStatus();
  }
  function fieldsCfg() { return { url: $('syncUrl').value.trim(), token: $('syncToken').value.trim() }; }
  function saveSyncFields() {
    var c = syncCfg(), f = fieldsCfg(), pair = Sync.parsePairing(f.url);
    if (pair) { f = pair; $('syncUrl').value = f.url; $('syncToken').value = f.token; }
    var changed = f.url !== c.url || f.token !== c.token;
    c.url = f.url; c.token = f.token;
    if (c.enabled && !(Sync.validUrl(c.url) && c.token)) { c.enabled = false; $('syncChk').checked = false; toast('Sheets backup off: URL or token missing'); }
    save(); if (changed) applySync(c.enabled); renderSyncStatus();
  }
  $('syncUrl').addEventListener('change', saveSyncFields);
  $('syncToken').addEventListener('change', saveSyncFields);
  $('syncChk').addEventListener('change', function () {
    var c = syncCfg(), f = fieldsCfg();
    if (this.checked) {
      var pair = Sync.parsePairing(f.url); if (pair) f = pair;
      if (!Sync.validUrl(f.url)) { this.checked = false; toast('Enter the Apps Script web app URL ending in /exec'); return; }
      if (!f.token) { this.checked = false; toast('Enter the token from the script'); return; }
      c.url = f.url; c.token = f.token; c.enabled = true; save();
      var k = applySync(true); toast(k ? 'Sheets backup on: sending ' + k + ' note' + (k === 1 ? '' : 's') : 'Sheets backup on');
    } else { c.enabled = false; save(); applySync(false); toast('Sheets backup off'); }
    syncUI();
  });
  $('syncTest').addEventListener('click', function () {
    var f = fieldsCfg(), pair = Sync.parsePairing(f.url); if (pair) f = pair;
    $('syncStatus').textContent = 'Testing…';
    Sync.test(f).then(function (j) { renderSyncStatus(); $('syncStatus').textContent = 'Test OK: sheet tab “' + j.tab + '” has ' + j.rows + ' row' + (j.rows === 1 ? '' : 's') + ' · ' + $('syncStatus').textContent; toast('Google Sheet reached ✓'); },
      function (e) { renderSyncStatus(); toast('Test failed: ' + e.message); });
  });
  $('syncNow').addEventListener('click', function () { if (!Sync.status().enabled) return toast('Turn Sheets backup on first'); Sync.flush(); });

  // ---- pairing link: …/drive-logger/#sync=<url-encoded /exec URL>&token=<token> ----
  var pendingPair = null;
  function takePairingHash() {
    if (!/[#&]sync=/.test(location.hash)) return;
    var pair = Sync.parsePairing(location.hash);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}   // never leave the token in the URL
    if (!pair) return toast('Pairing link incomplete');
    if (!Sync.validUrl(pair.url)) return toast('Pairing link ignored: not an Apps Script /exec URL');
    pendingPair = pair;
    if (bootDone) showPair();
  }
  function showPair() {
    if (!pendingPair) return;
    $('pairUrl').textContent = shortUrl(pendingPair.url);
    $('pairCount').textContent = P.live(db).length + ' note' + (P.live(db).length === 1 ? '' : 's') + ' on this device will be sent, then every new note and edit.';
    $('pair').hidden = false;
  }
  $('pairOk').addEventListener('click', function () {
    var c = syncCfg(); c.url = pendingPair.url; c.token = pendingPair.token; c.enabled = true; pendingPair = null;
    $('pair').hidden = true; save();
    var k = applySync(true);
    toast(k ? 'Sheets backup paired ✓ Sending ' + k + ' note' + (k === 1 ? '' : 's') : 'Sheets backup paired ✓');
    feed('☁ Sheets backup on', 'info');
    if (sheetOpen) syncUI();
  });
  $('pairCancel').addEventListener('click', function () { pendingPair = null; $('pair').hidden = true; toast('Pairing cancelled'); });
  window.addEventListener('hashchange', takePairingHash);
  takePairingHash();

  // ---- boot: merge IndexedDB with localStorage, recover crashed drafts, resync both stores ----
  var bootDone = false;
  function boot() {
    return Store.readIDB().then(function (r) {
      var idbState = P.normalize(r.state), msgs = [];
      if (idbState && P.isState(idbState)) {
        if (freshStart) {    // localStorage was empty/corrupt: drop the placeholder session if unused, trust IndexedDB's settings
          var fid = db.current;
          if (!db.notes.some(function (n) { return n.session === fid; }) && idbState.sessions.length) db.sessions = db.sessions.filter(function (s) { return s.id !== fid; });
        }
        var m = P.merge(db, idbState, freshStart ? 'b' : 'newest');
        db = m.db; applyDefaults();
        var k = m.stats.added + m.stats.updated;
        if (k && (freshStart || lsRead.corrupt)) msgs.push('Restored ' + P.live(db).length + ' notes from IndexedDB');
        else if (k) msgs.push('Merged ' + k + ' newer note' + (k === 1 ? '' : 's') + ' from IndexedDB');
      }
      var rec = P.recoverDrafts(db, P.mergeDrafts(Store.readLSDrafts(), r.drafts), Date.now());
      if (rec.length) msgs.push('Recovered ' + rec.length + ' unfinished note' + (rec.length === 1 ? '' : 's'));
      Store.release();
      Store.write(db, 'all', rec.map(function (n) { return P.jEntry('recover', n); }));   // resync both stores
      Store.writeDrafts(currentDrafts(), true);
      bootDone = true;
      applySync(false);
      rec.forEach(function (n) { Sync.enqueue('recover', n); });
      showPair();
      Store.readJournal().then(function (j) { journal = P.mergeJournal(j, journal || []); });   // heals the IndexedDB journal from the mirror
      render(); syncSettingsUI();
      if (rec.length) { highlightNote(rec[rec.length - 1].id); feed('↺ ' + msgs[msgs.length - 1], 'warn'); }
      if (msgs.length) toast(msgs.join(' · '));
    });
  }

  if (!SR) setStatus('error', 'No speech recognition');
  else setStatus('idle', 'Ready');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {});
  syncSettingsUI(); renderGps(); tick();
  // Ask for location up front only if it's already granted (no surprise prompt); otherwise on Start.
  try { if (db.settings.gps && navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then(function (r) { if (r.state === 'granted') startGps(); else if (r.state === 'denied') { gpsState = 'denied'; renderGps(); } }).catch(function () {}); } catch (e) {}
  render();
  boot();
  checkPersistence(true);
  Store.detectPrivate().then(function (v) { isPrivate = v; renderWarn(); });
  applySync(false);
  window.__dl = { exec: exec, db: function () { return db; }, ready: function () { return bootDone; }, store: Store };   // debugging/test hook
})();

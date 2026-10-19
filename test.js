const assert = require('assert');
const C = require('./core.js');
let passed = 0;
const ok = (label) => { passed++; console.log('ok  ', label); };

// ---------- keyword capture (v1 behaviour) ----------
const eqNotes = (input, expected) => {
  const got = C.parseUtterance(input).map(n => ({ type: n.type, text: n.text }));
  assert.deepStrictEqual(got, expected, `\n  input: ${input}\n  got:   ${JSON.stringify(got)}`);
  ok(`${JSON.stringify(input)} → ${JSON.stringify(got)}`);
};
eqNotes('okay log left lane drift near exit 12', [{ type: 'Log', text: 'left lane drift near exit 12' }]);
eqNotes('intervention took over at the light', [{ type: 'Intervention', text: 'took over at the light' }]);
eqNotes('Log. Hard braking for a cyclist.', [{ type: 'Log', text: 'Hard braking for a cyclist.' }]);
eqNotes('log phantom brake intervention took over merging', [
  { type: 'Log', text: 'phantom brake' }, { type: 'Intervention', text: 'took over merging' }]);
eqNotes('the car is logging data and blogging logs', []);
eqNotes('just chatting with the passenger', []);

// ---------- commands ----------
const cmd = (input, expected) => {
  const got = C.parseCommand(input);
  if (expected === null) assert.strictEqual(got, null, `${input} should NOT be a command, got ${JSON.stringify(got)}`);
  else for (const k of Object.keys(expected))
    assert.deepStrictEqual(got && got[k], expected[k], `${input}: ${k} expected ${JSON.stringify(expected[k])}, got ${JSON.stringify(got)}`);
  ok(`cmd ${JSON.stringify(input)} → ${JSON.stringify(got)}`);
};
// 1. priority, many phrasings
[['give that last one a high priority', 'high'], ['mark that high priority', 'high'], ['make it medium', 'medium'],
 ["that's low priority", 'low'], ['Set priority high.', 'high'], ['bump that to high', 'high'], ['set the priority to medium', 'medium'],
 ['make that one urgent', 'high'], ['mark it critical', 'high'], ["that's urgent", 'high'], ['high priority', 'high'],
 ['the last one is low priority', 'low'], ['move it to low', 'low'], ['give it medium priority', 'medium'],
 ['Okay, make that high priority please', 'high'], ['that is a high priority one', 'high'], ['flag that as high priority', 'high'],
 ['give that a priority of low', 'low']]
  .forEach(([t, lv]) => cmd(t, { cmd: 'priority', level: lv, target: 1 }));
cmd('give the one before that high priority', { cmd: 'priority', level: 'high', target: 2 });
cmd('mark the second to last one low priority', { cmd: 'priority', level: 'low', target: 2 });
['remove the priority', 'no priority', 'take the priority off that', 'clear priority', 'make that no priority']
  .forEach(t => cmd(t, { cmd: 'priority', level: null }));
// 2. delete / undo
['scratch that', 'delete that last one', 'Scratch that.', 'delete the last note', 'strike that']
  .forEach(t => cmd(t, { cmd: 'delete', target: 1, recentOnly: false }));
cmd('never mind', { cmd: 'delete', recentOnly: true });
cmd('delete the one before that', { cmd: 'delete', target: 2 });
['bring that back', 'undo', 'undo that', 'Oops, bring it back', 'restore the deleted note'].forEach(t => cmd(t, { cmd: 'undo' }));
// 3. amend
cmd('add to that, it was raining hard.', { cmd: 'amend', text: 'it was raining hard.', explicit: true });
cmd('Also the driver braked late', { cmd: 'amend', text: 'the driver braked late', explicit: false });
cmd('And also, Exit 12 was closed.', { cmd: 'amend', text: 'Exit 12 was closed.', explicit: false });
cmd('Okay add to the last one: second car involved', { cmd: 'amend', text: 'second car involved', explicit: true });
// 4. retype
['change that to an intervention', 'make it an intervention', 'that was an intervention', 'Actually, that should be an intervention']
  .forEach(t => cmd(t, { cmd: 'retype', type: 'Intervention' }));
['make that a log', 'change it to a log'].forEach(t => cmd(t, { cmd: 'retype', type: 'Log' }));
// 5. read-back / counts
['read that back', 'what was the last note', 'read back the last note', 'what did you get'].forEach(t => cmd(t, { cmd: 'readback' }));
cmd('how many notes', { cmd: 'count', what: 'notes' });
cmd('how many interventions so far', { cmd: 'count', what: 'interventions' });
cmd('how many logs do I have', { cmd: 'count', what: 'logs' });
// 7. pause / resume
['pause notes', 'stop taking notes', 'pause logging'].forEach(t => cmd(t, { cmd: 'pause' }));
['resume notes', 'start taking notes', 'resume'].forEach(t => cmd(t, { cmd: 'resume' }));
// 8. mark
['mark', 'Mark that.', 'mark it', 'mark this spot'].forEach(t => cmd(t, { cmd: 'mark' }));
// false positives: ordinary speech must not be a command
['driver said that was a high speed merge', 'that was a high speed merge', 'give it a high five', 'drop it', 'forget it',
 'make a left here', "it's high", 'that is low', 'turn it up', 'mark my words that car is going to cut in', 'the priority lane is closed',
 'I can delete that app later', 'how is it going', 'also', 'Mark is in the passenger seat', 'that looks like a high curb']
  .forEach(t => cmd(t, null));

// ---------- priority markers ----------
assert.strictEqual(C.setPriority('brake fade', 'high'), 'brake fade $$$');
assert.strictEqual(C.setPriority('brake fade $$$', 'low'), 'brake fade $', 'replace, not stack');
assert.strictEqual(C.setPriority(C.setPriority(C.setPriority('x', 'low'), 'medium'), 'high'), 'x $$$');
assert.strictEqual(C.setPriority('brake fade $$', null), 'brake fade');
assert.strictEqual(C.getPriority('a $$'), 'medium');
ok('setPriority replaces instead of stacking, null removes');
assert.strictEqual(C.amendText('brake fade $$$', 'smell of burning'), 'brake fade; smell of burning $$$');
assert.strictEqual(C.amendText(C.PLACEHOLDER, 'cut off by a truck'), 'cut off by a truck');
assert.strictEqual(C.amendText('[marked event] $$', 'cut off by a truck'), 'cut off by a truck $$');
assert.strictEqual(C.amendText('pothole', 'high priority'), 'pothole $$$');
ok('amendText keeps $ marker at the end / replaces placeholder');

// ---------- planSegment: inline priority, commands vs keyword capture ----------
const plan = (input, expCmds, expNotes) => {
  const p = C.planSegment(input);
  const notes = p.notes.map(n => ({ type: n.type, text: n.level ? C.setPriority(n.text, n.level) : n.text }));
  assert.deepStrictEqual(p.commands.map(c => c.cmd), expCmds, `${input}: commands ${JSON.stringify(p.commands)}`);
  assert.deepStrictEqual(notes, expNotes, `${input}: notes ${JSON.stringify(notes)}`);
  ok(`plan ${JSON.stringify(input)} → cmds ${JSON.stringify(expCmds)} notes ${JSON.stringify(notes)}`);
};
plan('log high priority brake fade on the downhill', [], [{ type: 'Log', text: 'brake fade on the downhill $$$' }]);
plan('Log, high priority. Brake fade on the downhill.', [], [{ type: 'Log', text: 'Brake fade on the downhill $$$' }]);
plan('intervention urgent ran the red light', [], [{ type: 'Intervention', text: 'ran the red light $$$' }]);
plan('log pothole in right lane, medium priority', [], [{ type: 'Log', text: 'pothole in right lane $$' }]);
plan('log priority low faded lane lines', [], [{ type: 'Log', text: 'faded lane lines $' }]);
plan('log driver said that was a high speed merge', [], [{ type: 'Log', text: 'driver said that was a high speed merge' }]);
plan('log brake fade scratch that', [], [{ type: 'Log', text: 'brake fade scratch that' }]);
plan('intervention took over, mark that high priority', [], [{ type: 'Intervention', text: 'took over $$$' }]);  // inline priority on THIS note only
plan('log never mind the cones were fine', [], [{ type: 'Log', text: 'never mind the cones were fine' }]);
plan('log also the wipers turned on', [], [{ type: 'Log', text: 'also the wipers turned on' }]);
plan('okay log pause notes test', [], [{ type: 'Log', text: 'pause notes test' }]);
plan('change that to an intervention', ['retype'], []);          // contains keyword but is a whole command
plan('make that a log', ['retype'], []);
plan('scratch that. Log hard brake at the light', ['delete'], [{ type: 'Log', text: 'hard brake at the light' }]);
plan('that was a high speed merge', [], []);

// ---------- accuracy: fuzzy keywords (start of segment only) ----------
[['blog left lane drift', 'Log', 'left lane drift'], ['Lock, hard brake at the light', 'Log', 'hard brake at the light'],
 ['logged phantom brake', 'Log', 'phantom brake'], ['logs pothole on 94', 'Log', 'pothole on 94'], ['lug curb strike', 'Log', 'curb strike'],
 ['long merge was rough', 'Log', 'merge was rough'], ['la debris in lane', 'Log', 'debris in lane'], ['okay blog sun glare', 'Log', 'sun glare'],
 ['intervene cyclist cut in', 'Intervention', 'cyclist cut in'], ['In convention took over at the light', 'Intervention', 'took over at the light'],
 ['inter mention swerved toward cones', 'Intervention', 'swerved toward cones'], ['Intervened, ran the stop sign', 'Intervention', 'ran the stop sign'],
 ['log log brake fade', 'Log', 'brake fade'], ['log in the right lane, car drifted', 'Log', 'in the right lane, car drifted']]
  .forEach(([input, type, text]) => plan(input, [], [{ type, text }]));
// no false triggers: mishearing words are ignored anywhere but the start
['the blog post was long', 'I need to lock the car', 'we took the long way', 'he said intervene now', 'driver logged in',
 'there is a lag in the steering', 'that was a long light', 'the convention center exit']
  .forEach(input => plan(input, [], []));
plan('okay log brake fade, lock up on the left', [], [{ type: 'Log', text: 'brake fade, lock up on the left' }]);   // fuzzy word inside a capture stays text
plan('log brake fade intervene', [], [{ type: 'Log', text: 'brake fade intervene' }]);
// offsets map back to the ORIGINAL text (needed when a bare keyword is held across a pause)
assert.strictEqual(C.planSegment('in convention').notes[0].offset, 0);
assert.strictEqual(C.planSegment('okay in convention took over log x').notes[1].offset, 'okay in convention took over '.length);
assert.strictEqual(C.planSegment('log log brake log y').notes[1].offset, 'log log brake '.length);
ok('fuzzy keyword offsets map back to the original transcript');
// fuzzy keywords never steal a command
plan('lock that high priority', [], [{ type: 'Log', text: 'that $$$' }]);   // documented: a misheard keyword at the start is a note
cmd('scratch that', { cmd: 'delete' });

// ---------- accuracy: choosing among alternatives ----------
assert.strictEqual(C.chooseAlternative(['the blog post', 'log pothole near exit 3']), 'log pothole near exit 3');
assert.strictEqual(C.chooseAlternative(['scratch dad', 'scratch that']), 'scratch that');
assert.strictEqual(C.chooseAlternative(['log brake fade', 'lock brake fade']), 'log brake fade');           // top already has a keyword
assert.strictEqual(C.chooseAlternative(['nice weather today', 'nice weather to log']), 'nice weather today'); // alt keyword not at start → keep top
assert.strictEqual(C.chooseAlternative(['just talking', 'just walking']), 'just talking');
assert.strictEqual(C.chooseAlternative(['in convention took over', 'in convention took over']), 'in convention took over');
assert.strictEqual(C.chooseAlternative([]), '');
ok('chooseAlternative prefers keyword/command alternatives, else the top one');

// ---------- accuracy: corrections ----------
const CR = C.DEFAULT_CORRECTIONS;
assert.strictEqual(C.applyCorrections('way mo van cut in', CR), 'Waymo van cut in');
assert.strictEqual(C.applyCorrections('Way-mo and lie dar fault', CR), 'Waymo and lidar fault');
assert.strictEqual(C.applyCorrections('phantom breaking on 94', CR), 'phantom braking on 94');
assert.strictEqual(C.applyCorrections('the highway mode was on', CR), 'the highway mode was on');           // whole words only
assert.strictEqual(C.applyCorrections('a.b (c)', [{ from: '(c)', to: 'x' }]), 'a.b x');   // regex chars escaped
assert.strictEqual(C.applyCorrections('Cruise car', [{ from: 'cruise car', to: 'Cruise AV' }]), 'Cruise AV');
assert.strictEqual(C.applyCorrections('x', [{ from: '', to: 'y' }, null]), 'x');
ok('corrections: whole-word, case-insensitive, hyphen/space-flexible');

// ---------- export (Jason's spreadsheet layout) ----------
const ts = new Date(2026, 9, 17, 14, 3, 22).getTime();   // 2:03:22 PM local
const notes = [
  { ts, type: 'Log', text: 'tab\there "quoted" $$$', lat: 42.4806, lon: -83.4755 },
  { ts: new Date(2026, 9, 17, 10, 43, 25).getTime(), type: 'Intervention', text: 'took over at the light' },
  { ts: new Date(2026, 9, 17, 12, 1, 5).getTime(), type: 'Log', text: 'merge was smooth $$' },
  { ts: new Date(2026, 9, 17, 13, 1, 45).getTime(), type: 'Log', text: 'hard braking $' },
  { ts: new Date(2026, 9, 17, 0, 0, 0).getTime(), type: 'Log', text: 'midnight check' },
];
assert.deepStrictEqual(C.HEADER, ['Time (cmd+shift+:)', 'Logtime (s)', 'Type', 'Triage Priority', 'Comments']);
assert.deepStrictEqual(C.row(notes[0]), ['2:03:22 PM', '', 'Log', '', 'tab\there "quoted" $$$']);
assert.deepStrictEqual(C.row(notes[1]), ['10:43:25 AM', '', 'I', '', 'took over at the light']);
assert.deepStrictEqual(C.row(notes[2]), ['12:01:05 PM', '', 'Log', '', 'merge was smooth $$']);
assert.deepStrictEqual(C.row(notes[3]), ['1:01:45 PM', '', 'Log', '', 'hard braking $']);
assert.deepStrictEqual(C.row(notes[4]), ['12:00:00 AM', '', 'Log', '', 'midnight check']);
assert.strictEqual(C.exportType('Intervention'), 'I');
assert.strictEqual(C.exportType('Log'), 'Log');
const tsv = C.toTSV(notes, false);
assert.strictEqual(tsv.split('\n')[0], '2:03:22 PM\t\tLog\t\ttab here "quoted" $$$');
assert.strictEqual(tsv.split('\n')[1], '10:43:25 AM\t\tI\t\ttook over at the light');
assert.ok(C.toTSV(notes, true).startsWith('Time (cmd+shift+:)\tLogtime (s)\tType\tTriage Priority\tComments\n'));
assert.ok(!/\tLat\tLon|ISO timestamp/.test(C.toTSV(notes, true)));   // Lat/Lon stay out of Copy/CSV
const csv = C.toCSV(notes);
assert.ok(csv.startsWith('Time (cmd+shift+:),Logtime (s),Type,Triage Priority,Comments\r\n'));
assert.ok(csv.includes('2:03:22 PM,,Log,,"tab\there ""quoted"" $$$"'));  // tab kept inside the quoted CSV field
assert.ok(csv.includes('10:43:25 AM,,I,,took over at the light'));
assert.ok(csv.includes('1:01:45 PM,,Log,,hard braking $'));
ok('export: Jason\'s 5 columns — 12h AM/PM, Log vs I, empty Logtime & Triage Priority, $ markers in Comments, no Lat/Lon');
assert.strictEqual(C.startsWithKeyword('okay log brake fade'), true);
assert.strictEqual(C.startsWithKeyword('Okay, so intervention took over'), true);
assert.strictEqual(C.startsWithKeyword('traffic is heavy log x'), false);
assert.strictEqual(C.parseCommand('okay'), null);
ok('fillers before a leading keyword are recognized ("okay log …")');
// ---------- timestamps: 12-hour AM/PM + ISO offset in America/Detroit ----------
const tzOut = require('child_process').execFileSync(process.execPath, ['-e', `
  const C = require(${JSON.stringify(__dirname + '/core.js')});
  const r = d => ({ row: C.row({ ts: d.getTime(), type: 'Log', text: 'x' }), iso: C.isoLocal(d), clock: C.clock12(d) });
  console.log(JSON.stringify([
    r(new Date(2026, 9, 17, 14, 3, 22)),
    r(new Date(2027, 0, 15, 9, 0, 0)),
    r(new Date(Date.UTC(2026, 10, 1, 5, 30, 0))),
    r(new Date(2026, 9, 17, 10, 43, 25)),
    r(new Date(2026, 9, 17, 12, 1, 5)),
    r(new Date(2026, 9, 17, 13, 1, 45)),
  ]));
`], { env: { ...process.env, TZ: 'America/Detroit' } }).toString();
const [edt, est, dstEdge, am, noon, pm1] = JSON.parse(tzOut);
assert.strictEqual(edt.row[0], '2:03:22 PM'); assert.strictEqual(edt.iso, '2026-10-17T14:03:22-04:00');
assert.strictEqual(est.row[0], '9:00:00 AM'); assert.strictEqual(est.iso, '2027-01-15T09:00:00-05:00');
assert.strictEqual(dstEdge.clock, '1:30:00 AM'); assert.strictEqual(dstEdge.iso, '2026-11-01T01:30:00-04:00');
assert.deepStrictEqual([am.clock, noon.clock, pm1.clock], ['10:43:25 AM', '12:01:05 PM', '1:01:45 PM']);
ok('export Time is phone-local 12h AM/PM in America/Detroit (EDT/EST, noon/midnight edges)');

// ---------- persistence (persist.js): dual-store merge, drafts, journal, backup, export tracking ----------
const P = require('./persist.js');
const mk = (id, t, extra) => Object.assign({ id, session: 's1', ts: t, type: 'Log', text: 'note ' + id, created: t, updatedAt: t }, extra || {});
const base = () => ({ sessions: [{ id: 's1', name: 'Drive A', start: 1000 }], notes: [], settings: { gps: true }, current: 's1', view: 's1', savedAt: 0 });
{
  const a = base(), b = base();
  a.notes = [mk('n1', 1100), mk('n2', 1200, { text: 'old text', updatedAt: 1200 })];
  b.notes = [mk('n2', 1200, { text: 'new text', updatedAt: 1500 }), mk('n3', 1300)];
  const m = P.merge(a, b, 'newest');
  assert.deepStrictEqual(m.db.notes.map(n => n.id), ['n1', 'n2', 'n3']);
  assert.strictEqual(m.db.notes[1].text, 'new text');
  assert.deepStrictEqual([m.stats.added, m.stats.updated], [1, 1]);
  ok('merge: union by note id, newest updatedAt wins');
  const back = P.merge(b, a, 'newest');
  assert.strictEqual(back.db.notes.find(n => n.id === 'n2').text, 'new text');
  ok('merge is order-independent for note versions');
}
{
  const a = base(), b = base();
  a.notes = [mk('n1', 1100, { deleted: true, deletedAt: 2000, updatedAt: 2000 })];
  b.notes = [mk('n1', 1100)];                              // stale store still has it live
  assert.strictEqual(P.merge(a, b).db.notes[0].deleted, true);
  assert.strictEqual(P.merge(b, a).db.notes[0].deleted, true);
  assert.strictEqual(P.live(P.merge(b, a).db).length, 0);
  ok('merge: delete tombstones win over stale live copies (no resurrection)');
}
{
  assert.strictEqual(P.merge(null, null).db, null);
  const b = base(); b.notes = [mk('n1', 1)];
  assert.strictEqual(P.merge(null, b).db.notes.length, 1);
  assert.strictEqual(P.merge(b, { garbage: 1 }).db.notes.length, 1);
  ok('merge: one store empty or corrupt → the other store is used as-is');
}
{
  const a = base(); a.savedAt = 10; a.settings = { gps: false }; a.sessions[0].exportedAt = 500;
  const b = base(); b.savedAt = 20; b.settings = { gps: true }; b.sessions[0].exportedAt = 900;
  b.sessions.push({ id: 's2', name: 'Drive B', start: 5000 }); b.current = 's2';
  const m = P.merge(a, b, 'newest');
  assert.deepStrictEqual(m.db.sessions.map(s => s.id), ['s1', 's2']);
  assert.strictEqual(m.db.settings.gps, true); assert.strictEqual(m.db.current, 's2');
  assert.strictEqual(m.db.sessions[0].exportedAt, 900);
  assert.strictEqual(P.merge(a, b, 'a').db.settings.gps, false);
  ok('merge: sessions union, exportedAt = max, settings from newer (or preferred) store');
}
{
  const d = P.normalize({ sessions: [], notes: [mk('n1', 7000, { session: 'lost' })] });
  assert.deepStrictEqual(d.sessions.map(s => [s.id, s.synthetic]), [['lost', true]]);
  const real = { sessions: [{ id: 'lost', name: 'Drive real', start: 6000 }], notes: [] };
  assert.strictEqual(P.merge(d, real).db.sessions[0].name, 'Drive real');
  ok('notes whose session record is missing get a placeholder session, replaced by the real one on merge');
}
{
  const d = P.normalize({ sessions: [{ id: 's1' }], notes: [mk('n1', 1)], trash: [mk('t1', 2, { updated: 3 })] });
  assert.strictEqual(d.trash, undefined);
  assert.deepStrictEqual(d.notes.map(n => [n.id, !!n.deleted]), [['n1', false], ['t1', true]]);
  const legacy = P.normalize({ sessions: [], notes: [{ id: 'x', ts: 5, created: 6, updated: 9 }] });
  assert.strictEqual(legacy.notes[0].updatedAt, 9);
  ok('normalize: v1–v5 state migrates (updatedAt from updated/created/ts; old trash → tombstones)');
}
{
  const db = base(); db.notes = [mk('n1', 1100)];
  const drafts = [
    { key: P.draftKey(5000, 'Intervention'), session: 's1', ts: 5000, type: 'Intervention', text: 'took over at the', lat: 42.5, lon: -83.4, acc: 6, updatedAt: 5600 },
    { key: P.draftKey(1100, 'Log'), session: 's1', ts: 1100, type: 'Log', text: 'note n1', updatedAt: 1150 },      // already saved
    { key: P.draftKey(6000, 'Log'), session: 'gone', ts: 6000, type: 'Log', text: '', updatedAt: 6000 }];
  const rec = P.recoverDrafts(db, drafts, 9999);
  assert.strictEqual(rec.length, 2);
  assert.strictEqual(rec[0].text, 'took over at the (recovered)');
  assert.deepStrictEqual([rec[0].ts, rec[0].type, rec[0].lat, rec[0].lon, rec[0].recovered], [5000, 'Intervention', 42.5, -83.4, true]);
  assert.strictEqual(rec[1].text, '(recovered)'); assert.strictEqual(rec[1].session, 's1');
  assert.strictEqual(P.recoverDrafts(db, drafts, 10000).length, 0);
  ok('drafts: recovered as "(recovered)" notes with keyword-time timestamp + GPS; saved notes and repeats skipped');
  const md = P.mergeDrafts([{ key: 'k', text: 'a', updatedAt: 1 }], [{ key: 'k', text: 'ab', updatedAt: 2 }, { key: 'j', updatedAt: 1 }]);
  assert.deepStrictEqual(md.map(d => d.key + d.text), ['kab', 'jundefined']);
  ok('drafts from both stores merge by key, newest wins');
}
{
  const db = base(); const n1 = mk('n1', 1100), n2 = mk('n2', 1200);
  db.notes = [n1, Object.assign({}, n2, { deleted: true, deletedAt: 3000 })];
  const j = [P.jEntry('create', n1, 1100), P.jEntry('delete', mk('gone', 900), 2500), P.jEntry('delete', n2, 3000)];
  const rd = P.recentlyDeleted(db, j);
  assert.deepStrictEqual(rd.map(n => n.id), ['n2', 'gone']);
  assert.strictEqual(rd[1].fromJournal, true);
  assert.strictEqual(P.mergeJournal(j, j.slice(1)).length, 3);
  ok('recently deleted: tombstones + journal-only deletions, newest first; journal merge dedupes');
}
{
  const db = base(); db.notes = [mk('n1', 1100), mk('n2', 1200, { text: 'edited later', updatedAt: 4000 })];
  const j = [P.jEntry('create', db.notes[0], 1100)];
  const text = JSON.stringify(P.buildBackup(db, j, Date.UTC(2026, 9, 17, 15, 0)));
  const fresh = base(); fresh.settings = { gps: false }; fresh.notes = [mk('n2', 1200, { text: 'stale', updatedAt: 1200 }), mk('n9', 9000)];
  const r = P.restore(fresh, text, []);
  assert.deepStrictEqual(r.db.notes.map(n => n.id).sort(), ['n1', 'n2', 'n9']);
  assert.strictEqual(r.db.notes.find(n => n.id === 'n2').text, 'edited later');
  assert.strictEqual(r.db.settings.gps, false);            // local settings kept
  assert.deepStrictEqual([r.stats.added, r.stats.updated, r.journal.length], [1, 1, 1]);
  const again = P.restore(r.db, text, r.journal);
  assert.deepStrictEqual([again.stats.added, again.stats.updated, again.journal.length], [0, 0, 1]);
  ok('backup → restore round-trip merges (adds missing, newer wins, keeps local settings) and is idempotent');
  assert.throws(() => P.parseBackup('nope'), /Not a JSON file/);
  assert.throws(() => P.parseBackup('{"a":1}'), /Not a Drive Logger backup/);
  assert.strictEqual(P.parseBackup(JSON.stringify(db)).state.notes.length, 2);
  ok('backup parser rejects junk and accepts a raw saved state');
}
{
  const db = base(); db.notes = [mk('n1', 1100), mk('n2', 1200), mk('n3', 1300, { deleted: true })];
  assert.strictEqual(P.unexported(db, 's1'), 2);
  P.markExported(db, ['s1'], 1250);
  assert.strictEqual(P.unexported(db, 's1'), 0);
  db.notes[1].updatedAt = 1400;
  assert.strictEqual(P.unexported(db, 's1'), 1);
  ok('export tracking: notes created/edited after the last export count as not exported');
}
{
  let box = P.outboxAdd([], 'create', mk('n1', 1));
  box = P.outboxAdd(box, 'edit', mk('n1', 1, { updatedAt: 5 }));
  assert.strictEqual(box.length, 1); assert.strictEqual(box[0].op, 'edit');
  const inflight = box.slice();
  box = P.outboxAdd(box, 'edit', mk('n1', 1, { updatedAt: 9 }));
  assert.strictEqual(P.outboxAck(box, inflight).length, 1);   // changed while in flight → kept
  assert.strictEqual(P.outboxAck(box, box).length, 0);
  assert.ok(P.backoff(0) === 2000 && P.backoff(20) === 300000);
  ok('sync outbox (dormant): coalesces per note, keeps edits made in flight, capped backoff');
}

{
  const db = base(); db.settings.sheetSync = { url: 'https://script.google.com/macros/s/AKfycbX/exec', token: 'secret-123', enabled: true };
  const b = P.buildBackup(db, [], 1);
  assert.strictEqual(JSON.stringify(b).includes('secret-123'), false);
  assert.deepStrictEqual(b.state.settings.sheetSync, { url: 'https://script.google.com/macros/s/AKfycbX/exec', enabled: false });
  assert.strictEqual(db.settings.sheetSync.token, 'secret-123');
  ok('JSON backup omits the Sheets token (URL kept, sync off in the file); live settings untouched');
}
// ---------- Apps Script endpoint (docs/sheets-sync.gs) run against a mock Apps Script runtime ----------
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const GAS = require('./tools/gas-mock.js');
  const src = fs.readFileSync(path.join(__dirname, 'docs/sheets-sync.gs'), 'utf8');
  const tmpGs = path.join(os.tmpdir(), 'dl-sheets-sync-test.gs');
  fs.writeFileSync(tmpGs, src.replace("'REPLACE-WITH-A-LONG-RANDOM-STRING'", "'test-token-123'"));
  const T = 'test-token-123';
  const ev = (id, t, extra, op) => { const n = mk(id, t, extra); return { op: op || 'create', v: n.updatedAt, note: n,
    row: C.row(n), session: 'Drive 2026-10-17 11:47', updated: C.isoLocal(new Date(n.updatedAt)) }; };
  let g = GAS.load(tmpGs);
  let r = g.get();
  assert.deepStrictEqual(r.json, { ok: true, app: 'drive-logger-backup', version: 1 }); assert.strictEqual(r.mime, 'application/json');
  ok('script doGet: JSON health check, no data');
  assert.strictEqual(GAS.load(path.join(__dirname, 'docs/sheets-sync.gs')).post({ token: 'REPLACE-WITH-A-LONG-RANDOM-STRING', events: [] }).json.error, 'token not set in script');
  assert.strictEqual(g.post('not json{').json.error, 'bad json');
  assert.strictEqual(g.post({ token: 'wrong', events: [ev('n1', 1000)] }).json.error, 'unauthorized');
  assert.strictEqual(g.post({ events: [ev('n1', 1000)] }).json.error, 'unauthorized');
  assert.strictEqual(g.tab('Notes'), undefined, 'nothing written on auth failure');
  ok('script doPost: rejects bad JSON, missing/wrong token, and the placeholder token; writes nothing');
  r = g.post({ token: T, test: true, events: [] });
  assert.deepStrictEqual(r.json, { ok: true, test: true, tab: 'Notes', rows: 0 });
  const sh = g.tab('Notes');
  const HDR = ['Time (cmd+shift+:)', 'Logtime (s)', 'Type', 'Triage Priority', 'Comments', 'Lat', 'Lon', 'Session', 'Note ID', 'Updated', 'Deleted', 'Received'];
  assert.deepStrictEqual(sh._rows()[0], HDR); assert.strictEqual(sh.getFrozenRows(), 1);
  assert.deepStrictEqual(Object.keys(sh._fmt).map(Number).sort((a, b) => a - b), [0, 1, 3, 8, 9]);
  ok('script test ping: creates the Notes tab, 12 headers, frozen row, text format on Time/Logtime/Triage/ID/Updated');
  const t0 = new Date(2026, 9, 17, 14, 3, 22).getTime();
  r = g.post({ token: T, events: [ev('n1', t0, { lat: 42.5012, lon: -83.4447 }), ev('n2', t0 + 5000, { type: 'Intervention', text: 'took over $$$' })] });
  assert.deepStrictEqual([r.json.ok, r.json.added, r.json.updated], [true, 2, 0]);
  let rows = sh._rows();
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[1].slice(0, 11), [C.clock12(new Date(t0)), '', 'Log', '', 'note n1', 42.5012, -83.4447,
    'Drive 2026-10-17 11:47', 'n1', C.isoLocal(new Date(t0)), '']);
  assert.ok(rows[1][11] instanceof Date);
  assert.strictEqual(rows[2][2], 'I'); assert.strictEqual(rows[2][4], 'took over $$$');
  ok('script upsert: new notes appended in one block, mapped to Jason\'s export columns + Lat/Lon + Session/ID/Updated/Received');
  r = g.post({ token: T, events: [ev('n1', t0, { lat: 42.5012, lon: -83.4447 }), ev('n2', t0 + 5000, { type: 'Intervention', text: 'took over $$$' })] });
  assert.deepStrictEqual([r.json.added, r.json.updated, sh._rows().length], [0, 2, 3]);
  ok('script upsert: re-sending the same notes (retry) updates in place, never duplicates');
  r = g.post({ token: T, events: [ev('n1', t0, { text: 'edited text', updatedAt: t0 + 60000 }, 'edit')] });
  assert.strictEqual(sh._rows()[1][4], 'edited text');
  r = g.post({ token: T, events: [ev('n1', t0, { text: 'stale retry', updatedAt: t0 + 1000 }, 'edit')] });
  assert.deepStrictEqual([r.json.skipped, sh._rows()[1][4]], [1, 'edited text']);
  ok('script upsert: newer edit wins; an older version arriving late is skipped');
  g.post({ token: T, events: [ev('n2', t0 + 5000, { type: 'Intervention', text: 'took over $$$', deleted: true, updatedAt: t0 + 90000 }, 'delete')] });
  assert.strictEqual(sh._rows()[2][10], 'TRUE');
  g.post({ token: T, events: [ev('n3', t0 + 9000, { text: '=HYPERLINK("http://x","y")' }), ev('n4', t0 + 9500, { text: '-5 mph over limit' })] });
  rows = sh._rows();
  assert.strictEqual(rows[3][4], '=HYPERLINK("http://x","y")'); assert.ok(sh._quoted['3,4'] && sh._quoted['4,4']);
  ok('script: deletes marked Deleted=TRUE (row kept); formula-like note text stored as literal text');
  const many = Array.from({ length: 120 }, (_, i) => ev('m' + i, t0 + 20000 + i));
  r = g.post({ token: T, events: many });
  assert.deepStrictEqual([r.json.added, sh._rows().length], [120, 125]);
  assert.strictEqual(g.locks.held, 0); assert.ok(g.locks.taken >= 8);
  ok('script: 120-note batch in one call; the script lock is always released');
  // Jason's own layout later: reordered columns, an extra column of his own, some headers missing
  g = GAS.load(tmpGs, { preTab: 'Notes', headers: ['Note ID', 'My comments', 'Type', 'Comments'] });
  g.tab('Notes').getRange(2, 1, 1, 4).setValues([['n1', 'keep me', 'Log', 'old']]);
  r = g.post({ token: T, events: [ev('n1', t0), ev('n9', t0 + 1)] });
  rows = g.tab('Notes')._rows();
  assert.deepStrictEqual(rows[0].slice(0, 5), ['Note ID', 'My comments', 'Type', 'Comments', 'Time (cmd+shift+:)']);
  assert.deepStrictEqual(rows[1].slice(0, 4), ['n1', 'keep me', 'Log', 'note n1']);
  assert.strictEqual(rows[1][4], C.clock12(new Date(t0)));
  assert.deepStrictEqual([rows.length, rows[2][0], rows[2][1]], [3, 'n9', '']);
  ok('script: columns found by header name; custom layout + extra user columns preserved; missing headers appended');
}
console.log(`\nAll ${passed} tests passed`);

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

// ---------- export ----------
const ts = new Date(2026, 9, 17, 14, 3, 22).getTime();
const notes = [{ ts, type: 'Log', text: 'tab\there "quoted" $$$', lat: 42.4806, lon: -83.4755 }, { ts, type: 'Intervention', text: '"starts quoted' }];
const tsv = C.toTSV(notes, false);
assert.strictEqual(tsv.split('\n')[0].split('\t').length, 5);
assert.ok(tsv.split('\n')[0].endsWith('$$$'));
assert.ok(C.toTSV(notes, true).startsWith('Date\tTime\tISO timestamp\tType\tNote\n'));
const g = C.toTSV(notes, true, { gps: true }).split('\n');
assert.strictEqual(g[0], 'Date\tTime\tISO timestamp\tType\tNote\tLat\tLon');
assert.ok(g[1].endsWith('\t42.480600\t-83.475500'));
assert.ok(g[2].endsWith('\t\t'));
assert.ok(C.toCSV(notes).startsWith('Date,Time,ISO timestamp,Type,Note\r\n'));
assert.ok(C.toCSV(notes, { gps: true }).startsWith('Date,Time,ISO timestamp,Type,Note,Lat,Lon\r\n'));
ok('export: 5 columns by default, Lat/Lon appended only with GPS on, $ markers inside Note');
assert.strictEqual(C.startsWithKeyword('okay log brake fade'), true);
assert.strictEqual(C.startsWithKeyword('Okay, so intervention took over'), true);
assert.strictEqual(C.startsWithKeyword('traffic is heavy log x'), false);
assert.strictEqual(C.parseCommand('okay'), null);
ok('fillers before a leading keyword are recognized ("okay log …")');
// ---------- timestamps: local offset in America/Detroit (EDT -04:00 / EST -05:00) ----------
const tzOut = require('child_process').execFileSync(process.execPath, ['-e', `
  const C = require(${JSON.stringify(__dirname + '/core.js')});
  const r = d => C.row({ ts: d.getTime(), type: 'Log', text: 'x' });
  console.log(JSON.stringify([r(new Date(2026, 9, 17, 14, 3, 22)), r(new Date(2027, 0, 15, 9, 0, 0)), r(new Date(Date.UTC(2026, 10, 1, 5, 30, 0)))]));
`], { env: { ...process.env, TZ: 'America/Detroit' } }).toString();
const [edt, est, dstEdge] = JSON.parse(tzOut);
assert.deepStrictEqual(edt.slice(0, 3), ['2026-10-17', '14:03:22', '2026-10-17T14:03:22-04:00']);
assert.deepStrictEqual(est.slice(0, 3), ['2027-01-15', '09:00:00', '2027-01-15T09:00:00-05:00']);
assert.deepStrictEqual(dstEdge.slice(0, 3), ['2026-11-01', '01:30:00', '2026-11-01T01:30:00-04:00']);   // 05:30Z, before the 06:00Z fall-back
ok('ISO timestamps carry the correct America/Detroit offset (EDT -04:00, EST -05:00, DST edge)');
console.log(`\nAll ${passed} tests passed`);

/* Drive Logger core: keyword parsing, voice-command grammar, priority markers, export formatting.
   Pure functions, no DOM. Works in the browser (window.DLCore) and in Node (require). */
(function (root) {
  'use strict';
  var KW_SRC = '\\b(log|intervention)\\b';

  function clean(s) {
    return String(s)
      .replace(/^[\s,.:;!?\-–—]+/, '')
      .replace(/[\s,;:\-–—]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Every keyword in an utterance; each note is the text after it up to the next keyword. */
  function parseUtterance(text) {
    text = String(text || '');
    var re = new RegExp(KW_SRC, 'gi'), hits = [], m;
    while ((m = re.exec(text))) hits.push({ kw: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
    return hits.map(function (h, i) {
      var stop = i + 1 < hits.length ? hits[i + 1].start : text.length;
      return { type: h.kw === 'log' ? 'Log' : 'Intervention', text: clean(text.slice(h.end, stop)), offset: h.start };
    });
  }

  // ---------------- priority markers ($$$ high, $$ medium, $ low) ----------------
  var LEVEL_WORDS = 'highest|high|top|urgent|critical|important|medium|med|mid|moderate|normal|lowest|low|minor';
  function levelOf(w) {
    w = String(w || '').toLowerCase();
    if (/^(highest|high|top|urgent|critical|important)$/.test(w)) return 'high';
    if (/^(medium|med|mid|moderate|normal)$/.test(w)) return 'medium';
    if (/^(lowest|low|minor)$/.test(w)) return 'low';
    return null;
  }
  var MARK = { high: '$$$', medium: '$$', low: '$' };
  function splitPriority(text) {
    text = String(text || '');
    var m = /\s*(\$+)\s*$/.exec(text);
    if (!m) return { base: text.trim(), level: null };
    var n = m[1].length;
    return { base: text.slice(0, m.index).trim(), level: n >= 3 ? 'high' : n === 2 ? 'medium' : 'low' };
  }
  /** Replace (never stack) the trailing $ marker. level null → remove it. */
  function setPriority(text, level) {
    var base = splitPriority(text).base;
    if (!level) return base;
    base = base.replace(/[.!]+$/, '');                    // "Brake fade." → "Brake fade $$$"
    return (base ? base + ' ' : '') + MARK[level];
  }
  function getPriority(text) { return splitPriority(text).level; }

  /** Inline priority while dictating: "high priority brake fade" / "brake fade, high priority" / "urgent brake fade". */
  function extractInlinePriority(text) {
    var t = String(text || ''), level = null, m;
    var LV = '(' + LEVEL_WORDS + ')';
    var lead = new RegExp('^(?:(?:a|an|at|with)\\s+)?' + LV + '[\\s-]+priority(?:[\\s,.:;!\\-–—]+|$)', 'i');
    var lead2 = new RegExp('^priority[\\s,:]+' + LV + '(?:[\\s,.:;!\\-–—]+|$)', 'i');
    var lead3 = /^(urgent|critical)(?:[\s,.:;!\-–—]+|$)/i;
    var trail = new RegExp('(?:^|[\\s,.;:\\-–—]+)(?:(?:it\'?s|that\'?s|this is|(?:mark|make|set|flag|give|call)\\s+(?:that|it|this))\\s+)?(?:(?:as|a|an)\\s+)*' + LV + '[\\s-]+priority[.!]?$', 'i');
    var trail2 = new RegExp('(?:^|[\\s,.;:\\-–—]+)priority[\\s,:]+' + LV + '[.!]?$', 'i');
    if ((m = lead.exec(t)) || (m = lead2.exec(t)) || (m = lead3.exec(t))) { level = levelOf(m[1]); t = t.slice(m[0].length); }
    else if ((m = trail.exec(t)) || (m = trail2.exec(t))) { level = levelOf(m[1]); t = t.slice(0, m.index); }
    return { text: clean(t), level: level };
  }

  var PLACEHOLDER = '[marked event]';
  /** Append to a note, keeping its $ marker at the end. A placeholder is replaced, not appended to. */
  function amendText(orig, add) {
    var p = splitPriority(orig), inl = extractInlinePriority(add);
    var base = p.base, extra = inl.text;
    var joined = !base || base === PLACEHOLDER ? extra : extra ? base.replace(/[.;,]+$/, '') + '; ' + extra : base;
    return setPriority(joined, inl.level || p.level);
  }

  // ---------------- voice command grammar ----------------
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[’‘`]/g, "'").replace(/'/g, '')          // that's → thats
      .replace(/[-–—_]/g, ' ')
      .replace(/[^a-z0-9$ ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  var FILLER = /^(?:(?:okay|ok|um+|uh+|er|hmm+|so|hey|alright|all right|oh|oops|wait|actually|and|please|now|yeah|yes|right|well|sorry)\s+)+/;
  var TAIL = /(?:\s+(?:please|thanks|thank you|for me|now))+$/;
  function stripFillers(s) { return (s + ' ').replace(FILLER, '').trim().replace(TAIL, '').trim(); }

  var REF1 = '(?:that last one|this last one|that last note|the last one|last one|the last note|last note|the last entry|last entry|' +
    'the latest one|the latest note|the most recent one|the most recent note|the previous one|previous one|the previous note|previous note|' +
    'that one|this one|that note|this note|that entry|the note|the last|that|this|it)';
  var REF2 = '(?:the one before that|the one before this|the one before last|one before last|the one before|the note before that|the note before|' +
    'the second to last one|second to last one|the second to last note|second to last note|the second to last|second to last|' +
    'the second last one|second last one|the penultimate one)';
  var REF = '(' + REF2 + '|' + REF1 + ')';
  var REF2_RE = new RegExp('^' + REF2 + '$');
  function target(ref) { return ref && REF2_RE.test(ref) ? 2 : 1; }
  var LV = '(' + LEVEL_WORDS + ')';
  var PVERB = '(?:give|set|mark|make|bump|put|flag|tag|change|raise|lower|drop|move|label|upgrade|downgrade|turn|rate|call|switch|update)';
  var PW = '(?:priority|prio)';
  function R(src) { return new RegExp('^' + src + '$'); }

  var RX = {
    undo: R('(?:bring (?:that|it|the last one|the note|that note|that one) back|undo(?: that| it| the delete| delete| the last delete| delete that)?|' +
      'undelete(?: that| it)?|restore(?: (?:that|it|the last one|the note|that note|the deleted note|the deleted one|the last deleted note))?|' +
      'put (?:that|it) back|i didnt mean to delete that)'),
    unprio1: R('(?:remove|clear|drop|delete|strip|cancel|reset|kill|take off|take away)(?: (?:the|its|that|any))? ' + PW + '(?: (?:marker|level|flag))?(?: (?:from|on|off|for) ' + REF + ')?'),
    unprio2: R('(?:take|remove|clear|drop|strip) (?:the )?' + PW + ' (?:off|from|of) ' + REF),
    unprio3: R('(?:(?:' + PVERB + '|thats|that is|its|it is)(?: ' + REF + ')?(?: (?:as|to|a|an|have|has))* )?(?:no|zero|without|not a) ' + PW),
    unprio4: R('(?:unmark|unflag|deprioritize)(?: ' + REF + ')?'),
    del: R('(?:scratch|strike|delete|erase|remove|cancel|trash) ' + REF + '(?: (?:note|entry|one))?'),
    delRecent: R('(?:never mind|nevermind|nvm|never mind that|forget that|disregard that|disregard)'),
    retype1: R('(?:change|make|switch|turn|convert|mark|set|reclassify|flip|call) ' + REF + '(?: (?:to|into|as|over to|back to|back into))?(?: (?:an|a|the))? (intervention|log)(?: (?:note|entry|instead|one))*'),
    retype2: R('(?:' + REF + '|thats|that is|its|it is) ?(?:was|is|should be|should have been|needs to be)?(?: (?:an|a))? (intervention|log)(?: (?:not a log|not an intervention|instead))?'),
    prio1: R(PVERB + '(?: ' + REF + ')?(?: (?:as|to|at|a|an|with|the|up|down|its|it|is|be|into|over))* ' + LV + '(?: (' + PW + '))?(?: (?:one|note|item|event))?'),
    prio2: R(PVERB + '(?: ' + REF + ')?(?: (?:the|a|an|its|it|that|to))? ' + PW + '(?: level)?(?: (?:of|to|as|at|is|on|for))*(?: ' + REF + ')?(?: (?:to|as|at))? ' + LV),
    prio3: R('(?:(?:' + REF + '|thats|that is|its|it is|this is|that was|that should be|it should be|that needs to be|that ones|that one is)(?: (?:a|an|is|was))? )?' + LV + ' ' + PW + '(?: (?:one|note|item|event))?'),
    prio4: R('(?:thats|that is|its|it is|that was|this is) (urgent|critical)'),
    amend: R('(add to ' + REF + '|add on to ' + REF + '|update ' + REF + ' with|add on|add that|add|and also|also|additionally|one more thing)(?: (.+))'),
    read: R('(?:read (?:that|it|the last one|the last note|that last one|last note|that note|the note|that one|the last) back|' +
      'read back(?: (?:that|the last one|the last note|last note))?|read (?:me )?(?:back )?(?:the )?last (?:one|note|entry)|' +
      'what (?:was|is|were) (?:the|my) last (?:one|note|entry|log|thing)|whats the last (?:one|note|entry)|' +
      'what did (?:i|you) (?:just )?(?:say|log|write|get|note|put down|record)|repeat (?:that|it|the last one|the last note|last note)|say that again|what did you get)'),
    count: R('(?:how many(?: (notes|interventions|intervention|logs|entries|events|things))?(?: (?:do i have|do we have|have i got|have we got|have i logged|have we logged|have i made|are there|is that|so far|this session|in this session|total|in total|logged|now|today|did i log|did we log))*|' +
      '(?:count|number of)(?: the)? (notes|interventions|logs)|note count|whats the count|give me a count|whats my count)'),
    pause: R('(?:(?:pause|stop|hold|suspend|mute|quit)(?: (?:taking|the|my))* (?:notes|note taking|notetaking|logging|recording|listening|transcribing)|take a break|go to sleep|stop taking notes)'),
    resume: R('(?:(?:resume|restart|start|continue|unpause|begin|keep)(?: (?:taking|the|my))* (?:notes|note taking|notetaking|logging|recording|listening|transcribing)|resume|unpause|wake up|im back|start again|keep going)'),
    mark: R('(?:mark|marc|mark that|mark it|mark this|mark here|mark now|mark event|mark the event|mark mark|mark this spot|mark that spot|flag|flag that|flag it|flag this|bookmark|bookmark that)')
  };

  /** Recover the command's free text from the ORIGINAL (cased, punctuated) string by skipping n normalized words. */
  function tailAfterWords(original, words) {
    var src = '^[^a-z0-9]*' + words.map(function (w) { return w.replace(/[^a-z0-9]/g, '') ? w.split('').map(function (c) { return /[a-z0-9]/.test(c) ? c : ''; }).join("[’'`]?") : ''; })
      .filter(Boolean).join('[^a-z0-9]+') + '[^a-z0-9]+([\\s\\S]*)$';
    var m = new RegExp(src, 'i').exec(original);
    return m ? clean(m[1]) : null;
  }

  /** Parse a whole utterance as a command. Returns null unless the ENTIRE utterance is command-shaped. */
  function parseCommand(text) {
    var full = norm(text), s = stripFillers(full), m;
    if (!s) return null;
    if (RX.undo.test(s)) return { cmd: 'undo' };
    if ((m = RX.unprio1.exec(s)) || (m = RX.unprio2.exec(s)) || (m = RX.unprio3.exec(s)) || (m = RX.unprio4.exec(s)))
      return { cmd: 'priority', level: null, target: target(m[1]) };
    if ((m = RX.del.exec(s))) return { cmd: 'delete', target: target(m[1]), recentOnly: false };
    if (RX.delRecent.test(s)) return { cmd: 'delete', target: 1, recentOnly: true };
    if ((m = RX.retype1.exec(s))) return { cmd: 'retype', type: m[2] === 'log' ? 'Log' : 'Intervention', target: target(m[1]) };
    if ((m = RX.retype2.exec(s)) && /^(?:that|this|it|thats|its|the last|last|previous|the previous)/.test(s))
      return { cmd: 'retype', type: m[2] === 'log' ? 'Log' : 'Intervention', target: target(m[1]) };
    if ((m = RX.prio1.exec(s)) && (m[1] || m[3])) return { cmd: 'priority', level: levelOf(m[2]), target: target(m[1]) };
    if ((m = RX.prio2.exec(s))) return { cmd: 'priority', level: levelOf(m[3]), target: target(m[1] || m[2]) };
    if ((m = RX.prio3.exec(s))) return { cmd: 'priority', level: levelOf(m[2]), target: target(m[1]) };
    if ((m = RX.prio4.exec(s))) return { cmd: 'priority', level: 'high', target: 1 };
    if (RX.read.test(s)) return { cmd: 'readback', target: 1 };
    if ((m = RX.count.exec(s))) {
      var w = m[1] || m[2] || 'notes';
      return { cmd: 'count', what: /^intervention/.test(w) ? 'interventions' : /^log/.test(w) ? 'logs' : 'notes' };
    }
    if (RX.pause.test(s)) return { cmd: 'pause' };
    if (RX.resume.test(s)) return { cmd: 'resume' };
    if (RX.mark.test(s)) return { cmd: 'mark' };
    if ((m = RX.amend.exec(s))) {
      var explicit = !!(m[2] || m[3] || m[4]);
      // drop the fillers we stripped, then the command words, from the original text
      var lead = full.slice(0, full.length - full.replace(FILLER, '').length).trim();
      var words = (lead ? lead.split(' ') : []).concat(m[1].split(' '));
      var add = tailAfterWords(String(text), words);
      if (add === null) add = m[m.length - 1];
      if (m[1] === 'add that') add = add.replace(/^that\s+/i, '');
      if (!add) return null;
      return { cmd: 'amend', text: add, explicit: explicit, target: 1 };
    }
    return null;
  }

  // ---------------- recognition accuracy helpers ----------------
  // Common mishearings of the keywords. Only applied at the START of a segment (= right after a pause),
  // optionally after fillers like "okay", so ordinary speech never triggers them.
  var FUZZY_LOG = "blog|blogs|lock|locks|logged|logs|logue|lug|lugs|long|la|lag|lab|loge";
  var FUZZY_INT = "intervene|intervenes|intervened|intervening|interventions|intervension|intervent|in convention|inter mention|" +
    "inter vention|in the vention|enter vention|enter mention|in a vention|intra vention|inner vention|interventional";
  var LEAD_FILLER = "(?:(?:okay|ok|um+|uh+|er|so|hey|alright|all right|oh|and|now|yeah|right|well)[\\s,.!?]+)*";
  var FUZZY_RE = new RegExp("^([\\s,.!?]*" + LEAD_FILLER + ")(" + FUZZY_LOG + "|" + FUZZY_INT + ")(?=[\\s,.:;!?\\-–—]|$)", "i");
  var DUP_KW_RE = /\b(log|intervention)(?:[\s,.:;!?\-–—]+\1\b)+/gi;
  /** Returns { text, at, delta }: text with a start-of-segment mishearing replaced by the real keyword and
      doubled keywords ("log log") collapsed. Offsets after `at` shift by `delta`; mapOffset() undoes that. */
  function fixKeywords(text) {
    text = String(text || '');
    var out = text, at = -1, delta = 0, m = FUZZY_RE.exec(text);
    if (m && !new RegExp('^' + KW_SRC + '$', 'i').test(m[2])) {
      var kw = new RegExp('^(?:' + FUZZY_INT + ')$', 'i').test(m[2]) ? 'intervention' : 'log';
      at = m[1].length; delta = kw.length - m[2].length;
      out = text.slice(0, at) + kw + text.slice(at + m[2].length);
    }
    var dupCut = [];
    out = out.replace(DUP_KW_RE, function (all, kw, off) { dupCut.push([off, all.length - kw.length]); return kw; });
    return { text: out, at: at, delta: delta, dupCut: dupCut };
  }
  function mapOffset(fx, off) {           // offset in fixed text → offset in original text
    fx.dupCut.slice().reverse().forEach(function (d) { if (off > d[0]) off += d[1]; });
    if (fx.at >= 0 && off > fx.at) off -= fx.delta;
    return off;
  }
  /** Keywords as the app will see them (with fuzzy start + dedupe). */
  function keywordsIn(text) { return parseUtterance(fixKeywords(text).text); }
  function startsWithKeyword(text) {
    var k = keywordsIn(text);
    return !!k.length && !stripFillers(norm(fixKeywords(text).text.slice(0, k[0].offset)));
  }
  /** Pick among recognition alternatives: keep the top one unless it has no keyword/command and a
      lower-ranked one STARTS with a keyword (incl. fuzzy) or is a whole command. */
  function chooseAlternative(alts) {
    alts = (alts || []).filter(function (a) { return a != null; }).map(String);
    if (!alts.length) return '';
    var top = alts[0];
    if (keywordsIn(top).length || parseCommand(top)) return top;
    for (var i = 1; i < alts.length; i++) if (startsWithKeyword(alts[i]) || parseCommand(alts[i])) return alts[i];
    return top;
  }
  /** User corrections: [{from:'way mo', to:'Waymo'}]. Whole-word, case-insensitive, spaces/hyphens flexible. */
  var DEFAULT_CORRECTIONS = [
    { from: 'way mo', to: 'Waymo' }, { from: 'way moe', to: 'Waymo' }, { from: 'lie dar', to: 'lidar' }, { from: 'light ar', to: 'lidar' },
    { from: 'lighter sensor', to: 'lidar sensor' }, { from: 'phantom breaking', to: 'phantom braking' }, { from: 'hard breaking', to: 'hard braking' },
    { from: 'dis engagement', to: 'disengagement' }, { from: 'zooks', to: 'Zoox' }, { from: 'tele op', to: 'teleop' },
    { from: 'a dass', to: 'ADAS' }, { from: 'f s d', to: 'FSD' }, { from: 'v r u', to: 'VRU' }, { from: 'o d d', to: 'ODD' }
  ];
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function applyCorrections(text, list) {
    text = String(text || '');
    (list || []).forEach(function (c) {
      var from = String(c && c.from || '').trim(); if (!from) return;
      var pat = from.split(/[\s\-]+/).map(escRe).join('[\\s\\-]+');
      text = text.replace(new RegExp('(^|[^A-Za-z0-9])' + pat + '(?=$|[^A-Za-z0-9])', 'gi'), function (all, pre) { return pre + String(c.to || ''); });
    });
    return text;
  }

  /** Plan one finalized utterance segment: commands to run (in order) and notes to save.
      Commands are matched only on the whole segment or on the text BEFORE the first keyword,
      never on text captured after a keyword. */
  function planSegment(text) {
    text = String(text || '');
    var fx = fixKeywords(text), ft = fx.text;
    var occ = parseUtterance(ft);
    var startsWithKw = occ.length && !stripFillers(norm(ft.slice(0, occ[0].offset)));
    if (!startsWithKw) {
      var whole = parseCommand(text);
      if (whole) return { commands: [whole], notes: [] };
    }
    var commands = [];
    if (occ.length) {
      var pre = ft.slice(0, occ[0].offset), c = parseCommand(pre);
      if (c) commands.push(c);
    }
    var notes = occ.map(function (o) {
      var ip = extractInlinePriority(o.text);
      return { type: o.type, text: ip.text, level: ip.level, offset: mapOffset(fx, o.offset) };
    });
    return { commands: commands, notes: notes };
  }

  // ---------------- export (Jason's spreadsheet layout) ----------------
  // Time (cmd+shift+:) · Logtime (s) · Type · Triage Priority · Comments
  // Logtime and Triage Priority are left empty for later fill-in. Priority markers stay inside Comments.
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function localTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function isoLocal(d) {
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return localDate(d) + 'T' + localTime(d) + sign + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
  }
  /** 12-hour clock with AM/PM, no leading zero on the hour: "10:43:25 AM", "1:01:45 PM". Phone-local time. */
  function clock12(d) {
    var h = d.getHours(), m = pad(d.getMinutes()), s = pad(d.getSeconds()), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (!h) h = 12;
    return h + ':' + m + ':' + s + ' ' + ap;
  }
  /** Spreadsheet Type column: "Log" or "I" (Intervention). */
  function exportType(type) { return type === 'Intervention' ? 'I' : 'Log'; }
  var HEADER = ['Time (cmd+shift+:)', 'Logtime (s)', 'Type', 'Triage Priority', 'Comments'];
  function header() { return HEADER.slice(); }
  function row(note) {
    return [clock12(new Date(note.ts)), '', exportType(note.type), '', note.text || ''];
  }
  function tsvField(v) {
    v = String(v).replace(/[\t\r\n]+/g, ' ');
    return /^"/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function toTSV(notes, withHeader, opts) {
    var rows = notes.map(function (n) { return row(n, opts); });
    if (withHeader) rows.unshift(header(opts));
    return rows.map(function (r) { return r.map(tsvField).join('\t'); }).join('\n');
  }
  function csvField(v) {
    v = String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function toCSV(notes, opts) {
    var rows = [header(opts)].concat(notes.map(function (n) { return row(n, opts); }));
    return rows.map(function (r) { return r.map(csvField).join(','); }).join('\r\n') + '\r\n';
  }

  var api = { parseUtterance: parseUtterance, clean: clean, parseCommand: parseCommand, planSegment: planSegment,
    setPriority: setPriority, getPriority: getPriority, splitPriority: splitPriority, extractInlinePriority: extractInlinePriority,
    amendText: amendText, PLACEHOLDER: PLACEHOLDER, norm: norm,
    fixKeywords: fixKeywords, keywordsIn: keywordsIn, startsWithKeyword: startsWithKeyword, chooseAlternative: chooseAlternative, applyCorrections: applyCorrections,
    DEFAULT_CORRECTIONS: DEFAULT_CORRECTIONS,
    toTSV: toTSV, toCSV: toCSV, row: row, header: header, localDate: localDate, localTime: localTime, isoLocal: isoLocal,
    clock12: clock12, exportType: exportType, HEADER: HEADER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DLCore = api;
})(this);

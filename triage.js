/* triage.js: the rules for self-rating words 0 to 5 (LingQ levels) and for saving that rating into
   a progress file (dutch/<person>.csv) without touching any other line. No screen, no network. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./matcher.js'));
  else root.Triage = factory(root.Matcher);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  var LEVELS = [
    { n: 0, name: 'New', short: 'New' },
    { n: 1, name: 'New LingQ', short: 'New LingQ' },
    { n: 2, name: 'Recognized', short: 'Recognized' },
    { n: 3, name: 'Familiar', short: 'Familiar' },
    { n: 4, name: 'Learned', short: 'Learned' },
    { n: 5, name: 'Known ✓', short: 'Known' }
  ];
  // What each level is saved as, in words the Cobra phone already understands (16 Nov 2026).
  var SAVE_AS = {
    0: { status: 'unknown',        streak: '0', days: 0 },   // next_due = rating date = "rated 0" marker
    1: { status: 'needs_practice', streak: '0', days: 0 },
    2: { status: 'learning',       streak: '1', days: 2 },
    3: { status: 'learning',       streak: '2', days: 7 },
    4: { status: 'known',          streak: '3', days: 60 },
    5: { status: 'known',          streak: '5', days: 365 }
  };

  function addDays(ymd, n) {
    var p = ymd.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) { // b - a, in days
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }

  // the three columns that change when a word is rated
  function fieldsFor(level, ymd) {
    var s = SAVE_AS[level];
    return { status: s.status, streak: s.streak, next_due: addDays(ymd, s.days) };
  }

  // null = not rated yet. Otherwise 0..5 (a best guess if the phone changed the row since).
  function levelOf(row, todayYmd) {
    var st = (row && row.status) || 'unknown', due = (row && row.next_due) || '';
    if (st === 'unknown' || st === '') return due ? 0 : null;
    if (st === 'needs_practice') return 1;
    if (st === 'learning') return parseInt(row.streak || '0', 10) >= 2 ? 3 : 2;
    if (st === 'known') return due && daysBetween(todayYmd, due) >= 200 ? 5 : 4;
    return null;
  }

  // ---- saving: change only the lines of the words that were rated ----
  function keyOf(dutch, english) { return dutch + '\u0001' + english; }
  function sortKey(f) { return [f.dutch.toLowerCase(), f.english.toLowerCase()]; }
  function before(a, b) { // a sorts before b (same order as Python's sorted on lower-case)
    var x = sortKey(a), y = sortKey(b);
    return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  }

  /* changes: [{dutch, english, fields: {status, streak, next_due}}]
     returns {text, changed, inserted}. Untouched lines stay byte for byte as they were. */
  function patchProgress(text, changes) {
    var nl = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = text.split(nl), endsWithNl = lines.length && lines[lines.length - 1] === '';
    if (endsWithNl) lines.pop();
    var head = M.parseCSV(lines[0])[0];
    var col = {}; head.forEach(function (h, i) { col[h] = i; });
    ['dutch', 'english', 'status', 'streak', 'next_due'].forEach(function (c) {
      if (!(c in col)) throw new Error('progress file has no "' + c + '" column');
    });
    var at = new Map();
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      var f = M.parseCSV(lines[i])[0];
      if (f && f.length > col.english) at.set(keyOf(f[col.dutch], f[col.english]), i);
    }
    var changed = 0, inserted = [];
    changes.forEach(function (c) {
      var idx = at.get(keyOf(c.dutch, c.english));
      if (idx !== undefined) {
        var f = M.parseCSV(lines[idx])[0];
        while (f.length < head.length) f.push('');
        Object.keys(c.fields).forEach(function (k) { if (k in col) f[col[k]] = c.fields[k]; });
        var out = M.csvLine(f);
        if (out !== lines[idx]) { lines[idx] = out; changed++; }
      } else {
        var f2 = head.map(function () { return ''; });
        f2[col.dutch] = c.dutch; f2[col.english] = c.english;
        if ('right' in col) f2[col.right] = '0';
        if ('wrong' in col) f2[col.wrong] = '0';
        Object.keys(c.fields).forEach(function (k) { if (k in col) f2[col[k]] = c.fields[k]; });
        inserted.push({ dutch: c.dutch, english: c.english, line: M.csvLine(f2) });
      }
    });
    inserted.forEach(function (ins) { // put new rows where the sort order wants them
      var pos = lines.length;
      for (var j = 1; j < lines.length; j++) {
        var f3 = M.parseCSV(lines[j])[0];
        if (f3 && before(ins, { dutch: f3[col.dutch], english: f3[col.english] })) { pos = j; break; }
      }
      lines.splice(pos, 0, ins.line);
    });
    return { text: lines.join(nl) + (endsWithNl ? nl : ''), changed: changed + inserted.length, inserted: inserted.length };
  }

  // ---- which words to show, in a steady order (same order every visit, so batches resume) ----
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  var RANK = { A1: 0, A2: 1, '': 1.5, B1: 2, B2: 3, C1: 4, C2: 5 };

  /* words: [{dutch, english, level}], progress: Map key -> row, mode: 'unrated' | 'all' | 0..5 */
  function buildQueue(words, progress, mode, todayYmd) {
    var out = words.filter(function (w) {
      var lv = levelOf(progress.get(keyOf(w.dutch, w.english)), todayYmd);
      if (mode === 'all') return true;
      if (mode === 'unrated') return lv === null;
      return lv === Number(mode);
    });
    out.sort(function (a, b) {
      var ra = RANK[a.level || ''] === undefined ? 1.5 : RANK[a.level || ''], rb = RANK[b.level || ''] === undefined ? 1.5 : RANK[b.level || ''];
      return ra - rb || hash(keyOf(a.dutch, a.english)) - hash(keyOf(b.dutch, b.english));
    });
    return out;
  }

  return { LEVELS: LEVELS, SAVE_AS: SAVE_AS, addDays: addDays, daysBetween: daysBetween, fieldsFor: fieldsFor,
           levelOf: levelOf, keyOf: keyOf, patchProgress: patchProgress, buildQueue: buildQueue };
});

/* matcher.js: the "brain" of the Dutch reader. No screen, no network: it takes text and your
   word list and sorts the words into known / maybe-known / unknown.
   Works in the browser (window.Matcher) and in Node (for the tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Matcher = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRONOUNS_AUX = new Set(['ik', 'jij', 'je', 'u', 'hij', 'zij', 'ze', 'het', 'we', 'wij', 'jullie',
    'ben', 'bent', 'is', 'zijn', 'heb', 'hebt', 'heeft', 'hebben', 'hadden', 'had']);

  function norm(s) {
    return String(s).normalize('NFC').replace(/[‘’ʼ]/g, "'").toLowerCase();
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = [], row = [], field = '', inQ = false, i = 0, c;
    while (i < text.length) {
      c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function csvRecords(text) {
    var rows = parseCSV(text);
    if (!rows.length) return [];
    var head = rows[0], out = [];
    for (var r = 1; r < rows.length; r++) {
      if (rows[r].length === 1 && rows[r][0] === '') continue;
      var o = {};
      for (var c = 0; c < head.length; c++) o[head[c]] = rows[r][c] === undefined ? '' : rows[r][c];
      out.push(o);
    }
    return out;
  }
  function csvField(v) {
    v = String(v === undefined || v === null ? '' : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function csvLine(fields) { return fields.map(csvField).join(','); }

  // ---------- the word list ----------
  function stripArticle(s) { return s.replace(/^(de|het|een)\s+/, ''); }

  function singleTokens(s) { // words inside a phrase
    return (s.match(/'?\p{L}+(?:['-]\p{L}+)*/gu) || []).map(function (t) {
      return t.replace(/^'(?!s$|t$|n$)/, '');
    });
  }

  // alternatives written in one cell: "de doos / het doosje", "de rit (het ritje)", "ik zocht, we zochten"
  function entryAlternatives(dutch) {
    var s = norm(dutch), inner = [], outer;
    outer = s.replace(/\(([^)]*)\)/g, function (_, g) { inner.push(g); return ' '; });
    var parts = outer.split(/\s\/\s|\/|,|;/).concat(inner.join(',').split(/\s\/\s|\/|,|;/));
    var out = [];
    parts.forEach(function (p) {
      p = stripArticle(p.replace(/\s+/g, ' ').trim());
      if (p.length >= 2) out.push(p);
    });
    return out;
  }

  // rows: [{dutch, english, type}]
  function buildIndex(rows) {
    var known = new Map();    // word -> the list entry it came from
    var inPhrase = new Map(); // word -> a phrase it is part of
    var forms = new Map();    // word -> infinitive (from the verb drill rows)
    rows.forEach(function (r) {
      var shown = r.dutch;
      entryAlternatives(r.dutch).forEach(function (alt) {
        if (alt.indexOf(' ') < 0) { if (!known.has(alt)) known.set(alt, shown); }
        else singleTokens(alt).forEach(function (t) { if (t.length > 1 && !inPhrase.has(t)) inPhrase.set(t, shown); });
      });
      if (/^verb-/.test(r.type || '')) {
        var parts = norm(r.english || '').split(/(?:past|perfect):/).slice(1);   // text after "past:" and after "perfect:"
        parts.forEach(function (part) { part.split(/[,;]/).forEach(function (chunk) {
          singleTokens(chunk).forEach(function (t) {
            if (!PRONOUNS_AUX.has(t) && t.length > 1 && !forms.has(t)) forms.set(t, norm(r.dutch));
          });
        }); });
      }
    });
    return { known: known, inPhrase: inPhrase, forms: forms, size: rows.length };
  }

  // ---------- Dutch endings (guesses, only used when the guess is a word on your list) ----------
  var VOW = 'aeiou';
  function isV(ch) { return VOW.indexOf(ch) >= 0; }

  function lemmaCandidates(stem) {
    var c = [stem], n = stem.length, last = stem[n - 1], prev = stem[n - 2], pp = stem[n - 3];
    c.push(stem + 'en');
    if (last === 'z') c.push(stem.slice(0, -1) + 's');           // huiz-en -> huis
    if (last === 'v') c.push(stem.slice(0, -1) + 'f');           // briev-en -> brief
    if (last === 's') c.push(stem.slice(0, -1) + 'zen');         // reis -> reizen
    if (last === 'f') c.push(stem.slice(0, -1) + 'ven');         // leef -> leven
    if (n > 2 && last === prev && !isV(last)) {                  // mann -> man
      var u = stem.slice(0, -1);
      c.push(u); c.push(u + 'en');
    }
    if (n > 2 && !isV(last) && isV(prev) && !isV(pp)) {          // bom -> boom, kom -> komen
      c.push(stem.slice(0, -2) + prev + prev + last);
      c.push(stem + last + 'en');                                // stop -> stoppen
    }
    if (n > 3 && !isV(last) && prev === pp && isV(prev)) {       // loop -> lopen
      c.push(stem.slice(0, -2) + last + 'en');
      c.push(stem.slice(0, -2) + last);
    }
    if (last === 'i' || /ie$/.test(stem)) { c.push(stem + 'e'); }  // idee-en handled by stem; kopieer -> kopiëren below
    return c;
  }

  function stems(w) {
    var s = [], n = w.length;
    function add(x) { if (x && x.length >= 2) s.push(x); }
    if (/'s$/.test(w)) add(w.slice(0, -2));
    if (/ën$/.test(w)) add(w.slice(0, -2) + 'e');
    if (/en$/.test(w)) add(w.slice(0, -2));
    if (/(etje|tje|pje|kje|je)$/.test(w)) {
      add(w.replace(/etje$/, '')); add(w.replace(/(tje|pje|kje)$/, '')); add(w.replace(/je$/, ''));
    }
    if (/e$/.test(w)) add(w.slice(0, -1));
    if (/s$/.test(w)) add(w.slice(0, -1));
    if (/(er|st)$/.test(w)) add(w.slice(0, -2));
    if (/(ere|ste)$/.test(w)) add(w.slice(0, -3));
    if (/t$/.test(w)) add(w.slice(0, -1));
    if (/(te|de)$/.test(w)) add(w.slice(0, -2));
    if (/(ten|den)$/.test(w)) add(w.slice(0, -3));
    if (/^ge/.test(w) && n > 4) {
      var b = w.slice(2);
      if (/[td]$/.test(b)) add(b.slice(0, -1));
      if (/en$/.test(b)) { add(b); add(b.slice(0, -2)); }
    }
    return s;
  }

  function findLemma(w, index) {
    var st = stems(w);
    for (var i = 0; i < st.length; i++) {
      var cands = lemmaCandidates(st[i]);
      for (var j = 0; j < cands.length; j++) {
        if (cands[j] !== w && index.known.has(cands[j])) return cands[j];
      }
    }
    return null;
  }

  // ---------- reading a page of text ----------
  function splitSentences(text) {
    text = String(text).replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, '$1$2') // word split over two lines
      .replace(/\r/g, '').replace(/\n{2,}/g, '\u0001').replace(/\n/g, ' ');
    return text.split(/\u0001|(?<=[.!?…:])\s+/u).map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
  }

  function tokenise(sentence) {
    var re = /'?\p{L}+(?:'\p{L}+|-\p{L}+)*/gu, m, out = [];
    sentence = sentence.replace(/[‘’ʼ]/g, "'");
    while ((m = re.exec(sentence))) {
      var raw = m[0].replace(/^'(?!s$|t$|n$)/, '');
      if (raw) out.push(raw);
    }
    return out;
  }

  /* analyse(text, index, ignored) ->
       { total, known:[{word,count}], maybe:[{word,count,lemma,why,sentence}],
         unknown:[{word,count,sentence,maybeName}] }                                    */
  function analyse(text, index, ignored) {
    ignored = ignored || new Set();
    var seen = new Map(), total = 0;
    splitSentences(text).forEach(function (sentence) {
      tokenise(sentence).forEach(function (raw, i) {
        var w = norm(raw);
        total++;
        var e = seen.get(w);
        if (!e) {
          e = { word: w, count: 0, sentence: sentence.length > 220 ? sentence.slice(0, 217) + '...' : sentence,
                capMid: 0, lower: false };
          seen.set(w, e);
        }
        e.count++;
        var cap = raw.charAt(0) !== raw.charAt(0).toLowerCase() && raw !== raw.toUpperCase();
        if (cap && i > 0) e.capMid++;
        if (!cap) e.lower = true; // written in lower case at least once = an ordinary word, not a name
      });
    });
    var res = { total: total, known: [], maybe: [], unknown: [], ignoredCount: 0 };
    seen.forEach(function (e, w) {
      if (index.known.has(w)) { res.known.push({ word: w, count: e.count }); return; }
      if (ignored.has(w)) { res.ignoredCount++; return; }
      if (w.length < 2) return;
      var lemma = findLemma(w, index), why = null;
      if (lemma) why = 'maybe a form of ' + lemma;
      else if (index.forms.has(w)) { lemma = index.forms.get(w); why = 'form of the verb ' + lemma; }
      else if (index.inPhrase.has(w)) { lemma = index.inPhrase.get(w); why = 'part of "' + lemma + '"'; }
      if (why) { res.maybe.push({ word: w, count: e.count, lemma: lemma, why: why, sentence: e.sentence }); return; }
      res.unknown.push({ word: w, count: e.count, sentence: e.sentence,
        maybeName: !e.lower && e.capMid > 0 });
    });
    var byCount = function (a, b) { return b.count - a.count || (a.word < b.word ? -1 : 1); };
    res.known.sort(byCount); res.maybe.sort(byCount); res.unknown.sort(byCount);
    return res;
  }

  return { norm: norm, parseCSV: parseCSV, csvRecords: csvRecords, csvLine: csvLine, buildIndex: buildIndex,
           entryAlternatives: entryAlternatives, findLemma: findLemma, splitSentences: splitSentences,
           tokenise: tokenise, analyse: analyse };
});

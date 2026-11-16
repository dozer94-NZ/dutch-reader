/* game.js: the rules of the games (points, weekly leaderboard, word of the week, battles).
   No screen, no network, so it can be tested on its own.
   Points only come from quiz answers that the app marks itself (multiple choice), never from the 0-5 self-rating. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./matcher.js'), require('./triage.js'));
  else root.Game = factory(root.Matcher, root.Triage);
})(typeof self !== 'undefined' ? self : this, function (M, T) {
  'use strict';

  var BASE = [15, 12, 10, 8, 6, 5];   // points for a right answer, by how well the person knows the word (0..5)
  var FLAT = 10;                      // battles: every right answer is worth the same, so it is fair
  var WOTW_BONUS = 30, PERFECT_BONUS = 20, STREAK_PER_DAY = 3, STREAK_MAX_DAYS = 10, ROUND = 10;

  // ---- steady random numbers: the same seed gives the same words and options on every phone ----
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    var a = hash(seed);
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, r) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---- weeks run Monday to Sunday ----
  function weekStart(ymd) {
    var p = ymd.split('-').map(Number), dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return T.addDays(ymd, -((dow + 6) % 7));
  }

  // ---- points ----
  function speedBonus(ms) { return ms <= 3000 ? 5 : (ms <= 6000 ? 2 : 0); }
  function questionPoints(level, ms, flat) { return (flat ? FLAT : BASE[level == null ? 0 : level]) + speedBonus(ms); }

  // consecutive days ending today (or yesterday, if today has no round yet)
  function streakDays(dates, today) {
    var set = new Set(dates), d = set.has(today) ? today : T.addDays(today, -1), n = 0;
    while (set.has(d)) { n++; d = T.addDays(d, -1); }
    return n;
  }

  /* answers: [{ok, pts}] (pts already worked out per question). opts: {flat, wotwHit, newDay, streak}
     Battles (flat) get no bonuses, so both players are scored the same way. */
  function scoreRound(answers, opts) {
    var q = 0, right = 0;
    answers.forEach(function (a) { if (a.ok) { q += a.pts; right++; } });
    var parts = { questions: q, perfect: 0, wotw: 0, streak: 0 };
    if (!opts.flat) {
      if (answers.length >= 5 && right === answers.length) parts.perfect = PERFECT_BONUS;
      if (opts.wotwHit) parts.wotw = WOTW_BONUS;
      if (opts.newDay) parts.streak = Math.min(opts.streak || 0, STREAK_MAX_DAYS) * STREAK_PER_DAY;
    }
    return { points: parts.questions + parts.perfect + parts.wotw + parts.streak, right: right, total: answers.length, parts: parts };
  }

  // ---- what an answer does to the progress row: the Cobra phone's own rules (progress_record) ----
  // One difference: a right answer never brings the due date closer (so a word rated 5 stays at 5).
  function applyAnswer(row, ok, ymd) {
    var right = parseInt((row && row.right) || '0', 10) || 0, wrong = parseInt((row && row.wrong) || '0', 10) || 0,
        streak = parseInt((row && row.streak) || '0', 10) || 0, status, days;
    if (ok) {
      right++; streak++;
      if (streak >= 5) { status = 'known'; days = 30; } else if (streak >= 3) { status = 'known'; days = 14; } else { status = 'learning'; days = 2; }
    } else { wrong++; streak = 0; status = 'needs_practice'; days = 0; }
    var due = T.addDays(ymd, days), old = (row && row.next_due) || '', oldSt = (row && row.status) || '';
    if (ok && old > due && (oldSt === 'known' || oldSt === 'learning')) due = old;
    return { status: status, right: String(right), wrong: String(wrong), streak: String(streak), last_practised: ymd, next_due: due };
  }

  // ---- questions: Dutch word, four English meanings to choose from ----
  function makeQuestions(chosen, pool, seed) {
    return chosen.map(function (w) {
      var r = rng(seed + '|' + T.keyOf(w.dutch, w.english)), mine = M.norm(w.english), seen = new Set([mine]);
      var cands = pool.filter(function (p) {
        var e = M.norm(p.english);
        if (seen.has(e) || (p.type || 'word') !== (w.type || 'word')) return false;
        seen.add(e); return true;
      });
      var pick = shuffle(cands, r).slice(0, 30).sort(function (a, b) {
        return Math.abs(a.english.length - w.english.length) - Math.abs(b.english.length - w.english.length);
      }).slice(0, 3).map(function (p) { return p.english; });
      return { d: w.dutch, e: w.english, o: shuffle([w.english].concat(pick), r) };
    });
  }

  // ---- which words to ask ----
  function priority(w, row, today) {
    var st = (row && row.status) || 'unknown', due = (row && row.next_due) || '';
    if (st === 'needs_practice') return 0;
    if (st === 'learning') return due <= today ? 1 : 7;
    if (st === 'unknown') return due ? 2 : (w.level === 'A1' ? 3 : (w.level === 'A2' ? 4 : 6));
    if (st === 'known') return due <= today ? 5 : 7;
    return 7;
  }
  // a practice round: words you got wrong, then words due, then words you rated 0, then new A1/A2 words
  function pickPractice(words, progress, today, seed, n) {
    var r = rng(seed);
    return words.map(function (w) { return { w: w, p: priority(w, progress.get(T.keyOf(w.dutch, w.english)), today), x: r() }; })
      .sort(function (a, b) { return a.p - b.p || a.x - b.x; }).slice(0, n || ROUND).map(function (o) { return o.w; });
  }
  function isEasy(w) { return w.level === 'A1' || w.level === 'A2'; }
  function pickNormal(words, seed, n) {
    var pool = words.filter(function (w) { return isEasy(w) && (w.type || 'word') === 'word'; });
    if (pool.length < (n || ROUND)) pool = words;
    return shuffle(pool, rng(seed)).slice(0, n || ROUND);
  }
  // handicap: words that NEITHER person knows yet, so the stronger player has no head start
  function pickHandicap(words, progA, progB, today, seed, n) {
    var r = rng(seed), RANK = { A1: 0, A2: 1 };
    function lv(p, w) { var l = T.levelOf(p.get(T.keyOf(w.dutch, w.english)), today); return l === null ? 0 : l; }
    return words.filter(function (w) { return (w.type || 'word') === 'word'; }).map(function (w) {
      return { w: w, weak: Math.max(lv(progA, w), lv(progB, w)), rank: RANK[w.level] === undefined ? 2 : RANK[w.level], x: r() };
    }).sort(function (a, b) { return a.weak - b.weak || a.rank - b.rank || a.x - b.x; }).slice(0, n || ROUND).map(function (o) { return o.w; });
  }
  // the word of the week: the same for everyone, an easy word, changes every Monday
  function wordOfWeek(words, weekYmd) {
    var pool = words.filter(function (w) { return isEasy(w) && (w.type || 'word') === 'word'; });
    if (!pool.length) pool = words;
    var best = null, bh = 0;
    pool.forEach(function (w) { var h = hash(T.keyOf(w.dutch, w.english) + '|' + weekYmd); if (best === null || h < bh) { best = w; bh = h; } });
    return best;
  }

  // ---- leaderboard: rows are {date, who, points, right, total} ----
  function leaderboard(rows, weekYmd) {
    var by = {};
    rows.forEach(function (r) {
      if (weekYmd && weekStart(r.date) !== weekYmd) return;
      var o = by[r.who] || (by[r.who] = { who: r.who, points: 0, rounds: 0, right: 0, total: 0 });
      o.points += parseInt(r.points, 10) || 0; o.rounds++; o.right += parseInt(r.right, 10) || 0; o.total += parseInt(r.total, 10) || 0;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.points - a.points || (a.who < b.who ? -1 : 1); });
  }

  // ---- battles: rows are {id, type: challenge|reply, date, who, opponent, mode, score, right, total, questions} ----
  function num(x) { return parseInt(x, 10) || 0; }
  function battleStates(rows) {
    var by = {}, order = [];
    rows.forEach(function (r) {
      if (r.type === 'challenge' && !by[r.id]) { by[r.id] = { id: r.id, date: r.date, mode: r.mode, a: r.who, b: r.opponent, aScore: num(r.score), aRight: num(r.right), aTotal: num(r.total), questions: r.questions, done: false, winner: null }; order.push(r.id); }
    });
    rows.forEach(function (r) {
      var s = by[r.id];
      if (r.type === 'reply' && s && !s.done && r.who === s.b) {
        s.done = true; s.bScore = num(r.score); s.bRight = num(r.right); s.bTotal = num(r.total);
        s.winner = s.aScore !== s.bScore ? (s.aScore > s.bScore ? s.a : s.b) : (s.aRight !== s.bRight ? (s.aRight > s.bRight ? s.a : s.b) : 'draw');
      }
    });
    return order.map(function (id) { return by[id]; });
  }
  function battleWins(states) {
    var w = {};
    states.forEach(function (s) { if (s.done && s.winner && s.winner !== 'draw') w[s.winner] = (w[s.winner] || 0) + 1; });
    return w;
  }

  return { ROUND: ROUND, BASE: BASE, FLAT: FLAT, WOTW_BONUS: WOTW_BONUS, PERFECT_BONUS: PERFECT_BONUS, hash: hash, rng: rng, shuffle: shuffle,
           weekStart: weekStart, speedBonus: speedBonus, questionPoints: questionPoints, streakDays: streakDays, scoreRound: scoreRound,
           applyAnswer: applyAnswer, makeQuestions: makeQuestions, pickPractice: pickPractice, pickNormal: pickNormal,
           pickHandicap: pickHandicap, wordOfWeek: wordOfWeek, leaderboard: leaderboard, battleStates: battleStates, battleWins: battleWins };
});

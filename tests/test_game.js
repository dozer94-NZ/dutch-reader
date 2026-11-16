// node tests/test_game.js <learning-progress/dutch folder>
const fs = require('fs'), path = require('path');
const M = require('../matcher.js'), T = require('../triage.js'), G = require('../game.js');
const dataDir = process.argv[2];
let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok   ' : 'FAIL ', m); if (!c) fails++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + (JSON.stringify(a) === JSON.stringify(b) ? '' : ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)));

const words = M.csvRecords(fs.readFileSync(path.join(dataDir, 'vocab/dutch-vocab.csv'), 'utf8')).filter(r => r.dutch && r.english)
  .map(r => ({ dutch: r.dutch, english: r.english, level: r.level || '', type: r.type || 'word' }));
const prog = txt => { const m = new Map(); M.csvRecords(txt).forEach(r => m.set(T.keyOf(r.dutch, r.english), r)); return m; };
const noah = prog(fs.readFileSync(path.join(dataDir, 'noah.csv'), 'utf8')), anna = prog(fs.readFileSync(path.join(dataDir, 'anna.csv'), 'utf8'));
const TODAY = '2026-11-18'; // a Wednesday

// weeks
eq(G.weekStart('2026-11-16'), '2026-11-16', 'Monday starts its own week');
eq(G.weekStart('2026-11-22'), '2026-11-16', 'Sunday belongs to the week that started Monday');
eq(G.weekStart('2026-11-23'), '2026-11-23', 'next Monday starts a new week');
eq(G.weekStart('2026-01-01'), '2025-12-29', 'week across new year');

// points
eq(G.questionPoints(0, 2000, false), 20, 'new word, fast = 15 + 5');
eq(G.questionPoints(5, 9000, false), 5, 'known word, slow = 5');
eq(G.questionPoints(3, 5000, false), 10, 'familiar word, medium = 8 + 2');
eq(G.questionPoints(5, 1000, true), 15, 'battles are flat: 10 + 5 whatever the level');
eq(G.questionPoints(null, 9000, false), 15, 'unrated counts as new');
ok(G.BASE[0] > G.BASE[1] && G.BASE[1] > G.BASE[2] && G.BASE[4] > G.BASE[5] - 1, 'weaker words pay more');

// streaks
eq(G.streakDays(['2026-11-18', '2026-11-17', '2026-11-16'], TODAY), 3, 'three days in a row');
eq(G.streakDays(['2026-11-17', '2026-11-16'], TODAY), 2, 'today not played yet: still counts yesterday');
eq(G.streakDays(['2026-11-18', '2026-11-16'], TODAY), 1, 'a gap breaks it');
eq(G.streakDays([], TODAY), 0, 'no days');

// round score
const A = (ok, pts) => ({ ok, pts });
let s = G.scoreRound([A(true, 10), A(false, 0), A(true, 20)], { flat: false, newDay: true, streak: 2 });
eq([s.points, s.right, s.total], [36, 2, 3], 'round: 30 questions + streak 2*3');
s = G.scoreRound(Array(10).fill(A(true, 10)), { flat: false, newDay: false, wotwHit: true, streak: 5 });
eq(s.points, 100 + 20 + 30, 'perfect round + word of the week, no streak bonus twice a day');
s = G.scoreRound(Array(10).fill(A(true, 10)), { flat: true, newDay: true, wotwHit: true, streak: 9 });
eq(s.points, 100, 'battle: no bonuses at all');
s = G.scoreRound(Array(3).fill(A(true, 10)), { flat: false });
eq(s.parts.perfect, 0, 'a perfect tiny round is not a bonus');
s = G.scoreRound([A(true, 10)], { flat: false, newDay: true, streak: 40 });
eq(s.parts.streak, 30, 'streak bonus stops at 10 days');

// answers change progress by the phone's rules
let f = G.applyAnswer({ right: '0', wrong: '0', streak: '0', status: 'unknown', next_due: '' }, true, TODAY);
eq(f, { status: 'learning', right: '1', wrong: '0', streak: '1', last_practised: TODAY, next_due: '2026-11-20' }, 'first right answer: learning, +2 days');
f = G.applyAnswer({ right: '2', wrong: '1', streak: '2', status: 'learning', next_due: '2026-11-19' }, true, TODAY);
eq([f.status, f.streak, f.next_due], ['known', '3', '2026-12-02'], 'third in a row: known, +14 days');
f = G.applyAnswer({ right: '9', wrong: '0', streak: '4', status: 'known', next_due: '2026-12-01' }, true, TODAY);
eq([f.status, f.streak, f.next_due], ['known', '5', '2026-12-18'], 'fifth in a row: known, +30 days');
f = G.applyAnswer({ right: '5', wrong: '0', streak: '5', status: 'known', next_due: T.addDays(TODAY, 365) }, true, TODAY);
eq(T.levelOf({ status: f.status, streak: f.streak, next_due: f.next_due }, TODAY), 5, 'a word rated 5 stays at 5 after a right answer');
f = G.applyAnswer({ right: '5', wrong: '0', streak: '5', status: 'known', next_due: T.addDays(TODAY, 365) }, false, TODAY);
eq([f.status, f.streak, f.wrong, f.next_due], ['needs_practice', '0', '1', TODAY], 'wrong answer: needs practice, due today (even a 5)');
f = G.applyAnswer(undefined, true, TODAY);
eq([f.right, f.wrong, f.status], ['1', '0', 'learning'], 'works on a word with no row');

// questions
const chosen = G.pickNormal(words, 'seed1', 10);
eq(chosen.length, 10, 'ten words');
ok(chosen.every(w => (w.level === 'A1' || w.level === 'A2') && w.type === 'word'), 'normal battle words are easy single words');
eq(G.pickNormal(words, 'seed1', 10), chosen, 'same seed, same words');
ok(JSON.stringify(G.pickNormal(words, 'seed2', 10)) !== JSON.stringify(chosen), 'different seed, different words');
const qs = G.makeQuestions(chosen, words, 'seed1');
ok(qs.every(q => q.o.length === 4 && q.o.includes(q.e) && new Set(q.o.map(M.norm)).size === 4), 'four different options, one is right');
eq(G.makeQuestions(chosen, words, 'seed1'), qs, 'same seed, same questions and option order (both players see the same)');
ok(qs.every(q => q.o.filter(o => o === q.e).length === 1), 'the right answer appears once');
ok(new Set(qs.map(q => q.o.indexOf(q.e))).size > 1, 'the right answer is not always in the same place');
const tiny = G.makeQuestions([words[0]], [words[0], words[1]], 'x');
ok(tiny[0].o.length === 2 && tiny[0].o.includes(words[0].english), 'a tiny pool still works');

// practice picks: wrong first, then due, then rated 0, then new easy words
const mini = [
  { dutch: 'a', english: 'ea', level: 'A1', type: 'word' }, { dutch: 'b', english: 'eb', level: 'A1', type: 'word' },
  { dutch: 'c', english: 'ec', level: 'A1', type: 'word' }, { dutch: 'd', english: 'ed', level: 'B2', type: 'word' },
  { dutch: 'e', english: 'ee', level: 'A1', type: 'word' }, { dutch: 'f', english: 'ef', level: 'A1', type: 'word' }];
const mp = new Map([
  [T.keyOf('a', 'ea'), { status: 'known', next_due: '2027-01-01' }],
  [T.keyOf('b', 'eb'), { status: 'needs_practice', next_due: TODAY }],
  [T.keyOf('c', 'ec'), { status: 'learning', next_due: '2026-11-01' }],
  [T.keyOf('d', 'ed'), { status: 'unknown', next_due: '2026-11-10' }],
  [T.keyOf('f', 'ef'), { status: 'learning', next_due: '2027-01-01' }]]);
eq(G.pickPractice(mini, mp, TODAY, 's', 4).map(w => w.dutch), ['b', 'c', 'd', 'e'], 'practice order: wrong, due, rated 0, new easy');
eq(G.pickPractice(mini, mp, TODAY, 's', 6).length, 6, 'fills up with words that are not due when little is due');

// handicap: neither knows the word
const pa = new Map(), pb = new Map();
const hw = G.pickHandicap(words, noah, anna, TODAY, 'h1', 10);
ok(hw.length === 10 && hw.every(w => Math.max(T.levelOf(noah.get(T.keyOf(w.dutch, w.english)), TODAY) || 0, T.levelOf(anna.get(T.keyOf(w.dutch, w.english)), TODAY) || 0) === 0), 'handicap words are rated 0 or unrated by both (real files)');
ok(hw.every(w => w.level === 'A1'), 'and easy first');
const withKnown = new Map(noah); const k0 = hw[0]; withKnown.set(T.keyOf(k0.dutch, k0.english), { status: 'known', streak: '5', next_due: T.addDays(TODAY, 365) });
ok(!G.pickHandicap(words, withKnown, anna, TODAY, 'h1', 10).some(w => w === k0), 'a word one player knows well is left out');
eq(G.pickHandicap(words, noah, anna, TODAY, 'h1', 10), hw, 'same seed, same handicap words');

// word of the week
const w1 = G.wordOfWeek(words, '2026-11-16'), w2 = G.wordOfWeek(words, '2026-11-23');
eq(G.wordOfWeek(words, '2026-11-16'), w1, 'word of the week is stable within a week');
ok(w1 && (w1.level === 'A1' || w1.level === 'A2') && w1.type === 'word', 'an easy single word: ' + w1.dutch);
ok(w1 !== w2, 'it changes the next week (' + w1.dutch + ' then ' + w2.dutch + ')');

// leaderboard
const rows = [
  { date: '2026-11-16', who: 'Noah', points: '120', right: '8', total: '10' },
  { date: '2026-11-18', who: 'Noah', points: '60', right: '5', total: '10' },
  { date: '2026-11-17', who: 'Anna', points: '200', right: '9', total: '10' },
  { date: '2026-11-15', who: 'Anna', points: '500', right: '10', total: '10' },     // last Sunday: last week
  { date: '2026-11-22', who: 'Sam', points: '10', right: '1', total: '10' }];
const lb = G.leaderboard(rows, '2026-11-16');
eq(lb.map(o => o.who + ':' + o.points + ':' + o.rounds), ['Anna:200:1', 'Noah:180:2', 'Sam:10:1'], 'this week, ranked, Sunday included');
eq(G.leaderboard(rows, '2026-11-09').map(o => o.who + ':' + o.points), ['Anna:500'], 'last week');
eq(G.leaderboard(rows).map(o => o.who + ':' + o.points), ['Anna:700', 'Noah:180', 'Sam:10'], 'all time');
eq(G.leaderboard([{ date: '2026-11-16', who: 'B', points: '5' }, { date: '2026-11-16', who: 'A', points: '5' }], '2026-11-16').map(o => o.who), ['A', 'B'], 'ties are sorted by name');

// battles
const B = (id, type, who, opp, score, right) => ({ id, type, date: '2026-11-18', who, opponent: opp, mode: 'normal', score: String(score), right: String(right), total: '10', questions: type === 'challenge' ? '[]' : '' });
const st = G.battleStates([B('b1', 'challenge', 'Noah', 'Anna', 90, 7), B('b1', 'reply', 'Anna', 'Noah', 110, 8),
  B('b2', 'challenge', 'Anna', 'Noah', 80, 8), B('b3', 'challenge', 'Noah', 'Sam', 70, 7), B('b3', 'reply', 'Sam', 'Noah', 70, 7),
  B('b4', 'challenge', 'Noah', 'Anna', 100, 8), B('b4', 'reply', 'Sam', 'Noah', 999, 10),     // wrong person replies: ignored
  B('b5', 'challenge', 'Noah', 'Anna', 90, 8), B('b5', 'reply', 'Anna', 'Noah', 90, 9),
  B('b6', 'reply', 'Anna', 'Noah', 5, 5)]);                                                    // reply with no challenge: ignored
eq(st.map(s => s.id + ':' + s.done + ':' + s.winner), ['b1:true:Anna', 'b2:false:null', 'b3:true:draw', 'b4:false:null', 'b5:true:Anna'], 'battle winners, open battles, draws, strangers ignored');
eq(G.battleWins(st), { Anna: 2 }, 'win tally ignores draws');
eq(G.battleStates([B('b1', 'challenge', 'Noah', 'Anna', 90, 7), B('b1', 'reply', 'Anna', 'Noah', 50, 4), B('b1', 'reply', 'Anna', 'Noah', 500, 9)])[0].winner, 'Noah', 'only the first reply counts');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);

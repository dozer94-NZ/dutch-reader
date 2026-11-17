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
ok(hw.every(w => w.level === 'A1' || w.level === 'A2'), 'and easy (A1, A2) first');
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

// Type it
const R = (w, x, dir, pool) => G.checkTyped(w, x, dir, pool).result;
const dak = { dutch: 'het dak', english: 'roof' }, plan = { dutch: 'de plattegrond', english: 'floor plan, map' }, bouwen = { dutch: 'bouwen', english: 'to build' }, cafe = { dutch: 'het café', english: 'café, pub' };
eq([R(dak, 'dak', 'en2nl'), R(dak, 'Het Dak', 'en2nl'), R(dak, '  het   dak ', 'en2nl'), R(dak, 'de dak', 'en2nl'), R(dak, 'dok', 'en2nl'), R(dak, 'huis', 'en2nl')], ['right', 'right', 'right', 'almost', 'wrong', 'wrong'], 'English to Dutch: article optional, wrong article = almost, 3-letter word needs to be exact');
eq([R(plan, 'plattegrond', 'en2nl'), R(plan, 'plattegrnod', 'en2nl'), R(plan, 'plattegrondd', 'en2nl'), R(plan, 'plattegrnd', 'en2nl'), R(plan, 'platte', 'en2nl')], ['right', 'almost', 'almost', 'almost', 'wrong'], 'one letter off (also swapped letters) = almost; more = wrong');
eq([R(plan, 'map', 'nl2en'), R(plan, 'The floor plan', 'nl2en'), R(plan, 'floor pln', 'nl2en'), R(plan, 'plan', 'nl2en')], ['right', 'right', 'almost', 'wrong'], 'Dutch to English: any listed meaning counts, "the" ignored');
eq([R(bouwen, 'build', 'nl2en'), R(bouwen, 'to build', 'nl2en'), R(bouwen, 'To Build', 'nl2en'), R(bouwen, 'biuld', 'nl2en'), R(bouwen, 'destroy', 'nl2en')], ['right', 'right', 'right', 'almost', 'wrong'], '"to" is optional on verbs');
eq([R(cafe, 'cafe', 'en2nl'), R(cafe, 'Pub', 'nl2en'), R(cafe, "café", 'nl2en')], ['right', 'right', 'right'], 'accents and capitals are ignored');
eq(R({ dutch: "'s avonds", english: 'in the evening' }, 's avonds', 'en2nl'), 'right', 'apostrophes and punctuation are ignored');
eq(R(dak, '', 'en2nl'), 'empty', 'empty answer');
const pool = [dak, { dutch: 'de verdieping', english: 'floor, storey' }, { dutch: 'de vloer', english: 'floor' }];
eq(R(pool[2], 'verdieping', 'en2nl', pool), 'almost', 'another word with the same meaning is "almost", not wrong');
eq(R(pool[2], 'dak', 'en2nl', pool), 'wrong', 'a word with a different meaning is wrong');
eq([G.typedPoints(0, 20000), G.typedPoints(0, 5000), G.typedPoints(2, 10000), G.typedPoints(5, 1000)], [30, 35, 22, 15], 'typed answers pay double the base, plus a speed bonus');
const tq = G.makeTypeQuestions(Array.from({ length: 40 }, (_, i) => ({ dutch: 'w' + i, english: 'e' + i })), 'mixed', 'seed');
eq([tq.every(q => q.t === 1), tq.some(q => q.dir === 'en2nl'), tq.some(q => q.dir === 'nl2en'), JSON.stringify(tq) === JSON.stringify(G.makeTypeQuestions(Array.from({ length: 40 }, (_, i) => ({ dutch: 'w' + i, english: 'e' + i })), 'mixed', 'seed'))], [true, true, true, true], 'mixed uses both directions and the same seed gives the same questions');
eq(G.makeTypeQuestions([{ dutch: 'a', english: 'b' }], 'nl2en', 's')[0].dir, 'nl2en', 'a chosen direction is kept');
// words of a switched-on topic pack are picked early
const pw = [{ dutch: 'x1', english: 'a', level: 'B1' }, { dutch: 'x2', english: 'b', level: 'B1', inPack: true }, { dutch: 'x3', english: 'c', level: 'B1' }];
eq(G.pickPractice(pw, new Map(), '2026-11-17', 's', 1)[0].dutch, 'x2', 'a new word from a switched-on pack is asked before other new B1 words');

// Wagers: open challenges and ledger rows
{
  const ch = { id: 'b1', type: 'challenge', date: '2026-11-17', who: 'Noah', opponent: '*', mode: 'normal', score: '120', right: '10', total: '10', questions: '[]' };
  const rp = (who, score) => ({ id: 'b1', type: 'reply', date: '2026-11-17', who, opponent: 'Noah', mode: 'normal', score: String(score), right: '5', total: '10', questions: '' });
  let st = G.battleStates([ch])[0];
  eq([st.done, st.b], [false, '*'], 'an open challenge waits for anyone');
  st = G.battleStates([ch, rp('Noah', 130)])[0];
  eq(st.done, false, 'the challenger cannot answer their own open challenge');
  st = G.battleStates([ch, rp('Anna', 90), rp('Sam', 200)])[0];
  eq([st.done, st.b, st.winner, st.bScore], [true, 'Anna', 'Noah', 90], 'the first person to play takes it; later replies are ignored');
  st = G.battleStates([{ ...ch, opponent: 'Anna' }, rp('Sam', 10)])[0];
  eq(st.done, false, 'a named challenge still only accepts the named person');
  const lb = G.leaderboard([{ who: 'Noah', date: '2026-11-17', mode: 'practice', points: '100', right: '10', total: '10' }, { who: 'Noah', date: '2026-11-17', mode: 'wager', points: '-40', right: '0', total: '0' }, { who: 'Noah', date: '2026-11-17', mode: 'wager-win', points: '80', right: '0', total: '0' }], null)[0];
  eq([lb.points, lb.rounds, lb.total], [140, 1, 10], 'wager rows move points but are not rounds');
}

// battles: the clock pays the seconds left
eq([G.battlePoints(0), G.battlePoints(999), G.battlePoints(1000), G.battlePoints(4500), G.battlePoints(9000), G.battlePoints(9999), G.battlePoints(10000), G.battlePoints(25000)], [10, 10, 9, 6, 1, 1, 0, 0], 'a right answer pays 10 in the first second down to 1 in the last; 10 seconds is too late');
eq(G.BATTLE_SECONDS, 10, 'ten seconds a question');

// best of 3 races
const rIdx = [0,0,0,0,0,1,1,1,1,1,2,2,2,2,2];
let b3 = G.bestOf3([10,10,10,10,10, 1,1,1,1,1, 5,5,5,5,5], [1,1,1,1,1, 10,10,10,10,10, 9,9,9,9,9], rIdx);
eq([b3.aWins, b3.bWins, b3.winner], [1, 2, 'b'], 'two races out of three wins');
b3 = G.bestOf3([10,10,10,10,10, 9,9,9,9,9, 5,5,5,5,5], [1,1,1,1,1, 1,1,1,1,1], rIdx);
eq([b3.aWins, b3.bWins, b3.winner, b3.races[2].done], [2, 0, 'a', undefined], '2 - 0 after two races: race 3 not played and not counted');
b3 = G.bestOf3([10,10,10,10,10, 5,5,5,5,5, 5,5,5,5,5], [5,5,5,5,6, 10,10,10,10,10, 5,5,5,5,5], rIdx);
eq([b3.aWins, b3.bWins, b3.winner], [1, 1, 'b'], 'level on races (one tied): more points overall wins');
b3 = G.bestOf3([5,5,5,5,5, 5,5,5,5,5, 5,5,5,5,5], [5,5,5,5,5, 5,5,5,5,5, 5,5,5,5,5], rIdx);
eq(b3.winner, 'draw', 'all equal: a draw (money back)');
const q15 = JSON.stringify(rIdx.map((r, i) => ({ d: 'w' + i, e: 'x', r: r, p: 10 })));
let bs = G.battleStates([{ id: 'b9', type: 'challenge', who: 'Noah', opponent: '*', score: '150', right: '15', total: '15', questions: q15 },
  { id: 'b9', type: 'start', who: 'Anna' }, { id: 'b9', type: 'reply', who: 'Sam', score: '150', questions: JSON.stringify({ p: rIdx.map(() => 10) }) }])[0];
eq([bs.startedBy, bs.b, bs.done], ['Anna', 'Anna', false], 'starting an open challenge claims it: someone else\'s reply no longer counts');
bs = G.battleStates([{ id: 'b9', type: 'challenge', who: 'Noah', opponent: 'Anna', score: '150', right: '15', total: '15', questions: q15 },
  { id: 'b9', type: 'start', who: 'Anna' }, { id: 'b9', type: 'reply', who: 'Anna', score: '30', questions: JSON.stringify({ p: [10,10,10], forfeit: true }) }])[0];
eq([bs.done, bs.forfeit, bs.winner], [true, true, 'Noah'], 'a forfeit reply hands the win to the challenger');
bs = G.battleStates([{ id: 'b9', type: 'challenge', who: 'Noah', opponent: 'Anna', score: '150', right: '15', total: '15', questions: q15 },
  { id: 'b9', type: 'reply', who: 'Anna', score: '100', questions: JSON.stringify({ p: rIdx.map((r) => r === 0 ? 10 : 10) }) }])[0];
eq([bs.winner, bs.bo3.aWins, bs.bo3.bWins], ['draw', 0, 0], 'best of 3 decided from the per-question points, not the score column');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);

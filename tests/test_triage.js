// Run: node tests/test_triage.js [path/to/learning-progress/dutch]
const assert = require('assert'), fs = require('fs'), path = require('path');
const M = require('../matcher.js'), T = require('../triage.js');
let fails = 0;
function t(name, fn) { try { fn(); console.log('ok   ', name); } catch (e) { fails++; console.log('FAIL ', name, '\n     ', e.message); } }

const HEAD = 'dutch,english,status,right,wrong,streak,last_practised,next_due,pronunciation';
const sample = [HEAD, "'s avonds,in the evening,unknown,0,0,0,,,", 'appel,apple,known,6,1,5,2026-11-10,2026-12-10,good',
  '"a, b",comma word,learning,2,0,1,2026-11-12,2026-11-14,', 'zon,sun,unknown,0,0,0,,,'].join('\n') + '\n';

t('levels save as phone-friendly statuses', () => {
  assert.deepStrictEqual(T.fieldsFor(0, '2026-11-16'), { status: 'unknown', streak: '0', next_due: '2026-11-16' });
  assert.deepStrictEqual(T.fieldsFor(1, '2026-11-16'), { status: 'needs_practice', streak: '0', next_due: '2026-11-16' });
  assert.deepStrictEqual(T.fieldsFor(2, '2026-11-16'), { status: 'learning', streak: '1', next_due: '2026-11-18' });
  assert.deepStrictEqual(T.fieldsFor(3, '2026-11-16'), { status: 'learning', streak: '2', next_due: '2026-11-23' });
  assert.deepStrictEqual(T.fieldsFor(4, '2026-11-16'), { status: 'known', streak: '3', next_due: '2027-01-15' });
  assert.deepStrictEqual(T.fieldsFor(5, '2026-11-16'), { status: 'known', streak: '5', next_due: '2027-11-16' });
});
t('month/year rollover and leap day', () => { assert.strictEqual(T.addDays('2026-12-31', 1), '2027-01-01'); assert.strictEqual(T.addDays('2028-02-28', 1), '2028-02-29'); });
t('levelOf reads each level back', () => {
  const today = '2026-11-16';
  assert.strictEqual(T.levelOf({ status: 'unknown', next_due: '' }, today), null);
  assert.strictEqual(T.levelOf(undefined, today), null);
  for (let n = 0; n <= 5; n++) {
    const f = T.fieldsFor(n, today);
    assert.strictEqual(T.levelOf({ status: f.status, streak: f.streak, next_due: f.next_due }, today), n, 'level ' + n);
  }
});
t('patch: only the rated lines change, byte for byte elsewhere', () => {
  const r = T.patchProgress(sample, [{ dutch: 'zon', english: 'sun', fields: T.fieldsFor(5, '2026-11-16') }]);
  const a = sample.split('\n'), b = r.text.split('\n');
  assert.strictEqual(r.changed, 1); assert.strictEqual(a.length, b.length);
  a.forEach((l, i) => { if (!l.startsWith('zon,')) assert.strictEqual(b[i], l); });
  assert.strictEqual(b[4], 'zon,sun,known,0,0,5,,2027-11-16,');
});
t('patch keeps right/wrong/last_practised/pronunciation and handles quoted rows', () => {
  const r = T.patchProgress(sample, [{ dutch: 'a, b', english: 'comma word', fields: T.fieldsFor(1, '2026-11-16') }, { dutch: 'appel', english: 'apple', fields: T.fieldsFor(3, '2026-11-16') }]);
  const l = r.text.split('\n');
  assert.strictEqual(l[3], '"a, b",comma word,needs_practice,2,0,0,2026-11-12,2026-11-16,');
  assert.strictEqual(l[2], 'appel,apple,learning,6,1,2,2026-11-10,2026-11-23,good');
});
t('patch: same rating twice makes no change', () => {
  const ch = [{ dutch: 'zon', english: 'sun', fields: T.fieldsFor(5, '2026-11-16') }];
  const once = T.patchProgress(sample, ch).text;
  assert.strictEqual(T.patchProgress(once, ch).changed, 0);
});
t('patch: a missing word is inserted in sorted place', () => {
  const r = T.patchProgress(sample, [{ dutch: 'boom', english: 'tree', fields: T.fieldsFor(2, '2026-11-16') }]);
  const l = r.text.split('\n');
  assert.strictEqual(r.inserted, 1); assert.strictEqual(l[l.indexOf('zon,sun,unknown,0,0,0,,,') - 1], 'boom,tree,learning,0,0,1,,2026-11-18,');
});
t('patch keeps CRLF and a missing final newline', () => {
  const crlf = sample.replace(/\n/g, '\r\n'), r = T.patchProgress(crlf, [{ dutch: 'zon', english: 'sun', fields: T.fieldsFor(4, '2026-11-16') }]);
  assert(r.text.includes('\r\n') && !/[^\r]\n/.test(r.text));
  const noEnd = T.patchProgress(sample.trimEnd(), [{ dutch: 'zon', english: 'sun', fields: T.fieldsFor(4, '2026-11-16') }]);
  assert(!noEnd.text.endsWith('\n'));
});
t('extra columns another tool added are kept', () => {
  const x = 'dutch,english,status,right,wrong,streak,last_practised,next_due,pronunciation,note\nzon,sun,unknown,0,0,0,,,,hi\n';
  assert.strictEqual(T.patchProgress(x, [{ dutch: 'zon', english: 'sun', fields: T.fieldsFor(3, '2026-11-16') }]).text.split('\n')[1], 'zon,sun,learning,0,0,2,,2026-11-23,,hi');
});
t('queue: unrated only, A1 first, steady order', () => {
  const words = [{ dutch: 'a', english: 'a', level: 'B1' }, { dutch: 'b', english: 'b', level: 'A1' }, { dutch: 'c', english: 'c', level: '' }, { dutch: 'd', english: 'd', level: 'A1' }, { dutch: 'e', english: 'e', level: 'A2' }];
  const prog = new Map([[T.keyOf('e', 'e'), { status: 'known', streak: '5', next_due: '2027-11-16' }]]);
  const q1 = T.buildQueue(words, prog, 'unrated', '2026-11-16'), q2 = T.buildQueue(words.slice().reverse(), prog, 'unrated', '2026-11-16');
  assert.deepStrictEqual(q1.map(w => w.dutch), q2.map(w => w.dutch));
  assert.deepStrictEqual(q1.map(w => w.level), ['A1', 'A1', '', 'B1']);
  assert.deepStrictEqual(T.buildQueue(words, prog, 5, '2026-11-16').map(w => w.dutch), ['e']);
});

// ---- the real progress files, if given ----
const dir = process.argv[2];
if (dir) for (const who of ['noah', 'anna']) {
  const text = fs.readFileSync(path.join(dir, who + '.csv'), 'utf8'), lines = text.split('\n');
  t(who + '.csv: every line survives parse + write unchanged (so no stray diffs)', () => {
    lines.slice(0, -1).forEach((l, i) => { const f = M.parseCSV(l)[0]; assert.strictEqual(M.csvLine(f), l, 'line ' + (i + 1) + ': ' + l); });
  });
  t(who + '.csv: rating 3 words changes exactly 3 lines', () => {
    const picks = [5, 1000, 2500].map(i => M.parseCSV(lines[i])[0]);
    const r = T.patchProgress(text, picks.map((f, k) => ({ dutch: f[0], english: f[1], fields: T.fieldsFor(k + 2, '2026-11-16') })));
    const b = r.text.split('\n'); let diff = 0; lines.forEach((l, i) => { if (l !== b[i]) diff++; });
    assert.strictEqual(diff, r.changed); assert(diff <= 3 && diff >= 1); assert.strictEqual(b.length, lines.length);
  });
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);

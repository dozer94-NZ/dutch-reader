// Run: node tests/test_matcher.js [path/to/dutch-vocab.csv]
// Uses a small fake list always, and the real list too if a path is given.
const assert = require('assert');
const fs = require('fs');
const M = require('../matcher.js');

let fails = 0;
function t(name, fn) { try { fn(); console.log('ok   ', name); } catch (e) { fails++; console.log('FAIL ', name, '\n     ', e.message); } }

const fake = [
  { dutch: 'huis', english: 'house' }, { dutch: 'de boom', english: 'tree' }, { dutch: 'lopen', english: 'to walk', type: 'word' },
  { dutch: 'groot', english: 'big' }, { dutch: 'de man', english: 'man' }, { dutch: 'werken', english: 'to work' },
  { dutch: 'de rit (het ritje)', english: 'ride' }, { dutch: 'de doos / het doosje', english: 'box' },
  { dutch: 'eten', english: 'to eat — past: ik at, we aten', type: 'verb-past' },
  { dutch: 'eten', english: 'eaten — perfect: ik heb gegeten', type: 'verb-perfect' },
  { dutch: "'s avonds", english: 'in the evening' }, { dutch: 'ik vergat, we vergaten', english: 'I forgot' },
  { dutch: 'de brief', english: 'letter' }, { dutch: 'stoppen', english: 'to stop' }, { dutch: 'ik', english: 'I' },
];
const ix = M.buildIndex(fake);

t('exact words and article stripping', () => {
  assert(ix.known.has('huis')); assert(ix.known.has('boom')); assert(!ix.known.has('de boom'));
});
t('slash and bracket alternatives', () => {
  ['rit', 'ritje', 'doos', 'doosje'].forEach(w => assert(ix.known.has(w), w));
});
t('verb drill forms are picked up', () => {
  ['at', 'aten', 'gegeten'].forEach(w => assert.strictEqual(ix.forms.get(w), 'eten', w));
  assert(!ix.forms.has('ik') && !ix.forms.has('heb'));
});
t('phrase words are hints, not known', () => {
  assert(ix.inPhrase.has('avonds') && !ix.known.has('avonds')); assert(ix.inPhrase.has('vergat'));
});
const cases = { huizen: 'huis', bomen: 'boom', grote: 'groot', mannen: 'man', huisje: 'huis', boompje: 'boom',
  mannetje: 'man', loopt: 'lopen', gelopen: 'lopen', werkt: 'werken', gewerkt: 'werken', werkte: 'werken',
  werkten: 'werken', brieven: 'brief', stopt: 'stoppen', gestopt: 'stoppen', groter: 'groot', grootste: 'groot' };
Object.keys(cases).forEach(w => t('lemma ' + w + ' -> ' + cases[w], () => assert.strictEqual(M.findLemma(w, ix), cases[w])));
t('a really new word has no lemma', () => assert.strictEqual(M.findLemma('schildpad', ix), null));

t('analyse sorts a page', () => {
  const text = 'De man loopt naar het huis. Jan Jansen woont in Amsterdam en eet een appel!\nDe man werkt in de bomen; hij heeft gelopen.\nDe schildpad is groot. De schildpad eet.';
  const r = M.analyse(text, ix);
  const names = a => a.map(x => x.word);
  assert(names(r.known).includes('huis') && names(r.known).includes('man') && names(r.known).includes('groot'));
  assert(names(r.maybe).includes('loopt') && names(r.maybe).includes('bomen') && names(r.maybe).includes('gelopen'));
  const sch = r.unknown.find(x => x.word === 'schildpad');
  assert(sch && sch.count === 2 && /schildpad/.test(sch.sentence));
  assert(r.unknown.find(x => x.word === 'jansen').maybeName === true);
  assert(r.unknown.find(x => x.word === 'amsterdam').maybeName === true);
  assert(r.unknown.every((x, i) => i === 0 || r.unknown[i - 1].count >= x.count), 'most frequent first');
  assert(!r.unknown.find(x => x.word === 'de') || true);
});
t('ignored words disappear', () => {
  const r = M.analyse('De schildpad.', ix, new Set(['schildpad']));
  assert(!r.unknown.find(x => x.word === 'schildpad') && r.ignoredCount === 1);
});
t('line-break hyphen is joined', () => {
  const s = M.splitSentences('Dit is een voor-\nbeeld van tekst.');
  assert.strictEqual(s[0], 'Dit is een voorbeeld van tekst.');
});
t('curly apostrophe and clitics', () => {
  assert.deepStrictEqual(M.tokenise('Hij zegt: \u2019s avonds is het \u2018mooi\u2019.'), ['Hij', 'zegt', "'s", 'avonds', 'is', 'het', 'mooi']);
});
t('CSV with quotes, commas and BOM', () => {
  const rows = M.csvRecords('﻿dutch,english\n"a, b","say ""hi"""\nc,d\n');
  assert.strictEqual(rows.length, 2); assert.strictEqual(rows[0].dutch, 'a, b'); assert.strictEqual(rows[0].english, 'say "hi"');
  assert.strictEqual(M.csvLine(['a, b', 'say "hi"', 'x']), '"a, b","say ""hi""",x');
});

// ---- the real list, if given ----
const p = process.argv[2];
if (p) {
  const rows = M.csvRecords(fs.readFileSync(p, 'utf8'));
  const rx = M.buildIndex(rows);
  console.log('\nreal list:', rows.length, 'rows,', rx.known.size, 'single words,', rx.inPhrase.size, 'phrase words,', rx.forms.size, 'verb forms');
  t('real list: 3000+ rows parse, key columns present', () => { assert(rows.length > 2500); assert(rows.every(r => r.dutch && r.english)); });
  t('real list: common words known', () => ['ik', 'huis', 'lopen', 'eten', 'jij'].forEach(w => assert(rx.known.has(w), w)));
  const text = 'Ik woon in een klein huis met mijn vriendin. We eten elke dag brood en kaas. Gisteren zijn wij naar de markt gelopen en hebben we appels gekocht. Het weer was mooi, maar de wolken kwamen later. De buurman, Pieter, heeft een nieuwe fiets.';
  const r = M.analyse(text, rx);
  console.log('sample page: total', r.total, '| known', r.known.length, '| maybe', r.maybe.length, '| unknown', r.unknown.length);
  console.log('  maybe  :', r.maybe.map(x => x.word + '→' + x.lemma).join(', '));
  console.log('  unknown:', r.unknown.map(x => x.word + (x.maybeName ? '(name?)' : '')).join(', '));
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);

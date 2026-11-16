// Real Chrome, fake GitHub (an in-memory copy of your real files). Run from a folder with puppeteer-core installed:
//   NODE_PATH=.../node_modules node test_browser.js <app-folder> <learning-progress/dutch folder>
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const [appDir, dataDir] = process.argv.slice(2);
const M = require(path.join(appDir, 'matcher.js')), T = require(path.join(appDir, 'triage.js'));

const files = {
  'dutch/vocab/dutch-vocab.csv': { text: fs.readFileSync(path.join(dataDir, 'vocab/dutch-vocab.csv'), 'utf8'), sha: 'v1' },
  'dutch/noah.csv': { text: fs.readFileSync(path.join(dataDir, 'noah.csv'), 'utf8'), sha: 'n1' },
  'dutch/anna.csv': { text: fs.readFileSync(path.join(dataDir, 'anna.csv'), 'utf8'), sha: 'a1' },
};
const original = { noah: files['dutch/noah.csv'].text, anna: files['dutch/anna.csv'].text };
let shaN = 1, puts = [], conflictOnce = false, phoneEdit = null, offline = false;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, s) => {
  let p = path.join(appDir, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, b) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); s.end(b); } });
});
let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok   ' : 'FAIL ', m); if (!c) fails++; };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

async function newPhone(browser) {
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage(), errors = [];
  await page.setViewport({ width: 400, height: 900 });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/status of (404|409|422)|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { if (!localStorage.getItem('dr.token')) { localStorage.setItem('dr.token', '"fake-token"'); localStorage.setItem('dr.who', '"Noah"'); } });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url(), m = req.method();
    if (u.startsWith('https://api.github.com/')) {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
      const fp = decodeURIComponent(u.split('/contents/')[1].split('?')[0]), f = files[fp];
      if (m === 'GET') {
        if (!f) return req.respond({ status: 404, headers: CORS, body: '{}' });
        if (/raw/.test(req.headers().accept || '')) return req.respond({ status: 200, headers: CORS, contentType: 'text/plain', body: f.text });
        return req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ sha: f.sha, size: f.text.length, content: Buffer.from(f.text).toString('base64') }) });
      }
      if (m === 'PUT') {
        if (offline) return req.abort('failed');
        const b = JSON.parse(req.postData());
        if (conflictOnce && fp === 'dutch/noah.csv') { // the phone saved first
          conflictOnce = false; files[fp] = { text: phoneEdit(f.text), sha: 'n' + (++shaN) };
          return req.respond({ status: 409, headers: CORS, body: '{}' });
        }
        if ((f && b.sha !== f.sha) || (!f && b.sha)) return req.respond({ status: 409, headers: CORS, body: '{}' });
        files[fp] = { text: Buffer.from(b.content, 'base64').toString('utf8'), sha: 'x' + (++shaN) };
        puts.push({ path: fp, message: b.message });
        return req.respond({ status: 201, headers: CORS, contentType: 'application/json', body: '{}' });
      }
    }
    if (u.startsWith('https://en.wiktionary.org/')) return req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ nl: [{ definitions: [{ definition: 'A <a>sunburn</a>.' }] }] }) });
    req.continue();
  });
  return { ctx, page, errors };
}
const txt = (page, sel) => page.$eval(sel, e => e.textContent);
const diffLines = (a, b) => { const x = a.split('\n'), y = b.split('\n'), out = []; if (x.length !== y.length) return null; x.forEach((l, i) => { if (l !== y[i]) out.push(i); }); return out; };

(async () => {
  await new Promise(r => srv.listen(8766, r));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const today = new Date().toLocaleDateString('sv-SE');
  const vocab = M.csvRecords(files['dutch/vocab/dutch-vocab.csv'].text).map(r => ({ dutch: r.dutch, english: r.english, level: r.level || '' }));
  const prog = new Map(M.csvRecords(original.noah).map(r => [T.keyOf(r.dutch, r.english), r]));
  const expectQueue = T.buildQueue(vocab, prog, 'unrated', today);

  console.log('\n=== Noah rates 12 words; the phone saves in between ===');
  let { ctx, page, errors } = await newPhone(browser);
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  ok(/3,018 words, Noah/.test(await txt(page, '#listStatus')), 'list + Noah progress loaded: ' + await txt(page, '#listStatus'));
  ok((await page.$eval('#card', e => !e.hidden)), 'a card is showing');
  ok(await txt(page, '#cWord') === expectQueue[0].dutch, 'first word is the first A1 unrated word: ' + expectQueue[0].dutch);
  ok(/not rated yet/.test(await txt(page, '#bNow')) && await txt(page, '#cEng') === '', 'English hidden until asked');
  await page.keyboard.press(' ');
  ok(await txt(page, '#cEng') === expectQueue[0].english, 'space reveals English');

  const lines = original.noah.split('\n'), phoneLineIdx = 2900, phoneWord = M.parseCSV(lines[phoneLineIdx])[0];
  phoneEdit = t => { const l = t.split('\n'), f = M.parseCSV(l[phoneLineIdx])[0]; f[3] = '9'; l[phoneLineIdx] = M.csvLine(f); return l.join('\n'); };
  conflictOnce = true;
  const pattern = [5, 4, 3, 2, 1, 0, 5, 4, 3, 2, 1, 0], rated = [];
  for (let i = 0; i < 12; i++) {
    const w = expectQueue[i]; ok(await txt(page, '#cWord') === w.dutch, 'card ' + (i + 1) + ' = ' + w.dutch) || 0;
    rated.push({ w, n: pattern[i] });
    await page.keyboard.press(String(pattern[i]));
    if (i === 9) await page.waitForFunction(() => /Saved/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  }
  const m1 = await txt(page, '#saveMsg');
  ok(/2 ratings waiting/.test(m1), 'autosave fired at 10, 2 still waiting: ' + m1);
  ok(puts.length === 1, 'one PUT so far (first try hit the phone conflict, second went through)');
  await page.click('#btnSave');
  await page.waitForFunction(() => /Saved 2/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  ok(puts.length === 2, 'manual save made the second PUT');

  const finalNoah = files['dutch/noah.csv'].text, ch = diffLines(original.noah, finalNoah);
  ok(ch !== null, 'same number of lines as before');
  const keysChanged = new Set(ch.map(i => i));
  const expectIdx = new Set(rated.map(r => lines.findIndex(l => { const f = M.parseCSV(l)[0]; return f[0] === r.w.dutch && f[1] === r.w.english; })));
  expectIdx.add(phoneLineIdx);
  ok([...keysChanged].sort().join() === [...expectIdx].sort().join(), 'exactly the 12 rated lines + the phone\'s own line changed (' + ch.length + ' lines)');
  const fl = finalNoah.split('\n');
  ok(M.parseCSV(fl[phoneLineIdx])[0][3] === '9', 'the phone\'s change (right=9 for ' + phoneWord + ') survived the merge');
  let allGood = true;
  rated.forEach(r => {
    const i = lines.findIndex(l => { const f = M.parseCSV(l)[0]; return f[0] === r.w.dutch && f[1] === r.w.english; }), before = M.parseCSV(lines[i])[0], after = M.parseCSV(fl[i])[0], want = T.fieldsFor(r.n, today);
    if (after[2] !== want.status || after[5] !== want.streak || after[7] !== want.next_due || [0, 1, 3, 4, 6, 8].some(c => before[c] !== after[c])) { allGood = false; console.log('   bad row', r.w.dutch, before, after); }
  });
  ok(allGood, 'each rated word has the right status/streak/next_due; right, wrong, last_practised, pronunciation untouched');
  ok(puts.every(p => /Self-assessed \d+ word\(s\) in Dutch words app \(Noah\)/.test(p.message)), 'commit messages say what and who');

  console.log('\n=== undo after saving, then re-check mode ===');
  await page.keyboard.press('Backspace');
  ok((await txt(page, '#saveMsg')).startsWith('1 rating waiting'), 'undo of an already-saved rating queues a restore');
  await page.click('#btnSave');
  await page.waitForFunction(() => /Saved 1/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  const last = rated[11], li = lines.findIndex(l => { const f = M.parseCSV(l)[0]; return f[0] === last.w.dutch && f[1] === last.w.english; });
  ok(files['dutch/noah.csv'].text.split('\n')[li] === lines[li], 'the undone word is back exactly as it was in the file');
  await page.select('#mode', '5');
  const cnt5 = await txt(page, '#sortMsg');
  const want5 = rated.slice(0, 11).filter(r => r.n === 5).length;
  ok(new RegExp(want5 + ' left in this set').test(cnt5) || want5 === 0, 'Re-check "5 Known" shows the words rated 5: ' + cnt5);
  await page.select('#mode', 'unrated');

  console.log('\n=== offline: ratings are kept and sent later ===');
  offline = true;
  const w13 = expectQueue[11];
  ok(await txt(page, '#cWord') === w13.dutch, 'card 12 again (it was undone)');
  await page.keyboard.press('4');
  await page.click('#btnSave');
  await page.waitForFunction(() => /Couldn't save/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  ok(true, 'offline save fails politely: ' + await txt(page, '#saveMsg'));
  const stored = await page.evaluate(() => localStorage.getItem('dr.pending.Noah'));
  ok(stored && Object.keys(JSON.parse(stored)).length === 1, 'rating kept in the phone\'s storage');
  await page.reload({ waitUntil: 'networkidle0' });
  ok(/1 rating waiting/.test(await txt(page, '#saveMsg')), 'after closing and reopening it is still waiting');
  offline = false; await page.click('#btnSave');
  await page.waitForFunction(() => /Saved 1/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  ok(diffLines(original.noah, files['dutch/noah.csv'].text).includes(li), 'sent once back online');

  console.log('\n=== Add a word ===');
  await page.click('#tabAddBtn');
  await page.type('#fDutch', 'huizen');
  ok(/form of "huis"/.test(await txt(page, '#dutchNote')), 'typing a form of a known word is flagged: ' + await txt(page, '#dutchNote'));
  await page.$eval('#fDutch', e => e.value = ''); await page.type('#fDutch', 'zonnebrand');
  await page.click('#btnLookup'); await page.waitForFunction(() => document.getElementById('fEnglish').value.length > 0);
  await page.click('#btnAdd');
  ok((await txt(page, '#queueMsg')).startsWith('1 word'), 'queued');
  await page.click('#btnSend');
  await page.waitForFunction(() => document.getElementById('queueBar').hidden, { timeout: 10000 });
  ok(/^dutch,english,phrase,who,date,source\nzonnebrand,A sunburn\.,,Noah,.*unreviewed\)\n$/.test(files['dutch/inbox.csv'].text), 'inbox.csv: ' + JSON.stringify(files['dutch/inbox.csv'].text));
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  console.log('\n=== Anna uses her own file ===');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#btnSettings'); await page.select('#sWho', 'Anna'); await page.click('#sSave');
  await page.waitForFunction(() => /Anna's progress/.test(document.getElementById('listStatus').textContent), { timeout: 10000 });
  await page.keyboard.press('3'); await page.click('#btnSave');
  await page.waitForFunction(() => /Saved 1/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  ok(files['dutch/anna.csv'].text !== original.anna && diffLines(original.anna, files['dutch/anna.csv'].text).length === 1, 'one line changed in anna.csv');
  ok(puts[puts.length - 1].message.includes('(Anna)'), 'commit names Anna');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  await browser.close(); srv.close();
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });

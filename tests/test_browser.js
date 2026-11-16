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
      if (m === 'GET' && fp === 'dutch') return req.respond({ status: 200, headers: CORS, contentType: 'application/json',
        body: JSON.stringify(Object.keys(files).filter(k => /^dutch\/[^/]+$/.test(k)).map(k => ({ name: k.slice(6), type: 'file' })).concat([{ name: 'vocab', type: 'dir' }])) });
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
const pageText = page => page.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('script').forEach(e => e.remove()); return c.textContent.replace(/\s+/g, ' '); });
const txt = (page, sel) => page.$eval(sel, e => e.textContent);
const diffLines = (a, b) => { const x = a.split('\n'), y = b.split('\n'), out = []; if (x.length !== y.length) return null; x.forEach((l, i) => { if (l !== y[i]) out.push(i); }); return out; };

(async () => {
  await new Promise(r => srv.listen(8766, r));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const today = new Date().toLocaleDateString('sv-SE');
  const allRows = M.csvRecords(files['dutch/vocab/dutch-vocab.csv'].text), TOTAL = allRows.length;
  const vocab = allRows.filter(r => !/^verb-/.test(r.type || '')).map(r => ({ dutch: r.dutch, english: r.english, level: r.level || '' })), NW = vocab.length;
  const prog = new Map(M.csvRecords(original.noah).map(r => [T.keyOf(r.dutch, r.english), r]));
  const expectQueue = T.buildQueue(vocab, prog, 'unrated', today);

  console.log('\n=== Noah rates 12 words; the phone saves in between ===');
  let { ctx, page, errors } = await newPhone(browser);
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  ok(new RegExp(NW.toLocaleString() + ' words, Noah').test(await txt(page, '#listStatus')), 'list + Noah progress loaded: ' + await txt(page, '#listStatus'));
  ok((await page.$eval('#card', e => !e.hidden)), 'a card is showing');
  ok(await txt(page, '#cWord') === expectQueue[0].dutch, 'first word is the first A1 unrated word: ' + expectQueue[0].dutch);
  ok(/not rated yet/.test(await txt(page, '#bNow')) && await txt(page, '#cEng') === '', 'English hidden until asked');
  await page.keyboard.press(' ');
  ok(await txt(page, '#cEng') === expectQueue[0].english, 'space reveals English');

  const lines = original.noah.split('\n'), phoneLineIdx = Math.floor(original.noah.split('\n').length * 0.8), phoneWord = M.parseCSV(lines[phoneLineIdx])[0];
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
  const r11 = rated.slice(0, 11), base5 = vocab.filter(w => !r11.some(r => r.w === w) && T.levelOf(prog.get(T.keyOf(w.dutch, w.english)), today) === 5).length;
  const want5 = base5 + r11.filter(r => r.n === 5).length;   // words already rated 5 before + the ones rated 5 in this test
  ok(new RegExp(want5 + ' left in this set').test(cnt5) || want5 === 0, 'Re-check "5 Never need to practise again" shows the words rated 5: ' + cnt5);
  await page.select('#mode', 'unrated');

  console.log('\n=== offline: ratings are kept and sent later ===');
  offline = true;
  const w13 = expectQueue[11];
  ok(await txt(page, '#cWord') === w13.dutch, 'card 12 again (it was undone)');
  await page.keyboard.press('4');
  await page.click('#btnSave');
  await page.waitForFunction(() => /Couldn't save/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  ok(true, 'offline save fails politely: ' + await txt(page, '#saveMsg'));
  ok(!/github/i.test(await pageText(page)), 'no "GitHub" anywhere on the page, even in the error message');
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
  console.log('\n=== Flag an issue and pitch an idea ===');
  await page.click('#tabSortBtn');
  const flagged = await txt(page, '#cWord');
  await page.click('#btnFlag'); await page.waitForSelector('#flagDlg[open]');
  await page.select('#flagType', 'wrong way round'); await page.type('#flagNote', 'check this, "english" first?');
  await page.click('#flagOk');
  await page.waitForFunction(() => !document.getElementById('flagDlg').open);
  await page.waitForFunction(() => /flagged/.test(document.getElementById('bFlag').textContent) && !document.getElementById('bFlag').hidden);
  ok(true, 'flagged chip shows on the card');
  await new Promise(r => setTimeout(r, 800));
  const iss = files['dutch/issues.csv'] && files['dutch/issues.csv'].text;
  ok(iss && iss.startsWith('dutch,english,type,note,who,date\n') && iss.includes(flagged + ',') && /wrong way round,"check this, ""english"" first\?",Noah,/.test(iss), 'issues.csv: ' + JSON.stringify(iss));
  ok((await page.$eval('#card', e => !e.hidden)) && await txt(page, '#cWord') === flagged, 'flagging does not move to the next word');
  await page.click('#tabIdeasBtn');
  await page.type('#ideaText', 'Please add a quiz, with sounds');
  await page.click('#btnIdea');
  await page.waitForFunction(() => /Sent/.test(document.getElementById('ideaMsg').textContent), { timeout: 10000 });
  const ideas = files['dutch/ideas.csv'] && files['dutch/ideas.csv'].text;
  ok(ideas && ideas.startsWith('date,who,idea\n') && /,Noah,"Please add a quiz, with sounds"\n$/.test(ideas), 'ideas.csv: ' + JSON.stringify(ideas));
  await page.click('#btnSettings');
  ok(!/github/i.test(await pageText(page)), 'no "GitHub" anywhere on the page (all tabs, settings, dialogs)');
  await page.keyboard.press('Escape');

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

  console.log('\n=== Add a person ===');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#btnSettings');
  await page.waitForFunction(() => document.querySelectorAll('#sWho option').length >= 2);
  const opts = () => page.$$eval('#sWho option', o => o.map(x => x.textContent));
  ok((await opts()).join() === 'Anna,Noah', 'Who list comes from the folder, without inbox/issues/ideas: ' + (await opts()).join());
  const create = async name => { await page.$eval('#sNewName', e => e.value = ''); if (name) await page.type('#sNewName', name); await page.click('#sAddPerson'); await new Promise(r => setTimeout(r, 600)); return txt(page, '#sPersonMsg'); };
  ok(/2 to 20 letters/.test(await create('x')), 'a too-short name is refused');
  ok(/used for something else/.test(await create('Ideas')), 'a reserved name is refused');
  ok(/already has a list/.test(await create('noah')), 'an existing person is not overwritten');
  ok(files['dutch/noah.csv'].text.length > 0 && diffLines(original.noah, files['dutch/noah.csv'].text) !== null, 'noah.csv untouched by that');
  const msg = await create('Sam');
  ok(msg.includes("Created Sam's list with " + TOTAL.toLocaleString() + ' words'), msg);
  const sam = files['dutch/sam.csv'] && files['dutch/sam.csv'].text, sl = sam.split('\n');
  ok(sl[0] === 'dutch,english,status,right,wrong,streak,last_practised,next_due,pronunciation' && sl.length === TOTAL + 2 && sl[TOTAL + 1] === '', 'sam.csv: header + ' + TOTAL + ' rows (words and verb drills) + final newline');
  const keyseq = t => t.split('\n').slice(1).filter(Boolean).map(l => { const f = M.parseCSV(l)[0]; return f[0] + '|' + f[1]; });
  ok(keyseq(sam).join('\n') === keyseq(original.noah).join('\n'), 'rows are in exactly the same order as noah.csv (so diffs stay small)');
  ok(sl.slice(1, -1).every(l => /,unknown,0,0,0,,,$/.test(l)), 'every row is unknown with zero counts');
  ok(new RegExp('progress file \\(' + TOTAL + ' words, all unknown\\)').test(puts[puts.length - 1].message), 'commit message: ' + puts[puts.length - 1].message);
  ok((await opts()).join() === 'Anna,Noah,Sam' && await page.$eval('#sWho', e => e.value) === 'Sam', 'Sam is in the list and chosen');
  await page.click('#sSave');
  await page.waitForFunction(() => /Sam's progress/.test(document.getElementById('listStatus').textContent), { timeout: 10000 });
  await page.keyboard.press('2'); await page.click('#btnSave');
  await page.waitForFunction(() => /Saved 1/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  ok(diffLines(sam, files['dutch/sam.csv'].text).length === 1, 'Sam rates a word: one line changes in sam.csv');
  ok(!/github/i.test(await pageText(page)), 'still no "GitHub" on the page');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  console.log('\n=== Games: rounds, word of the week, leaderboard ===');
  const G = require(path.join(appDir, 'game.js'));
  const wordsT = M.csvRecords(files['dutch/vocab/dutch-vocab.csv'].text).filter(r => r.dutch && r.english).map(r => ({ dutch: r.dutch, english: r.english, level: r.level || '', type: r.type || 'word' }));
  const eng = {}; wordsT.forEach(w => (eng[w.dutch] = eng[w.dutch] || []).push(w.english));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
  const rowsOf = f => files[f] ? M.csvRecords(files[f].text) : [];
  async function play(page, chooser) { // chooser(i) -> 'right' | 'wrong'
    const log = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForFunction(n => new RegExp('Question ' + n + ' of').test(document.getElementById('qInfo').textContent), { timeout: 5000 }, i + 1);
      const dutch = await txt(page, '#qWord'), opts = await page.$$eval('#qOpts .opt span', e => e.map(x => x.textContent));
      const star = await page.$eval('#qStar', e => !e.hidden), good = o => (eng[dutch] || []).includes(o);
      const want = chooser(i), idx = opts.findIndex(o => want === 'right' ? good(o) : !good(o));
      await page.click('#qOpts .opt:nth-child(' + (idx + 1) + ')');
      const fb = await txt(page, '#qFeedback');
      log.push({ dutch, opts, star, want, fb, pts: Number((fb.match(/\+(\d+)/) || [0, 0])[1]) });
      await page.click('#qNext');
    }
    await page.waitForFunction(() => !document.getElementById('quizEnd').hidden, { timeout: 5000 });
    return log;
  }
  const sumPts = log => log.reduce((a, l) => a + l.pts, 0);
  const wk = G.weekStart(today), wotw = G.wordOfWeek(wordsT, wk);

  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  ok((await txt(page, '#rate')).includes('Vaguely recognise it') && (await txt(page, '#rate')).includes('Never seen it') && (await txt(page, '#rate')).includes('Never practise again'), 'rating buttons use the new names');
  ok((await page.$eval('#mode', e => e.textContent)).includes('5 Never need to practise again'), 'the re-check list uses the new names');
  await page.click('#tabPlayBtn');
  ok((await txt(page, '#wotwBox')).includes(wotw.dutch), 'word of the week shown: ' + wotw.dutch);
  const noahBefore = files['dutch/noah.csv'].text;
  await page.click('#btnRound');
  let log = await play(page, i => i < 7 ? 'right' : 'wrong');
  ok(log[0].dutch === wotw.dutch && log[0].star, 'the word of the week is the first question and is starred');
  ok(log.every(l => l.opts.length === 4 && new Set(l.opts).size === 4), 'four different options every time');
  ok(/You got 7 of 10/.test(await txt(page, '#qSummary')) && /Word of the week: \+30/.test(await txt(page, '#qSummary')), 'summary: ' + await txt(page, '#qSummary'));
  ok(await until(() => rowsOf('dutch/scores.csv').length === 1), 'one score row sent');
  let sc = rowsOf('dutch/scores.csv');
  ok(sc[0].who === 'Noah' && sc[0].mode === 'practice' && sc[0].right === '7' && sc[0].total === '10' && sc[0].wotw === '1', 'score row: ' + JSON.stringify(sc[0]));
  ok(Number(sc[0].points) === sumPts(log) + 30 + 3, 'points = questions ' + sumPts(log) + ' + word of the week 30 + first-day streak 3 (got ' + sc[0].points + ')');
  ok(await until(async () => files['dutch/noah.csv'].text !== noahBefore), 'progress saved after the round');
  const lastPut = f => puts.filter(x => x.path === f).pop();
  const d1 = diffLines(noahBefore, files['dutch/noah.csv'].text);
  ok(d1 && d1.length === 10, 'exactly 10 lines of noah.csv changed: ' + (d1 && d1.length));
  const w0 = M.csvRecords(files['dutch/noah.csv'].text).find(r => r.dutch === log[0].dutch && eng[r.dutch].includes(r.english)), w0o = M.csvRecords(noahBefore).find(r => r.dutch === w0.dutch && r.english === w0.english);
  ok(Number(w0.right) === Number(w0o.right) + 1 && w0.last_practised === today && w0.pronunciation === w0o.pronunciation, 'a right answer adds 1 to right, stamps today, leaves pronunciation alone');
  ok(lastPut('dutch/noah.csv').message.startsWith('Practised 10 word(s)') && lastPut('dutch/noah.csv').message.includes('(Noah)'), 'commit says practised: ' + lastPut('dutch/noah.csv').message);
  await page.click('#qDone'); await page.click('#tabBoardBtn');
  ok(/Noah \(you\)/.test(await txt(page, '#boardList')) && (await txt(page, '#boardList')).includes(sc[0].points + ' pts'), 'leaderboard shows Noah with ' + sc[0].points + ' pts');
  ok(/Week of /.test(await txt(page, '#boardWeek')), 'the week is shown');

  console.log('\n=== Second round the same day: perfect bonus, no star, no second streak bonus ===');
  await page.click('#tabPlayBtn'); await page.click('#btnRound');
  log = await play(page, () => 'right');
  ok(!log.some(l => l.star), 'no star once the word of the week is done');
  await until(() => rowsOf('dutch/scores.csv').length === 2);
  sc = rowsOf('dutch/scores.csv');
  ok(Number(sc[1].points) === sumPts(log) + 20 && sc[1].wotw === '', 'perfect round: questions ' + sumPts(log) + ' + 20 (got ' + sc[1].points + ')');
  ok(/Perfect round/.test(await txt(page, '#qSummary')), 'summary mentions the perfect round');

  console.log('\n=== Offline round is kept and sent later ===');
  await page.click('#qDone'); await until(async () => /Saved|Already/.test(await txt(page, '#saveMsg')));
  offline = true;
  await page.click('#btnRound'); log = await play(page, () => 'wrong');
  ok(/scored 0 points/.test(await txt(page, '#qSummary')), 'all wrong scores 0');
  await new Promise(r => setTimeout(r, 800));
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('dr.scoreQ') || '[]').length) === 1 && rowsOf('dutch/scores.csv').length === 2, 'the score waits on the phone while offline');
  offline = false;
  await page.reload({ waitUntil: 'networkidle0' });
  ok(await until(() => rowsOf('dutch/scores.csv').length === 3), 'sent after coming back online');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('dr.scoreQ') || '[]').length) === 0, 'the phone queue is empty again');
  await page.click('#btnSave');
  ok(await until(async () => /Saved/.test(await txt(page, '#saveMsg'))), 'waiting answers saved too');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  console.log('\n=== Battle: Noah challenges Anna, Anna plays the same questions ===');
  await page.click('#tabPlayBtn');
  ok((await page.$$eval('#bOpp option', o => o.map(x => x.textContent))).join() === 'Anna,Sam', 'opponents are everyone but me');
  await page.select('#bOpp', 'Anna'); await page.select('#bMode', 'normal');
  await page.click('#btnChallenge');
  const nlog = await play(page, () => 'right');
  ok(/Challenge sent to Anna/.test(await txt(page, '#qSummary')), 'summary: ' + (await txt(page, '#qSummary')));
  ok(await until(() => rowsOf('dutch/battles.csv').length === 1), 'challenge row sent');
  let br = rowsOf('dutch/battles.csv');
  ok(br[0].type === 'challenge' && br[0].who === 'Noah' && br[0].opponent === 'Anna' && br[0].mode === 'normal' && br[0].total === '10' && br[0].right === '10', 'challenge row ok');
  const qsStored = JSON.parse(br[0].questions);
  ok(qsStored.length === 10 && qsStored.every((q, i) => q.d === nlog[i].dutch && JSON.stringify(q.o) === JSON.stringify(nlog[i].opts)), 'the questions are stored exactly as Noah saw them');
  ok(Number(br[0].score) === sumPts(nlog) && sumPts(nlog) >= 100 && sumPts(nlog) <= 150, 'battle score is flat 10 + speed: ' + br[0].score);
  ok(await until(() => rowsOf('dutch/scores.csv').length === 4 && rowsOf('dutch/scores.csv')[3].mode === 'battle'), 'battle points also go on the weekly board');
  ok(!(/Perfect|streak/.test(await txt(page, '#qSummary'))), 'no bonuses in a battle');
  await ctx.close();

  ({ ctx, page, errors } = await newPhone(browser));
  await page.evaluateOnNewDocument(() => localStorage.setItem('dr.who', '"Anna"'));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  ok(/Anna's progress/.test(await txt(page, '#listStatus')), 'this phone is Anna now');
  await page.click('#tabPlayBtn');
  await page.waitForSelector('#battleLists .brow button');
  ok(/Noah challenged you \(normal/.test(await txt(page, '#battleLists')), 'Anna sees the challenge: ' + (await txt(page, '#battleLists')).slice(0, 80));
  const annaBefore = files['dutch/anna.csv'].text;
  await page.click('#battleLists .brow button');
  const alog = await play(page, i => i < 5 ? 'right' : 'wrong');
  ok(alog.every((l, i) => l.dutch === nlog[i].dutch && JSON.stringify(l.opts) === JSON.stringify(nlog[i].opts)), 'Anna got the same words and the same options in the same order');
  ok(/Noah won this one/.test(await txt(page, '#qSummary')), 'result shown: ' + (await txt(page, '#qSummary')));
  ok(await until(() => rowsOf('dutch/battles.csv').length === 2), 'reply row sent');
  br = rowsOf('dutch/battles.csv');
  ok(br[1].type === 'reply' && br[1].who === 'Anna' && br[1].opponent === 'Noah' && br[1].id === br[0].id && br[1].right === '5' && br[1].questions === '', 'reply row ok');
  ok(await until(async () => files['dutch/anna.csv'].text !== annaBefore) && lastPut('dutch/anna.csv').message.includes('(Anna)'), 'Anna\'s answers saved to anna.csv: ' + lastPut('dutch/anna.csv').message);
  ok(diffLines(annaBefore, files['dutch/anna.csv'].text).length === 10, 'ten lines of anna.csv changed, none of Noah\'s');
  await page.click('#qDone');
  ok(!(await txt(page, '#battleLists')).includes('challenged you'), 'the challenge is no longer waiting');
  await page.click('#tabBoardBtn');
  ok(/Battle wins: Noah 1/.test(await txt(page, '#boardWins')), 'battle wins: ' + await txt(page, '#boardWins'));
  ok(/Noah/.test(await txt(page, '#boardList')) && /Anna \(you\)/.test(await txt(page, '#boardList')), 'Anna sees everyone on the board');
  ok(!/github/i.test(await pageText(page)), 'no "GitHub" on the game screens');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  console.log('\n=== Handicap battle: words neither knows ===');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#tabPlayBtn');
  const nP = new Map(M.csvRecords(files['dutch/noah.csv'].text).map(r => [T.keyOf(r.dutch, r.english), r])), aP = new Map(M.csvRecords(files['dutch/anna.csv'].text).map(r => [T.keyOf(r.dutch, r.english), r]));
  await page.select('#bOpp', 'Anna'); await page.select('#bMode', 'handicap');
  await page.click('#btnChallenge');
  await play(page, () => 'right');
  ok(await until(() => rowsOf('dutch/battles.csv').length === 3), 'handicap challenge sent');
  const hq = JSON.parse(rowsOf('dutch/battles.csv')[2].questions), hrow = rowsOf('dutch/battles.csv')[2];
  ok(hrow.mode === 'handicap' && hq.length === 10, 'row says handicap');
  const lvl = (P, q) => { const l = T.levelOf(P.get(T.keyOf(q.d, q.e)), today); return l === null ? 0 : l; };
  ok(hq.every(q => lvl(nP, q) === 0 && lvl(aP, q) === 0), 'every handicap word is new to both players');
  const wordLevel = d => (wordsT.find(w => w.dutch === d) || {}).level;
  ok(hq.every(q => ['A1', 'A2'].includes(wordLevel(q.d))), 'and easy (A1/A2) words');
  ok(hq.every(q => !/ \u2014 past:/.test(q.e)), 'no verb drill rows in battles');
  await page.click('#qDone');
  ok(/handicap/.test(await txt(page, '#battleLists')), 'listed as a handicap battle');
  ok(!/github/i.test(await pageText(page)), 'no "GitHub" anywhere');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  console.log('\n=== Verb drill is separate ===');
  const drillRows = allRows.filter(r => /^verb-/.test(r.type || '')), drillKeys = new Set(drillRows.map(r => r.dutch + '\u0001' + r.english));
  ok(drillRows.length > 30 && drillRows.every(r => G.parseDrill(r.english) && G.parseDrill(r.english).perfect !== undefined), 'every drill row reads as past + perfect: ' + drillRows.length + ' rows');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#tabPlayBtn');
  const noahBeforeD = files['dutch/noah.csv'].text;
  await page.click('#btnDrill');
  const dlog = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(n => new RegExp('Question ' + n + ' of').test(document.getElementById('qInfo').textContent), { timeout: 5000 }, i + 1);
    const dutch = await txt(page, '#qWord'), prompt = await txt(page, '#qPrompt'), opts = await page.$$eval('#qOpts .opt span', e => e.map(x => x.textContent));
    const form = /^Past/.test(prompt) ? 'past' : 'perfect', row = drillRows.find(r => r.dutch === dutch), right = G.parseDrill(row.english)[form];
    const want = i < 6 ? 'right' : 'wrong', idx = opts.findIndex(o => want === 'right' ? o === right : o !== right);
    dlog.push({ dutch, prompt, opts, right, form });
    await page.click('#qOpts .opt:nth-child(' + (idx + 1) + ')'); await page.click('#qNext');
  }
  await page.waitForFunction(() => !document.getElementById('quizEnd').hidden, { timeout: 5000 });
  ok(dlog.every(l => /^(Past tense|Perfect) of /.test(l.prompt) && l.opts.length === 4 && new Set(l.opts).size === 4 && l.opts.includes(l.right)), 'drill questions: prompt + four different forms, one right');
  ok(dlog.every(l => l.opts.every(o => !/ \u2014 /.test(o))), 'options are just the forms, not the whole row');
  ok(await until(() => rowsOf('dutch/scores.csv').some(r => r.mode === 'drill')), 'drill score row sent');
  const dsc = rowsOf('dutch/scores.csv').filter(r => r.mode === 'drill')[0];
  ok(dsc.right === '6' && dsc.total === '10' && dsc.who === 'Noah', 'score row: ' + JSON.stringify(dsc));
  ok(await until(async () => files['dutch/noah.csv'].text !== noahBeforeD), 'progress saved');
  const changed = M.csvRecords(files['dutch/noah.csv'].text).filter((r, i) => r.last_practised === today && !M.csvRecords(noahBeforeD).some(o => o.dutch === r.dutch && o.english === r.english && o.last_practised === today && o.right === r.right && o.wrong === r.wrong));
  ok(changed.length === 10 && changed.every(r => drillKeys.has(r.dutch + '\u0001' + r.english)), 'exactly 10 progress rows changed and all are verb drill rows');
  ok(!/github/i.test(await pageText(page)), 'no "GitHub" on the page');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
  // quick rounds and sorting never show drill rows (checked on the page the first round left behind)
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  let seenDrill = false;
  for (let t = 0; t < 3; t++) { await page.click('#tabPlayBtn'); await page.click('#btnRound'); const l = await play(page, () => 'right'); if (l.some(x => x.opts.some(o => / \u2014 /.test(o)))) seenDrill = true; await page.click('#qDone'); }
  ok(!seenDrill, 'three quick rounds: no verb drill row among the options');
  await page.click('#tabSortBtn'); await page.select('#mode', 'all');
  ok(new RegExp('\\b' + NW + ' left in this set').test(await txt(page, '#sortMsg')), 'sorting "all words" offers exactly the ' + NW + ' words, no verb drill rows: ' + await txt(page, '#sortMsg'));
  await ctx.close();

  await browser.close(); srv.close();
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });

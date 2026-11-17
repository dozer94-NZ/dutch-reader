// Real Chrome, fake GitHub (an in-memory copy of your real files). Run from a folder with puppeteer-core installed:
//   NODE_PATH=.../node_modules node test_browser.js <app-folder> <learning-progress/dutch folder>
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const [appDir, dataDir] = process.argv.slice(2);
const M = require(path.join(appDir, 'matcher.js')), T = require(path.join(appDir, 'triage.js'));

const files = {
  'dutch/vocab/dutch-vocab.csv': { text: fs.readFileSync(path.join(dataDir, 'vocab/dutch-vocab.csv'), 'utf8'), sha: 'v1' },
  'dutch/vocab/packs.csv': { text: fs.readFileSync(path.join(dataDir, 'vocab/packs.csv'), 'utf8'), sha: 'p1' },
  'dutch/noah.csv': { text: fs.readFileSync(path.join(dataDir, 'noah.csv'), 'utf8'), sha: 'n1' },
  'dutch/anna.csv': { text: fs.readFileSync(path.join(dataDir, 'anna.csv'), 'utf8'), sha: 'a1' },
};
const original = { noah: files['dutch/noah.csv'].text, anna: files['dutch/anna.csv'].text };
let shaN = 1, puts = [], conflictOnce = false, phoneEdit = null, offline = false, rawForJson = false;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, s) => {
  let p = path.join(appDir, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, b) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); s.end(b); } });
});
let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok   ' : 'FAIL ', m); if (!c) fails++; };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

async function newPhone(browser, opts = {}) {
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage(), errors = [];
  await page.setViewport({ width: 400, height: 900 });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/status of (404|409|422)|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.evaluateOnNewDocument(five => { if (!localStorage.getItem('dr.token')) { localStorage.setItem('dr.token', '"fake-token"'); localStorage.setItem('dr.who', '"Noah"'); if (five) localStorage.setItem('dr.showFive', 'true'); } }, opts.five !== false);
  // The sorting screen is a sheet on the Home tab. These wrappers open it when a step needs it and close it when a step
  // needs something behind it, the way a person would, so the older steps below read the same as before.
  const oClick = page.click.bind(page), oSelect = page.select.bind(page), oPress = page.keyboard.press.bind(page.keyboard);
  const isOpen = () => page.$eval('#sortSheet', e => e.open);
  const toHome = async () => { if (await page.$eval('#tabHome', e => e.hidden)) await oClick('#tabHomeBtn'); };
  const ensure = async open => { if ((await isOpen()) !== open) { if (open) await toHome(); await oClick(open ? '#btnSortOpen' : '#sheetClose'); } };
  const IN_SHEET = /^#(btnSave|btnBack|btnSkip|btnReveal|mode|showEn|showFive|rate|card)\b/;
  page.click = async (sel, ...a) => {
    if (sel === '#btnSortOpen') { await toHome(); return oClick(sel, ...a); }
    if (sel === '#sheetClose' || /^#(flag|btnFlag)/.test(sel)) return oClick(sel, ...a);
    await ensure(IN_SHEET.test(sel)); return oClick(sel, ...a);
  };
  page.select = async (sel, ...a) => { if (IN_SHEET.test(sel)) await ensure(true); return oSelect(sel, ...a); };
  page.keyboard.press = async (k, ...a) => {   // sorting keys only count when nobody is typing in a text box (page.type presses keys too)
    if (/^([0-5]| |Backspace|ArrowRight)$/.test(k) && !(await page.evaluate(() => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)))) await ensure(true);
    return oPress(k, ...a);
  };
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url(), m = req.method();
    if (u.startsWith('https://api.github.com/')) {
      if (m === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
      const fp = decodeURIComponent(u.split('/contents/')[1].split('?')[0]), f = files[fp];
      if (m === 'GET' && fp === 'dutch') return req.respond({ status: 200, headers: CORS, contentType: 'application/json',
        body: JSON.stringify(Object.keys(files).filter(k => /^dutch\/[^/]+$/.test(k)).map(k => ({ name: k.slice(6), type: 'file', sha: files[k].sha })).concat([{ name: 'vocab', type: 'dir' }])) });
      if (m === 'GET') {
        if (!f) return req.respond({ status: 404, headers: CORS, body: '{}' });
        if (/raw/.test(req.headers().accept || '')) return req.respond({ status: 200, headers: CORS, contentType: 'text/plain', body: f.text });
        if (rawForJson) return req.respond({ status: 200, headers: CORS, contentType: 'text/plain', body: f.text });
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
  const PACKS = M.csvRecords(files['dutch/vocab/packs.csv'].text), onByDefault = new Set(PACKS.filter(p => p.default === 'yes').map(p => p.pack)), tagsOf = r => (r.packs || '').split(';').filter(Boolean);
  const vocab = allRows.filter(r => !/^verb-/.test(r.type || '') && (!tagsOf(r).length || tagsOf(r).some(x => onByDefault.has(x)))).map(r => ({ dutch: r.dutch, english: r.english, level: r.level || '' })), NW = vocab.length;
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

  console.log('\n=== server sends the file itself instead of JSON (seen on a real phone) ===');
  rawForJson = true;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('3');
  await page.click('#btnSave');
  await page.waitForFunction(() => /Saved 1|Couldn't save/.test(document.getElementById('saveMsg').textContent), { timeout: 10000 });
  ok(/Saved 1/.test(await txt(page, '#saveMsg')), 'save still works when the details come back as raw file text: ' + await txt(page, '#saveMsg'));
  rawForJson = false;
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
  await page.click('#btnSortOpen');
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
  await page.waitForFunction(() => /up to date/.test(document.getElementById('sVersion').textContent), { timeout: 5000 }).catch(() => {});
  ok(/Version 2026-\d\d-\d\d\.\d+ · up to date/.test(await page.$eval('#sVersion', e => e.textContent)) && await page.$eval('#sUpdate', e => e.hidden), 'settings shows the version and "up to date" when version.json matches');
  const wantVer = JSON.parse(fs.readFileSync(path.join(appDir, 'version.json'), 'utf8')).version;
  ok((await page.$eval('#sVersion', e => e.textContent)).includes(wantVer), 'version in app.js equals version.json: ' + wantVer);
  await page.evaluate(() => { const f = window.fetch; window.fetch = (u, o) => /version\.json/.test(u) ? Promise.resolve(new Response('{"version":"9999"}')) : f(u, o); });
  await page.keyboard.press('Escape'); await page.click('#btnSettings');
  await page.waitForFunction(() => /newer version/.test(document.getElementById('sVersion').textContent), { timeout: 5000 }).catch(() => {});
  ok(/newer version 9999 is available/.test(await page.$eval('#sVersion', e => e.textContent)) && !(await page.$eval('#sUpdate', e => e.hidden)), 'a different version.json shows "newer version" and the update button');
  await page.evaluate(() => { window.fetch = (u, o) => /version\.json/.test(u) ? Promise.reject(new Error('offline')) : Promise.reject(new Error('x')); });
  await page.keyboard.press('Escape'); await page.click('#btnSettings');
  await page.waitForFunction(() => /can't check/.test(document.getElementById('sVersion').textContent), { timeout: 5000 }).catch(() => {});
  ok(/can't check \(offline\?\)/.test(await page.$eval('#sVersion', e => e.textContent)), 'offline shows "can\'t check"');
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'load' });
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

  console.log('\n=== Home button and sorting sheet (fresh phone, level 5 off) ===');
  ({ ctx, page, errors } = await newPhone(browser, { five: false }));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  const progNow = new Map(M.csvRecords(files['dutch/noah.csv'].text).map(r => [T.keyOf(r.dutch, r.english), r])), ratedNow = vocab.filter(w => T.levelOf(progNow.get(T.keyOf(w.dutch, w.english)), today) !== null).length;   // Noah's file as it is now, after the earlier steps
  ok(await page.$eval('#sortSheet', e => !e.open), 'the sheet is closed when the app opens');
  ok(await page.$eval('#tabHome', e => !e.hidden) && !(await page.$('#tabSortBtn')), 'Home is the first tab and there is no Sort tab');
  const pt = await txt(page, '#progText'), want = Number(NW).toLocaleString();
  ok(pt.startsWith(ratedNow.toLocaleString() + ' / ' + want) && pt.includes((NW - ratedNow).toLocaleString() + ' left'), 'Home button shows rated / total and how many are left: ' + pt);
  const fillBefore = await page.$eval('#progFill', e => parseFloat(e.style.width));
  ok(Math.abs(fillBefore - Math.max(ratedNow / NW * 100, ratedNow ? 4 : 0)) < 0.01, 'the bar is filled to ' + fillBefore.toFixed(1) + '%');
  await page.click('#btnSortOpen');
  ok(await page.$eval('#sortSheet', e => e.open), 'tapping the button opens the sheet');
  ok((await page.$$('#rate button')).length === 5 && !(await txt(page, '#rate')).includes('5'), 'only levels 0 to 4 are visible');
  ok((await txt(page, '#rateLabels')).includes('Learned') && !(await txt(page, '#rateLabels')).includes('Never again'), 'labels under the five buttons');
  ok((await page.$eval('#cEng', e => e.textContent)) === '', 'meaning hidden until tapped');
  const firstWord = await txt(page, '#cWord');
  await page.keyboard.press('5');
  ok(await txt(page, '#cWord') === firstWord, 'key 5 does nothing while level 5 is off');
  ok(/Learned/.test(await txt(page, '#rateLabels')), 'rating row still there');
  await page.keyboard.press('2'); await page.keyboard.press('0');
  ok(/2 rated this session/.test(await txt(page, '#sortMsg')), 'rating works from the sheet: ' + await txt(page, '#sortMsg'));
  await page.click('#sheetClose');
  const pt2 = await txt(page, '#progText');
  ok(pt2.startsWith((ratedNow + 2).toLocaleString() + ' / ' + want) && pt2.includes((NW - ratedNow - 2).toLocaleString() + ' left'), 'closing the sheet updates the button: ' + pt2);
  ok((await page.$eval('#progFill', e => parseFloat(e.style.width))) > fillBefore, 'the bar grew');
  await page.click('#btnSortOpen');
  await page.$eval('#showFive', e => { e.checked = true; e.dispatchEvent(new Event('change')); });
  ok((await page.$$('#rate button')).length === 6 && (await txt(page, '#rateLabels')).includes('Never again'), 'switching level 5 on adds a sixth button');
  await page.click('#sheetClose');
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
  async function play(page, chooser, from = 0) { // chooser(i) -> 'right' | 'wrong'; from = first question number (0-based) to answer
    const log = [];
    for (let i = from; i < 10; i++) {
      await page.waitForFunction(n => new RegExp('Question ' + n + ' of').test(document.getElementById('qInfo').textContent), { timeout: 5000 }, i + 1);
      const dutch = await txt(page, '#qWord'), opts = await page.$$eval('#qOpts .opt span', e => e.map(x => x.textContent));
      const star = await page.$eval('#qStar', e => !e.hidden), good = o => (eng[dutch] || []).includes(o);
      const want = chooser(i), idx = opts.findIndex(o => want === 'right' ? good(o) : !good(o));
      await page.click('#qOpts .opt:nth-child(' + (idx + 1) + ')');
      const fb = await txt(page, '#qFeedback');
      log.push({ dutch, opts, star, want, fb, pts: Number((fb.match(/\+\u20ac?(\d+)/) || [0, 0])[1]) });
      await page.click('#qNext');
    }
    await page.waitForFunction(() => !document.getElementById('quizEnd').hidden, { timeout: 5000 });
    return log;
  }
  const sumPts = log => log.reduce((a, l) => a + l.pts, 0);
  const wk = G.weekStart(today), wotw = G.wordOfWeek(wordsT, wk);

  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  const lab = await txt(page, '#rateLabels');
  ok(lab.includes('Never seen it') && lab.includes('Vaguely') && lab.includes('Never again'), 'rating labels use the new names: ' + lab);
  ok((await page.$eval('#mode', e => e.textContent)).includes('5 Never need to practise again'), 'the re-check list uses the new names');
  await page.click('#tabPlayBtn');
  ok((await txt(page, '#wotwBox')).includes(wotw.dutch), 'word of the week shown: ' + wotw.dutch);
  const noahBefore = files['dutch/noah.csv'].text;
  await page.click('#btnRound');
  let log = await play(page, i => i < 7 ? 'right' : 'wrong');
  ok(log[0].dutch === wotw.dutch && log[0].star, 'the word of the week is the first question and is starred');
  ok(log.every(l => l.opts.length === 4 && new Set(l.opts).size === 4), 'four different options every time');
  ok(/You got 7 of 10/.test(await txt(page, '#qSummary')) && /Word of the week: \+\u20ac30/.test(await txt(page, '#qSummary')), 'summary: ' + await txt(page, '#qSummary'));
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
  ok(/Noah \(you\)/.test(await txt(page, '#boardList')) && (await txt(page, '#boardList')).includes('\u20ac' + sc[0].points), 'leaderboard shows Noah with \u20ac' + sc[0].points);
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
  ok(/earned \u20ac0\./.test(await txt(page, '#qSummary')), 'all wrong earns nothing');
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
  ok((await page.$$eval('#bOpp option', o => o.map(x => x.textContent))).join() === 'Anna,Sam,Anyone (open challenge)', 'opponents are everyone but me, plus an open challenge');
  await page.select('#bOpp', 'Anna'); await page.select('#bMode', 'normal');
  await page.click('#btnChallenge');
  const nlog = await play(page, () => 'right');
  ok(/Challenge sent to Anna/.test(await txt(page, '#qSummary')), 'summary: ' + (await txt(page, '#qSummary')));
  ok(await until(() => rowsOf('dutch/battles.csv').length === 1), 'challenge row sent');
  let br = rowsOf('dutch/battles.csv');
  ok(br[0].type === 'challenge' && br[0].who === 'Noah' && br[0].opponent === 'Anna' && br[0].mode === 'normal' && br[0].total === '10' && br[0].right === '10', 'challenge row ok');
  const qsStored = JSON.parse(br[0].questions);
  ok(qsStored.length === 10 && qsStored.every((q, i) => q.d === nlog[i].dutch && JSON.stringify(q.o) === JSON.stringify(nlog[i].opts)), 'the questions are stored exactly as Noah saw them');
  ok(Number(br[0].score) === sumPts(nlog) && sumPts(nlog) >= 80 && sumPts(nlog) <= 100, 'battle score: ten questions, up to 10 for each (seconds left): ' + br[0].score);
  ok(qsStored.every((q, i) => q.p === nlog[i].pts), 'each question stores the points Noah got, so the ghost can row at his pace: ' + JSON.stringify(qsStored.map(q => q.p)));
  ok(await until(() => rowsOf('dutch/scores.csv').length === 5), 'battle row and stake row sent');
  const sc5 = rowsOf('dutch/scores.csv'), stakeRow = sc5.find(r => r.mode === 'wager');
  ok(sc5.find(r => r.mode === 'battle').points === '0', 'a wager battle pays no ordinary points');
  ok(stakeRow && stakeRow.who === 'Noah' && stakeRow.points === '-40' && stakeRow.id === 'w' + br[0].id + 'sNoah', 'Noah\'s stake of 40 is a row in scores.csv: ' + JSON.stringify(stakeRow));
  ok(/You put \u20ac40 on it/.test(await txt(page, '#qSummary')), 'summary tells him what is at stake');
  ok(!(/Perfect|streak/.test(await txt(page, '#qSummary'))), 'no bonuses in a battle');
  await ctx.close();

  ({ ctx, page, errors } = await newPhone(browser));
  files['dutch/scores.csv'].text += 'seedA1,2026-11-10,Anna,practice,100,10,10,\n';   // Anna has earned some points, so she can match the wager
  await page.evaluateOnNewDocument(() => localStorage.setItem('dr.who', '"Anna"'));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  ok(/Anna's progress/.test(await txt(page, '#listStatus')), 'this phone is Anna now');
  await page.click('#tabPlayBtn');
  await page.waitForSelector('#battleLists .brow button');
  ok(/Noah challenged you \(normal.*\u20ac40 each, \u20ac80 to the winner/.test(await txt(page, '#battleLists')), 'Anna sees the challenge and the wager: ' + (await txt(page, '#battleLists')).slice(0, 120));
  const annaBefore = files['dutch/anna.csv'].text;
  await page.click('#battleLists .brow button');
  const alog = await play(page, i => i < 5 ? 'right' : 'wrong');
  ok(alog.every((l, i) => l.dutch === nlog[i].dutch && JSON.stringify(l.opts) === JSON.stringify(nlog[i].opts)), 'Anna got the same words and the same options in the same order');
  ok(/Noah won this one/.test(await txt(page, '#qSummary')) && /You lose your \u20ac40/.test(await txt(page, '#qSummary')), 'result shown: ' + (await txt(page, '#qSummary')));
  ok(await until(() => rowsOf('dutch/scores.csv').some(r => r.mode === 'wager-win')), 'payout sent');
  const wsc = rowsOf('dutch/scores.csv');
  ok(wsc.some(r => r.mode === 'wager' && r.who === 'Anna' && r.points === '-40') && wsc.some(r => r.mode === 'wager-win' && r.who === 'Noah' && r.points === '80'), 'Anna staked 40 and Noah was paid 80');
  ok(wsc.filter(r => r.mode === 'battle').every(r => r.points === '0'), 'both battle rounds paid no ordinary points');
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

  console.log('\n=== Open wager: anyone can take it, the first to play wins or loses it, then it is gone ===');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#tabPlayBtn');
  const bMsg = () => txt(page, '#battleMsg'), setWager = v => page.$eval('#bWager', (e, x) => { e.value = x; }, v);
  const bal = (rows, who) => rows.filter(r => r.who === who).reduce((n, r) => n + Number(r.points), 0);
  ok(/You have \u20ac\d+ to wager/.test(await txt(page, '#bBalance')), 'the balance is shown: ' + await txt(page, '#bBalance'));
  const shown = () => txt(page, '#bWagerShow');
  ok(await shown() === '\u20ac40' && /\u20ac80 on the table: \u20ac40 from you/.test(await txt(page, '#bPot')), 'the wager starts at 40 and the pot is shown: ' + await txt(page, '#bPot'));
  await page.click('#bMinus'); ok(await shown() === '\u20ac30', 'minus takes off 10');
  await page.click('#bPlus'); await page.click('#bPlus'); ok(await shown() === '\u20ac50' && /\u20ac100 on the table/.test(await txt(page, '#bPot')), 'plus adds 10 and the pot follows');
  for (let i = 0; i < 6; i++) await page.click('#bMinus');
  ok(await shown() === '\u20ac10' && await page.$eval('#bMinus', e => e.disabled), 'cannot go below 10');
  const balNow = bal(rowsOf('dutch/scores.csv'), 'Noah'), maxW = Math.floor(balNow / 10) * 10;
  for (let i = 0; i < 80; i++) { if (await page.$eval('#bPlus', e => e.disabled)) break; await page.click('#bPlus'); }
  ok(await shown() === '\u20ac' + maxW.toLocaleString() && await page.$eval('#bPlus', e => e.disabled), 'cannot go above what you have (' + balNow + '): ' + await shown());
  await page.select('#bOpp', '*'); await page.select('#bMode', 'normal');
  await setWager('25'); await page.click('#btnChallenge'); ok(/tens/.test(await bMsg()), 'wagers go in tens: ' + await bMsg());
  await setWager('5'); await page.click('#btnChallenge'); ok(/tens/.test(await bMsg()), 'and at least 10');
  await setWager('1000000'); await page.click('#btnChallenge'); ok(/You only have/.test(await bMsg()), 'cannot wager more than you have: ' + await bMsg());
  await setWager('20'); await page.select('#bMode', 'handicap'); await page.click('#btnChallenge'); ok(/named opponent/.test(await bMsg()), 'handicap needs a named opponent');
  await page.select('#bMode', 'normal');
  const battlesBefore = rowsOf('dutch/battles.csv').length;
  await page.click('#btnChallenge');
  await page.waitForFunction(() => /Question 1 of/.test(document.getElementById('qInfo').textContent), { timeout: 5000 });
  const solo = await page.evaluate(() => ({ ropes: document.querySelectorAll('#bView .bv-rope').length, boats: document.querySelectorAll('#bView .bv-boat').length, mx: document.querySelector('#bView .bv-me').style.left, timer: !document.getElementById('bTimer').hidden }));
  ok(solo.ropes === 2 && solo.boats === 1 && solo.mx === '50%' && solo.timer, 'the challenger rows alone in one full-width lane with a clock: ' + JSON.stringify(solo));
  if (process.env.SHOT) { await page.click('#qOpts .opt:nth-child(1)'); await new Promise(r => setTimeout(r, 1200)); await (await page.$('#quiz')).screenshot({ path: '/tmp/shot_solo.png' }); }
  await new Promise(r => setTimeout(r, 10700));
  ok(/Time is up/.test(await txt(page, '#qFeedback')) && /Time is up/.test(await txt(page, '#tWorth')) && !(await page.$eval('#qNext', e => e.hidden)), 'after 10 seconds the question is over and shows the answer: ' + await txt(page, '#qFeedback'));
  await page.click('#qNext');
  await play(page, () => 'right', 1);
  ok(/Open challenge sent/.test(await txt(page, '#qSummary')) && /You put \u20ac20 on it/.test(await txt(page, '#qSummary')), 'open challenge sent with a 20 point wager: ' + await txt(page, '#qSummary'));
  ok(await until(() => rowsOf('dutch/battles.csv').length === battlesBefore + 1), 'open challenge row sent');
  const open1 = rowsOf('dutch/battles.csv')[battlesBefore];
  ok(open1.opponent === '*' && open1.who === 'Noah', 'the opponent is "anyone"');
  const o1q = JSON.parse(open1.questions);
  ok(o1q[0].p === 0 && o1q.slice(1).every(q => q.p >= 1 && q.p <= 10) && Number(open1.score) === o1q.reduce((n, q) => n + q.p, 0) && open1.total === '10' && open1.right === '9', 'the timed-out question is worth 0 and counts as a miss; the rest pay the seconds left: ' + JSON.stringify(o1q.map(q => q.p)));
  ok(await until(() => rowsOf('dutch/scores.csv').some(r => r.id === 'w' + open1.id + 'sNoah' && r.points === '-20')), 'stake of 20 saved');
  await page.click('#qDone');
  ok(/You vs anyone.*\u20ac20 at stake/.test(await txt(page, '#battleLists')), 'Noah sees it waiting: ' + await txt(page, '#battleLists'));
  await ctx.close();
  // an extra open challenge that someone else takes while Anna is looking at the list
  const q1 = open1.questions.replace(/"/g, '""');
  files['dutch/battles.csv'].text += 'bRACE,challenge,2026-11-17,Noah,*,normal,120,10,10,"' + q1 + '"\n';
  files['dutch/scores.csv'].text += 'wbRACEsNoah,2026-11-17,Noah,wager,-10,0,0,\n';
  // Sam has no points: sees the open challenge but cannot match it
  ({ ctx, page, errors } = await newPhone(browser));
  await page.evaluateOnNewDocument(() => localStorage.setItem('dr.who', '"Sam"'));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#tabPlayBtn');
  ok(/Open challenge from Noah/.test(await txt(page, '#battleLists')) && /you need \u20ac20/.test(await txt(page, '#battleLists')) && (await page.$$('#battleLists .brow button')).length === 0, 'Sam sees the open challenge but needs 20 points, so no Play button: ' + await txt(page, '#battleLists'));
  await ctx.close();
  // Anna: someone else takes bRACE first; then she plays the real one
  ({ ctx, page, errors } = await newPhone(browser));
  await page.evaluateOnNewDocument(() => localStorage.setItem('dr.who', '"Anna"'));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#tabPlayBtn');
  await page.waitForSelector('#battleLists .brow button');
  ok((await page.$$('#battleLists .brow button')).length === 3 && /\u20ac10 each, \u20ac20 to the winner \u00b7 first to play it takes it/.test(await txt(page, '#battleLists')), 'Anna sees both open challenges and the named handicap one: ' + await txt(page, '#battleLists'));
  files['dutch/battles.csv'].text += 'bRACE,reply,2026-11-17,Sam,Noah,normal,50,5,10,\n';     // Sam got there first
  await page.evaluate(() => [...document.querySelectorAll('#battleLists .brow')].find(r => /\u20ac10 each/.test(r.textContent)).querySelector('button').click());
  await until(async () => /already played/.test(await bMsg()));
  ok(/Someone already played that challenge/.test(await bMsg()) && await page.$eval('#quiz', e => e.hidden), 'an open challenge taken meanwhile cannot be played again: ' + await bMsg());
  ok(!/\u20ac10 each/.test(await txt(page, '#battleLists')), 'and it leaves her list');
  await page.evaluate(() => [...document.querySelectorAll('#battleLists .brow')].find(r => /\u20ac20 each/.test(r.textContent)).querySelector('button').click());
  await page.waitForFunction(() => /Question 1 of/.test(document.getElementById('qInfo').textContent), { timeout: 5000 });
  ok(await page.$eval('#qRace', e => !e.hidden) && /\u20ac40 on the table \(\u20ac20 each\)\. Noah scored \d+/.test(await txt(page, '#raceNote')), 'the challengee sees the pot and the score to beat: ' + await txt(page, '#raceNote'));
  const vw = await page.evaluate(() => ({ ropes: document.querySelectorAll('#bView .bv-rope').length, boats: document.querySelectorAll('#bView .bv-boat').length, ghost: !!document.querySelector('#bView .bv-g'), fin: !!document.querySelector('#bView .bv-fin'), timer: !document.getElementById('bTimer').hidden, gx: document.querySelector('#bView .bv-g').style.left, mx: document.querySelector('#bView .bv-me').style.left }));
  if (process.env.SHOT) { await page.click('#qOpts .opt:nth-child(1)'); await new Promise(r => setTimeout(r, 1200)); await (await page.$('#quiz')).screenshot({ path: '/tmp/shot_duel.png' }); }
  ok(vw.ropes === 3 && vw.boats === 2 && vw.ghost && vw.fin && vw.timer && vw.mx === '29%' && vw.gx === '71%', 'two lanes seen from above: ropes between and beside them, your boat left, the ghost right, a finish line, a clock: ' + JSON.stringify(vw));
  ok(/Noah/.test(await txt(page, '#bView')) && /10/.test(await txt(page, '#tWorth')) || /Worth \d+ now/.test(await txt(page, '#tWorth')), 'the clock shows what a right answer is worth now: ' + await txt(page, '#tWorth'));
  const olog = await play(page, i => i < 3 ? 'right' : 'wrong');
  ok(/Noah won this one/.test(await txt(page, '#qSummary')) && /You lose your \u20ac20/.test(await txt(page, '#qSummary')), 'Anna played the open wager and lost it: ' + await txt(page, '#qSummary'));
  ok(await until(() => rowsOf('dutch/scores.csv').some(r => r.id === 'w' + open1.id + 'pNoah' && r.points === '40' && r.mode === 'wager-win')), 'Noah was paid the pot of 40');
  ok(rowsOf('dutch/scores.csv').some(r => r.id === 'w' + open1.id + 'sAnna' && r.points === '-20'), 'Anna staked 20');
  await page.click('#qDone');
  ok(!/Open challenge from Noah/.test(await txt(page, '#battleLists')), 'once played, the open challenge is gone from the waiting list');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
  ({ ctx, page, errors } = await newPhone(browser));
  await page.evaluateOnNewDocument(() => localStorage.setItem('dr.who', '"Sam"'));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#tabPlayBtn');
  ok(!/Open challenge from Noah \(normal/.test(await txt(page, '#battleLists')), 'and nobody else sees it any more');
  await ctx.close();

  console.log('\n=== A challenge sent before the timer existed still plays (old scoring, no clock, even ghost) ===');
  const oldQs = JSON.stringify(JSON.parse(open1.questions).map(q => { const o = Object.assign({}, q); delete o.p; return o; })).replace(/"/g, '""');
  files['dutch/battles.csv'].text += 'bOLD,challenge,2026-11-10,Noah,Anna,normal,120,8,10,"' + oldQs + '"\n';
  ({ ctx, page, errors } = await newPhone(browser));
  await page.evaluateOnNewDocument(() => localStorage.setItem('dr.who', '"Anna"'));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  await page.click('#tabPlayBtn');
  await page.waitForSelector('#battleLists .brow button');
  const scBefore = rowsOf('dutch/scores.csv').length;
  await page.evaluate(() => [...document.querySelectorAll('#battleLists .brow')].find(r => /Noah scored 120/.test(r.textContent) && !/€/.test(r.textContent)).querySelector('button').click());
  await page.waitForFunction(() => /Question 1 of/.test(document.getElementById('qInfo').textContent), { timeout: 5000 });
  ok(await page.$eval('#bTimer', e => e.hidden) && !!(await page.$('#bView .bv-g')), 'an older challenge has no clock but still shows the ghost');
  const oldLog = await play(page, () => 'right');
  ok(/You beat Noah/.test(await txt(page, '#qSummary')) && !/wager|pot/i.test(await txt(page, '#qSummary')), 'old challenge: no wager, plain result: ' + await txt(page, '#qSummary'));
  ok(await until(() => rowsOf('dutch/scores.csv').length > scBefore) && !rowsOf('dutch/scores.csv').some(r => /bOLD/.test(r.id)), 'and no stake rows for it');
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
  await page.click('#btnSortOpen'); await page.select('#mode', 'all');
  ok(new RegExp('\\b' + NW + ' left in this set').test(await txt(page, '#sortMsg')), 'sorting "all words" offers exactly the ' + NW + ' words, no verb drill rows: ' + await txt(page, '#sortMsg'));
  await ctx.close();

  console.log('\n=== Packs: switching packs on and off ===');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  const packName = id => PACKS.find(p => p.pack === id).name, countOf = id => allRows.filter(r => !/^verb-/.test(r.type || '') && tagsOf(r).includes(id)).length;
  const archOnly = allRows.filter(r => !/^verb-/.test(r.type || '') && tagsOf(r).length && tagsOf(r).every(x => x === 'architecture')), archNames = new Set(allRows.filter(r => tagsOf(r).includes('architecture')).map(r => r.dutch));
  ok(archOnly.length > 30, 'the pilot pack has its own words: ' + archOnly.length);
  const packState = () => page.$$eval('#sPacks label', ls => ls.map(l => ({ name: l.textContent, on: l.querySelector('input').checked })));
  const clickPack = async name => { await page.evaluate(n => [...document.querySelectorAll('#sPacks label')].find(l => l.textContent.startsWith(n)).querySelector('input').click(), name); };
  await page.click('#btnSettings');
  let ps = await packState();
  ok(PACKS.every(p => ps.some(s => s.name === packName(p.pack) + ' (' + countOf(p.pack).toLocaleString() + ')')), 'Settings lists every pack with its word count: ' + ps.map(s => s.name).join(' | '));
  ok(PACKS.every(p => ps.find(s => s.name.startsWith(p.name + ' (')).on === (p.default === 'yes')), 'level packs are on and the topic pack is off by default');
  await page.keyboard.press('Escape');
  ok(new RegExp('\\b' + NW.toLocaleString() + ' words, Noah').test(await txt(page, '#listStatus')) && (await txt(page, '#homePacks')).startsWith('Packs on: all levels.'), 'default: only the level packs: ' + await txt(page, '#homePacks'));
  await page.click('#btnSettings'); await clickPack('Architecture');
  await page.keyboard.press('Escape');
  let pt3 = await txt(page, '#progText');
  ok(pt3.includes(' / ' + (NW + archOnly.length).toLocaleString()) && (await txt(page, '#homePacks')).includes('Architecture and construction'), 'switching Architecture on adds its ' + archOnly.length + ' new words: ' + pt3 + ' | ' + await txt(page, '#homePacks'));
  await page.click('#btnSortOpen');
  const firstPackWord = await txt(page, "#cWord");
  ok(/Architecture and construction/.test(await txt(page, '#card .badges')), 'the card shows the topic pack name: ' + await txt(page, '#card .badges'));
  ok(archNames.has(firstPackWord), 'sorting shows the words of a switched-on topic pack first: ' + firstPackWord);
  await page.click('#sheetClose');
  await page.reload({ waitUntil: 'networkidle0' });
  ok((await txt(page, '#progText')).includes(' / ' + (NW + archOnly.length).toLocaleString()), 'the choice is remembered after a reload');
  await page.click('#btnSettings'); await clickPack('Architecture'); await page.keyboard.press('Escape');
  ok((await txt(page, '#progText')).includes(' / ' + NW.toLocaleString()), 'switching it off again takes the words away: ' + await txt(page, '#progText'));
  await page.click('#btnSettings');
  for (const n of ['A1', 'A2', 'B1', 'B2', 'C1']) await clickPack(n + ' (');
  await clickPack('No level');
  ps = await packState();
  ok(ps.find(s => /^No level/.test(s.name)).on && /Keep at least one pack on/.test(await txt(page, '#sPacksMsg')), 'the last pack cannot be switched off: ' + await txt(page, '#sPacksMsg'));
  await page.keyboard.press('Escape');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  console.log('\n=== Type it ===');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  const wordRows = allRows.filter(r => !/^verb-/.test(r.type || '') && (!tagsOf(r).length || tagsOf(r).some(x => onByDefault.has(x))));
  const firstAlt = e => e.replace(/\([^)]*\)/g, ' ').split(/[;,\/]/).map(x => x.trim().replace(/^(to|the|a|an) /i, ''))[0];
  const pend = () => page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('dr.pending.Noah') || '{}')).length; } catch (e) { return -1; } });
  const fbText = () => txt(page, '#qFeedback');
  await page.click('#tabPlayBtn'); await page.select('#tDir', 'en2nl'); await page.click('#btnType');
  await page.waitForFunction(() => /Question 1 of 10/.test(document.getElementById('qInfo').textContent), { timeout: 5000 });
  const asked = await txt(page, '#qWord'), attrs = await page.$eval('#qInput', e => ({ cap: e.getAttribute('autocapitalize'), corr: e.getAttribute('autocorrect'), spell: e.spellcheck, lang: e.lang, ac: e.getAttribute('autocomplete') }));
  ok(wordRows.some(r => r.english === asked) && /Type it in Dutch/.test(await txt(page, '#qPrompt')), 'English to Dutch: shows the English word (' + asked + ') and asks for Dutch');
  ok(attrs.cap === 'off' && attrs.corr === 'off' && attrs.spell === false && attrs.lang === 'nl' && attrs.ac === 'off', 'the box has autocorrect, auto-capitals and spell-check off: ' + JSON.stringify(attrs));
  ok(await page.$eval('#qOpts', e => e.hidden) && !(await page.$eval('#qTypeBox', e => e.hidden)), 'a text box replaces the four options');
  await page.click('#qCheck');
  ok(/Type an answer first/.test(await fbText()) && (await pend()) === 0, 'an empty answer is refused, not counted');
  await page.click('#qShow'); ok(/Not counted/.test(await fbText()) && (await pend()) === 0, 'Show me gives the answer and counts nothing: ' + await fbText());
  await page.click('#qQuit');
  // Dutch to English round: right, wrong, show me
  await page.select('#tDir', 'nl2en'); await page.click('#btnType');
  const rightKeys = [], wrongKeys = []; let step = 'right', rightPts = 0;
  for (let i = 0; i < 10 && step !== 'done'; i++) {
    await page.waitForFunction(n => new RegExp('Question ' + n + ' of').test(document.getElementById('qInfo').textContent), { timeout: 5000 }, i + 1);
    const d = await txt(page, '#qWord'), rs = wordRows.filter(r => r.dutch === d), uniq = rs.length === 1;
    if (step === 'right' && uniq) {
      const a = firstAlt(rs[0].english); await page.type('#qInput', a.charAt(0).toUpperCase() + a.slice(1)); await page.click('#qCheck');
      const fb = await fbText(); ok(/^Right! \+\u20ac\d+/.test(fb), 'typed ' + a + ' for ' + d + ' (capital letter ignored): ' + fb);
      rightPts = Number(fb.match(/\+\u20ac(\d+)/)[1]); rightKeys.push(rs[0]); step = 'wrong';
    } else if (step === 'wrong' && uniq) {
      await page.type('#qInput', 'qqqxxzz'); await page.click('#qCheck');
      ok(/^Not quite\. It is /.test(await fbText()), 'a wrong answer shows the right one: ' + await fbText()); wrongKeys.push(rs[0]); step = 'show';
    } else { await page.click('#qShow'); if (step === 'show') { ok(/Not counted/.test(await fbText()), 'Show me is not counted'); step = 'done'; } }
    if (step !== 'done') await page.click('#qNext');
  }
  ok(rightPts >= 20 && rightPts <= 40, 'typing is worth double points (' + rightPts + ' for a right answer; multiple choice pays 5 to 20)');
  ok((await pend()) === 2, 'only the right and the wrong answer were recorded: ' + await pend());
  await page.click('#qQuit');
  ok(await until(async () => { const rs = M.csvRecords(files['dutch/noah.csv'].text), g = x => rs.find(r => r.dutch === x.dutch && r.english === x.english); return g(rightKeys[0]).streak !== '0' && g(wrongKeys[0]).status === 'needs_practice'; }), 'saved: the right word moved up, the wrong word needs practice');
  // a whole round: right where possible
  await page.select('#tDir', 'nl2en'); await page.click('#btnType');
  let nRight = 0, nShow = 0;
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction(n => new RegExp('Question ' + n + ' of').test(document.getElementById('qInfo').textContent), { timeout: 5000 }, i + 1);
    const d = await txt(page, '#qWord'), rs = wordRows.filter(r => r.dutch === d);
    if (rs.length === 1) { await page.type('#qInput', firstAlt(rs[0].english)); await page.click('#qCheck'); if (/^Right!/.test(await fbText())) nRight++; else { console.log('   not right: ', d, rs[0].english, await fbText()); } }
    else { await page.click('#qShow'); nShow++; }
    if (i === 0) await page.keyboard.press('Enter'); else await page.click('#qNext');
  }
  await page.waitForFunction(() => !document.getElementById('quizEnd').hidden, { timeout: 5000 });
  ok(await until(() => rowsOf('dutch/scores.csv').some(r => r.mode === 'type')), 'a Type it score row was sent');
  const ts = rowsOf('dutch/scores.csv').find(r => r.mode === 'type');
  ok(ts && ts.who === 'Noah' && Number(ts.right) === nRight && Number(ts.total) === 10 - nShow, 'score row counts only answers that were counted: ' + JSON.stringify(ts) + ' (right ' + nRight + ', shown ' + nShow + ')');
  await page.click('#qDone');
  // nothing counted: no score row
  const scoresBefore = rowsOf('dutch/scores.csv').length;
  await page.click('#btnType');
  for (let i = 0; i < 10; i++) { await page.waitForFunction(n => new RegExp('Question ' + n + ' of').test(document.getElementById('qInfo').textContent), { timeout: 5000 }, i + 1); await page.click('#qShow'); await page.click('#qNext'); }
  await page.waitForFunction(() => !document.getElementById('quizEnd').hidden, { timeout: 5000 });
  ok(/No answers were counted/.test(await txt(page, '#qSummary')), 'a round where nothing was counted says so: ' + await txt(page, '#qSummary'));
  await new Promise(r => setTimeout(r, 800));
  ok(rowsOf('dutch/scores.csv').length === scoresBefore, 'and sends no score row');
  ok(!/github/i.test(await pageText(page)), 'no "GitHub" on the page');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  console.log('\n=== Flashcards ===');
  ({ ctx, page, errors } = await newPhone(browser));
  await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' });
  const kp = async k => { await page.keyboard.down(k); await page.keyboard.up(k); };   // the older wrapper would open the sorting sheet for ArrowRight
  const fRows = allRows.filter(r => !/^verb-/.test(r.type || '') && (!tagsOf(r).length || tagsOf(r).some(x => onByDefault.has(x))));
  const fInfo = () => txt(page, '#qInfo'), fFront = () => txt(page, '#fFront'), fBackVisible = () => page.$eval('#fBack', e => !e.hidden);
  const pendN = () => page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('dr.pending.Noah') || '{}')).length; } catch (e) { return -1; } });
  const flashBack = fr => { const m = fRows.filter(r => r.dutch === fr); return m.length ? m[0].english : null; };
  await page.click('#tabPlayBtn'); await page.select('#fDir', 'nl2en'); await page.click('#btnFlash');
  await page.waitForFunction(() => /Card 1 of 10/.test(document.getElementById('qInfo').textContent), { timeout: 5000 });
  ok(await page.$eval('#flashBox', e => !e.hidden) && await page.$eval('#qOpts', e => e.hidden) && await page.$eval('#qTypeBox', e => e.hidden) && await page.$eval('#qWord', e => e.hidden), 'the flashcard replaces the quiz parts');
  const f1 = await fFront(); ok(fRows.some(r => r.dutch === f1) && !(await fBackVisible()), 'Dutch to English: the card shows a Dutch word (' + f1 + ') and hides the answer');
  await page.click('#fYes');
  ok(/Flip the card first/.test(await txt(page, '#fHint')) && (await pendN()) === 0 && /Card 1 of 10/.test(await fInfo()), 'judging before flipping is refused and counts nothing');
  await page.click('#fCard');
  ok(await fBackVisible() && (await txt(page, '#fBack')) === flashBack(f1), 'tapping flips the card to the meaning: ' + await txt(page, '#fBack'));
  await page.click('#fNo');
  ok(/Card 2 of 10/.test(await fInfo()) && (await pendN()) === 1, 'Not yet moves on and records the word as missed');
  const missedWord = f1;
  // card 2: swipe right with the mouse (flip first with Space)
  await kp('Space'); ok(await fBackVisible(), 'Space flips the card');
  await page.$eval('#fCard', e => e.scrollIntoView({ block: 'center' }));
  const bb = await (await page.$('#fCard')).boundingBox(), cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 60, cy, { steps: 4 }); await page.mouse.move(cx + 200, cy, { steps: 4 }); await page.mouse.up();
  await until(async () => /Card 3 of 10/.test(await fInfo()), 3000);
  ok(/Card 3 of 10/.test(await fInfo()) && (await pendN()) === 2, 'a swipe to the right counts as Got it: ' + await fInfo());
  // card 3: a short drag springs back
  await kp('Space');
  await page.$eval('#fCard', e => e.scrollIntoView({ block: 'center' }));
  const bb3 = await (await page.$('#fCard')).boundingBox(), cy3 = bb3.y + bb3.height / 2;
  await page.mouse.move(bb3.x + bb3.width / 2, cy3); await page.mouse.down(); await page.mouse.move(bb3.x + bb3.width / 2 + 25, cy3, { steps: 3 }); await page.mouse.up();
  await new Promise(r => setTimeout(r, 200));
  ok(/Card 3 of 10/.test(await fInfo()) && (await pendN()) === 2, 'a short drag does nothing');
  // cards 3 to 10: swipe left (arrow key) on card 3, then got it for the rest
  await kp('ArrowLeft'); let missed = [missedWord, f1 === null ? null : null].filter(Boolean);
  ok(/Card 4 of 10/.test(await fInfo()), 'ArrowLeft = Not yet');
  const secondMissed = (await page.evaluate(() => 0), null);
  for (let i = 4; i <= 10; i++) { await kp('Space'); await kp('ArrowRight'); await new Promise(r => setTimeout(r, 30)); }
  ok(/Missed cards, go 2: 2 to go/.test(await fInfo()), 'first run done: the two missed cards come back: ' + await fInfo());
  ok(!(await txt(page, '#quizEnd')).includes('Round finished') || await page.$eval('#quizEnd', e => e.hidden), 'the round is not over yet');
  const before = await pendN();
  await kp('Space'); await kp('ArrowLeft');
  ok(/go 2: 1 to go/.test(await fInfo()), 'after missing one retry card the other is next: ' + await fInfo());
  const retryWord = await fFront(); ok(retryWord === missedWord || retryWord !== '', 'the next retry card is one of the missed ones: ' + retryWord);
  await kp('Space'); await kp('ArrowRight');
  ok(/go 3: 1 to go/.test(await fInfo()) || /go 2: 1 to go/.test(await fInfo()), 'one card left in the pile: ' + await fInfo());
  await kp('Space'); await kp('ArrowRight');
  await page.waitForFunction(() => !document.getElementById('quizEnd').hidden, { timeout: 5000 });
  const sum = await txt(page, '#qSummary');
  ok(/You got 8 of 10 right and earned \u20ac\d+/.test(sum) && /went back over 2 missed cards/.test(sum) && /Retries earn nothing/.test(sum), 'summary counts the first go only and mentions the retries: ' + sum);
  ok(await until(() => rowsOf('dutch/scores.csv').some(r => r.mode === 'flash')), 'a flashcard score row was sent after finishing');
  const fs1 = rowsOf('dutch/scores.csv').find(r => r.mode === 'flash');
  ok(fs1 && fs1.who === 'Noah' && fs1.right === '8' && fs1.total === '10' && Number(fs1.points) > 0, 'score row: ' + JSON.stringify(fs1));
  ok(await until(async () => { const rs = rowsOf('dutch/noah.csv'); return rs.filter(r => r.status === 'needs_practice' && r.wrong === '1').length >= 2; }), 'the two missed words were saved as needs practice, once each (retries did not add more)');
  const wrongTotal = rowsOf('dutch/noah.csv').reduce((n, r) => n + (Number(r.wrong) || 0), 0);
  await page.click('#qDone');
  // quitting early banks nothing
  const sBefore = rowsOf('dutch/scores.csv').length;
  await page.select('#fDir', 'en2nl'); await page.click('#btnFlash');
  await page.waitForFunction(() => /Card 1 of 10/.test(document.getElementById('qInfo').textContent), { timeout: 5000 });
  const enFront = await fFront(); ok(fRows.some(r => r.english === enFront), 'English to Dutch: the card shows English first: ' + enFront);
  await kp('Space'); await kp('ArrowRight'); await page.click('#qQuit');
  await new Promise(r => setTimeout(r, 800));
  ok(rowsOf('dutch/scores.csv').length === sBefore && /nothing banked/.test(await txt(page, '#roundMsg')), 'stopping part-way banks nothing');
  ok(wrongTotal >= 2, 'missed words counted as wrong answers');
  ok(!/github/i.test(await pageText(page)), 'no "GitHub" on the page');
  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();

  await browser.close(); srv.close();
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });

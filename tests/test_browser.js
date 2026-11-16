// Real Chrome, fake GitHub. Run from a folder that has puppeteer-core installed:
//   node test_browser.js <app-folder> <vocab.csv> <image> [image...]
// Serves the app, answers api.github.com / Wiktionary with fakes, uploads an image, reads it with the
// real text reader, adds a word, sends it, and prints what would have been written to the inbox.
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const [appDir, vocabPath, ...images] = process.argv.slice(2);
const vocab = fs.readFileSync(vocabPath, 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.gz': 'application/gzip' };
const srv = http.createServer((q, s) => {
  let p = path.join(appDir, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, b) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); s.end(b); } });
});
let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok   ' : 'FAIL ', m); if (!c) fails++; };

(async () => {
  await new Promise(r => srv.listen(8765, r));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  for (const img of images) {
    console.log('\n=== image:', path.basename(img));
    const ctx = await browser.createBrowserContext(); // fresh phone each time
    const page = await ctx.newPage();
    await page.setViewport({ width: 400, height: 800 });
    const errors = [], puts = []; let inbox = null;
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('dr.token', '"fake-token"'); localStorage.setItem('dr.who', '"Noah"'); });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (u.startsWith('https://api.github.com/')) {
        if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        if (/dutch-vocab\.csv/.test(u)) return req.respond({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'text/plain', body: vocab });
        if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        if (/inbox\.csv/.test(u) && req.method() === 'GET') {
          if (!inbox) return req.respond({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
          return req.respond({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ sha: 'abc', content: Buffer.from(inbox).toString('base64') }) });
        }
        if (/inbox\.csv/.test(u) && req.method() === 'PUT') {
          const b = JSON.parse(req.postData()); puts.push(b); inbox = Buffer.from(b.content, 'base64').toString('utf8');
          return req.respond({ status: 201, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{}' });
        }
        return req.respond({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
      }
      if (u.startsWith('https://en.wiktionary.org/')) return req.respond({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json',
        body: JSON.stringify({ nl: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'A <a href="x">tortoise</a>, a land <i>turtle</i>.' }] }] }) });
      req.continue();
    });
    await page.goto('http://localhost:8765/', { waitUntil: 'networkidle0' });
    const status = await page.$eval('#listStatus', e => e.textContent);
    ok(/3,?018 words/.test(status), 'word list loaded: ' + status);

    const t0 = Date.now();
    const input = await page.$('#inPick');
    await input.uploadFile(img);
    await page.waitForFunction(() => /Done|Could not/.test(document.getElementById('ocrMsg').textContent), { timeout: 240000 });
    const msg = await page.$eval('#ocrMsg', e => e.textContent);
    console.log('OCR took', ((Date.now() - t0) / 1000).toFixed(1), 's |', msg);
    ok(/^Done/.test(msg), 'text reader finished');
    const text = await page.$eval('#txt', e => e.value);
    console.log('--- recognised text ---\n' + text + '-----------------------');
    const summary = await page.$eval('#results .card', e => e.textContent).catch(() => '');
    console.log('summary:', summary);
    const newWords = await page.$$eval('#results details.sec:first-of-type li .w', els => els.map(e => e.textContent));
    console.log('new words:', newWords.join(', '));
    ok(newWords.includes('schildpad'), '"schildpad" listed as new');

    // add schildpad with the Wiktionary suggestion
    await page.evaluate(() => [...document.querySelectorAll('#results li')].find(li => li.querySelector('.w').textContent === 'schildpad').click());
    await page.waitForSelector('#sheet[open]');
    await page.click('#btnLookup');
    await page.waitForFunction(() => document.getElementById('fEnglish').value.length > 0);
    const en = await page.$eval('#fEnglish', e => e.value);
    ok(/tortoise/.test(en) && !/</.test(en), 'lookup suggestion filled and HTML stripped: ' + en);
    await page.click('#btnAdd');
    await page.waitForFunction(() => !document.getElementById('sheet').open);
    ok((await page.$eval('#queueMsg', e => e.textContent)).startsWith('1 word'), 'queue shows 1 word');
    ok(!(await page.$$eval('#results details.sec:first-of-type li .w', els => els.map(e => e.textContent))).includes('schildpad'), 'added word leaves the new list');

    // add one typed by hand, then send
    await page.evaluate(() => [...document.querySelectorAll('#results li')].find(li => /aquarium|buurman/.test(li.querySelector('.w').textContent)).click());
    await page.waitForSelector('#sheet[open]');
    await page.type('#fEnglish', 'neighbour (man), "test"');
    await page.click('#btnAdd');
    await page.waitForFunction(() => !document.getElementById('sheet').open);
    await page.click('#btnSend');
    await page.waitForFunction(() => document.getElementById('queueBar').hidden, { timeout: 10000 });
    ok(puts.length === 1, 'one PUT to the inbox');
    console.log('inbox.csv would contain:\n' + inbox);
    ok(inbox.startsWith('dutch,english,phrase,who,date,source\n') && /schildpad,/.test(inbox) && /unreviewed/.test(inbox) && /"neighbour \(man\), ""test"""/.test(inbox), 'inbox format, quoting and unreviewed marker');
    ok(puts[0].message.includes('(Noah)') && !puts[0].sha, 'new file created without sha, commit message names Noah');

    // second send appends with sha
    await page.evaluate(() => [...document.querySelectorAll('#results li')].find(li => li.querySelector('.w'))?.click());
    await page.waitForSelector('#sheet[open]');
    await page.type('#fEnglish', 'second');
    await page.click('#btnAdd');
    await page.waitForFunction(() => !document.getElementById('sheet').open);
    await page.click('#btnSend');
    await page.waitForFunction(() => document.getElementById('queueBar').hidden, { timeout: 10000 });
    ok(puts.length === 2 && puts[1].sha === 'abc' && inbox.trim().split('\n').length === 4, 'second send appends to the existing inbox using its sha (4 lines total)');
    ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await ctx.close();
  }
  await browser.close(); srv.close();
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });

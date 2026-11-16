/* app.js: the screens. Photo -> text -> check against the word list -> add new words to a queue
   -> "Send" appends them to dutch/inbox.csv in the learning-progress repo (never edits the word list). */
(function () {
  'use strict';
  var M = window.Matcher;
  var CFG = { owner: 'dozer94-NZ', repo: 'learning-progress', vocab: 'dutch/vocab/dutch-vocab.csv',
              inbox: 'dutch/inbox.csv', api: 'https://api.github.com' };
  var INBOX_HEADER = 'dutch,english,phrase,who,date,source';
  var $ = function (id) { return document.getElementById(id); };

  // ---------- saved settings (on this phone only) ----------
  var mem = {};
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('dr.' + k); if (v !== null) return JSON.parse(v); } catch (e) {}
      return k in mem ? mem[k] : d;
    },
    set: function (k, v) { mem[k] = v; try { localStorage.setItem('dr.' + k, JSON.stringify(v)); } catch (e) {} }
  };
  var who = store.get('who', 'Noah');
  var token = store.get('token', '');
  var ignored = new Set(store.get('ignored', []));
  var queue = store.get('queue', []);
  var vocabCsv = store.get('vocabCsv', '');
  var inboxCsv = store.get('inboxCsv', '');
  var index = M.buildIndex([]);
  var listInfo = { vocab: 0, inbox: 0 };
  var last = null;       // last analysis
  var looked = false;    // meaning came from the Wiktionary suggestion and was not changed

  function h(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.appendChild(arguments[i]);
    return e;
  }
  function today() { return new Date().toLocaleDateString('sv-SE'); }

  // ---------- GitHub ----------
  function ghUrl(path) { return CFG.api + '/repos/' + CFG.owner + '/' + CFG.repo + '/contents/' + path; }
  function ghHeaders(raw) {
    var hd = { 'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
    if (token) hd.Authorization = 'Bearer ' + token;
    return hd;
  }
  async function ghGetRaw(path) {
    var r = await fetch(ghUrl(path), { headers: ghHeaders(true), cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub said ' + r.status);
    return r.text();
  }
  function fromB64(b) {
    var bin = atob(b.replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function toB64(text) {
    var bytes = new TextEncoder().encode(text), bin = '';
    for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  }
  async function ghGetJson(path) {
    var r = await fetch(ghUrl(path), { headers: ghHeaders(false), cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub said ' + r.status);
    var j = await r.json();
    return { sha: j.sha, text: fromB64(j.content || '') };
  }

  // ---------- the word list ----------
  function rebuildIndex() {
    var rows = vocabCsv ? M.csvRecords(vocabCsv) : [];
    listInfo.vocab = rows.length;
    var inboxRows = inboxCsv ? M.csvRecords(inboxCsv) : [];
    listInfo.inbox = inboxRows.length;
    index = M.buildIndex(rows.concat(inboxRows, queue).map(function (r) {
      return { dutch: r.dutch, english: r.english, type: r.type };
    }));
  }
  function setStatus(text, isErr) { var e = $('listStatus'); e.textContent = text; e.className = isErr ? 'err' : 'muted'; }
  function statusLine(note) {
    if (!listInfo.vocab) return 'No word list yet. Open Settings and add your GitHub token.';
    var s = 'Word list: ' + listInfo.vocab.toLocaleString() + ' words';
    if (listInfo.inbox) s += ' + ' + listInfo.inbox + ' waiting in the inbox';
    var f = store.get('fetched', '');
    if (f) s += ' (loaded ' + new Date(f).toLocaleString() + ')';
    return s + (note || '');
  }
  async function loadList() {
    setStatus('Loading word list…');
    var note = '', bad = false;
    if (token) {
      try {
        var v = await ghGetRaw(CFG.vocab);
        if (v === null) throw new Error('word list not found, check the token');
        var ib = await ghGetRaw(CFG.inbox);
        vocabCsv = v; inboxCsv = ib || '';
        store.set('vocabCsv', vocabCsv); store.set('inboxCsv', inboxCsv); store.set('fetched', new Date().toISOString());
      } catch (e) { note = ". Couldn't reach GitHub (" + e.message + '), using the copy saved on this phone.'; bad = true; }
    } else if (!vocabCsv) bad = true;
    rebuildIndex();
    setStatus(statusLine(note), bad);
    if (last) check();
  }

  // ---------- photo -> text ----------
  var worker = null;
  function abs(p) { return new URL(p, location.href).href; }
  function ocrMsg(t) { $('ocrMsg').textContent = t; }
  function bar(p) { $('ocrBar').style.width = Math.round(p * 100) + '%'; }
  async function getWorker() {
    if (worker) return worker;
    if (!window.Tesseract) throw new Error('text reader files are missing');
    ocrMsg('Loading the Dutch text reader (the first time takes a moment)…');
    worker = await Tesseract.createWorker('nld', 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'), corePath: abs('vendor/tesseract/core'),
      langPath: abs('vendor/tesseract/lang'),
      logger: function (m) { if (m.status === 'recognizing text') { ocrMsg('Reading the page… ' + Math.round(m.progress * 100) + '%'); bar(m.progress); } }
    });
    return worker;
  }
  async function prepImage(file) {
    var bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await createImageBitmap(file); }
    var s = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    var c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    var ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.15)';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error('could not prepare the image')); }, 'image/png'); });
  }
  async function onFile(input) {
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    $('ocrBox').hidden = false; bar(0); ocrMsg('Preparing the image…');
    try {
      var blob = await prepImage(file);
      var w = await getWorker();
      var out = await w.recognize(blob);
      $('txt').value = out.data.text;
      bar(1);
      ocrMsg('Done. Confidence ' + Math.round(out.data.confidence) + '%. Open "Text" below to fix any misread words.');
      check();
    } catch (e) { ocrMsg('Could not read that image: ' + e.message); $('ocrMsg').className = 'err'; return; }
    $('ocrMsg').className = 'muted';
  }

  // ---------- results ----------
  function check() {
    var text = $('txt').value;
    if (!text.trim()) { $('results').textContent = ''; last = null; return; }
    last = M.analyse(text, index, ignored);
    render();
  }
  function wordRow(item, opts) {
    var li = h('li', { class: 'clickable' },
      h('span', { class: 'w', text: item.word }),
      h('span', { class: 'n', text: opts.note || '×' + item.count }),
      h('button', { class: 'btn small', type: 'button', text: 'Add' }));
    li.addEventListener('click', function () { openSheet(item.word, item.sentence); });
    return li;
  }
  function section(title, items, rowFn, open) {
    if (!items.length) return null;
    var ul = h('ul', { class: 'list' });
    items.forEach(function (it) { ul.appendChild(rowFn(it)); });
    var d = h('details', { class: 'sec' }, h('summary', { text: title + ' (' + items.length + ')' }), ul);
    if (open) d.open = true;
    return d;
  }
  function render() {
    var r = last, box = $('results');
    box.textContent = '';
    var fresh = r.unknown.filter(function (x) { return !x.maybeName; });
    var names = r.unknown.filter(function (x) { return x.maybeName; });
    var line = r.total + ' words read: ' + r.known.length + ' known, ' + fresh.length + ' new' +
      (r.maybe.length ? ', ' + r.maybe.length + ' maybe forms of known words' : '') +
      (names.length ? ', ' + names.length + ' probably names' : '') +
      (r.ignoredCount ? ' (' + r.ignoredCount + ' ignored)' : '') + '.';
    box.appendChild(h('div', { class: 'card' }, h('strong', { text: line })));
    if (!index.size) box.appendChild(h('p', { class: 'err', text: 'The word list is empty, so every word shows as new. Check Settings.' }));
    var s1 = section('New words', fresh, function (x) { return wordRow(x, {}); }, true);
    if (s1) box.appendChild(s1);
    else if (index.size) box.appendChild(h('p', { class: 'muted', text: 'No new words on this page.' }));
    var s2 = section('Maybe forms of words you know', r.maybe, function (x) {
      var li = wordRow(x, { note: x.why });
      var ok = h('button', { class: 'btn small', type: 'button', text: 'Ignore' });
      ok.addEventListener('click', function (ev) { ev.stopPropagation(); ignored.add(x.word); store.set('ignored', Array.from(ignored)); check(); });
      li.insertBefore(ok, li.lastChild);
      return li;
    }, false);
    if (s2) box.appendChild(s2);
    var s3 = section('Probably names (capital letter in mid-sentence)', names, function (x) { return wordRow(x, {}); }, false);
    if (s3) box.appendChild(s3);
    if (r.known.length) {
      box.appendChild(h('details', { class: 'sec' }, h('summary', { text: 'Known words on this page (' + r.known.length + ')' }),
        h('p', { class: 'muted', text: r.known.map(function (k) { return k.word; }).join(', ') })));
    }
  }

  // ---------- adding a word ----------
  function openSheet(word, sentence) {
    $('fDutch').value = word; $('fEnglish').value = ''; $('fPhrase').value = sentence || '';
    $('lookupMsg').textContent = ''; looked = false;
    $('sheet').showModal();
  }
  async function lookup() {
    var w = $('fDutch').value.trim().toLowerCase(), msg = $('lookupMsg');
    if (!w) return;
    msg.className = 'muted'; msg.textContent = 'Looking up…';
    try {
      var r = await fetch('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(w));
      if (r.status === 404) { msg.textContent = 'Wiktionary has no entry for that spelling. Type the meaning yourself.'; return; }
      if (!r.ok) throw new Error('error ' + r.status);
      var j = await r.json(), defs = [];
      (j.nl || []).forEach(function (e) {
        (e.definitions || []).forEach(function (d) {
          var t = new DOMParser().parseFromString(d.definition || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
          if (t) defs.push(t.length > 120 ? t.slice(0, 117) + '...' : t);
        });
      });
      if (!defs.length) { msg.textContent = 'No Dutch meaning found there. Type it yourself.'; return; }
      $('fEnglish').value = defs.slice(0, 3).join('; '); looked = true;
      msg.textContent = 'Suggestion from Wiktionary. Check it makes sense; it gets marked "unreviewed".';
    } catch (e) { msg.className = 'err'; msg.textContent = "Couldn't look it up (" + e.message + '). Type the meaning yourself.'; }
  }
  function onSheetSubmit(ev) {
    var kind = ev.submitter && ev.submitter.value;
    if (kind !== 'add') return;
    var dutch = $('fDutch').value.trim(), english = $('fEnglish').value.trim();
    if (!dutch || !english) { ev.preventDefault(); $('lookupMsg').className = 'err'; $('lookupMsg').textContent = 'Type a meaning first (or tap Suggest).'; return; }
    queue.push({ dutch: dutch, english: english, phrase: $('fPhrase').value.trim(), who: who, date: today(),
                 source: looked ? 'dutch-reader+wiktionary (meaning unreviewed)' : 'dutch-reader' });
    store.set('queue', queue);
    rebuildIndex(); updateQueueBar(); if (last) check();
  }

  // ---------- sending the queue ----------
  function updateQueueBar() {
    $('queueBar').hidden = !queue.length;
    $('queueMsg').textContent = queue.length + (queue.length === 1 ? ' word' : ' words') + ' waiting to be sent';
  }
  async function send() {
    if (!queue.length) return;
    if (!token) { openSettings(); return; }
    var btn = $('btnSend'); btn.disabled = true; $('queueMsg').textContent = 'Sending…';
    try {
      for (var attempt = 0; attempt < 2; attempt++) {
        var cur = await ghGetJson(CFG.inbox);
        var text = cur ? cur.text : '';
        if (!text) text = INBOX_HEADER + '\n'; else if (text.slice(-1) !== '\n') text += '\n';
        var seen = new Set(M.csvRecords(text).map(function (r) { return M.norm(r.dutch) + '|' + M.norm(r.english); }));
        var add = queue.filter(function (q) { return !seen.has(M.norm(q.dutch) + '|' + M.norm(q.english)); });
        if (!add.length) { queue = []; store.set('queue', queue); updateQueueBar(); setStatus('Those words were already in the inbox.'); btn.disabled = false; return; }
        text += add.map(function (q) { return M.csvLine([q.dutch, q.english, q.phrase, q.who, q.date, q.source]); }).join('\n') + '\n';
        var body = { message: 'Add ' + add.length + ' word(s) from Dutch reader (' + who + ')', content: toB64(text) };
        if (cur) body.sha = cur.sha;
        var h2 = ghHeaders(false); h2['Content-Type'] = 'application/json';
        var r = await fetch(ghUrl(CFG.inbox), { method: 'PUT', headers: h2, body: JSON.stringify(body) });
        if (r.ok) {
          queue = []; store.set('queue', queue); inboxCsv = text; store.set('inboxCsv', text);
          rebuildIndex(); setStatus(statusLine(' Sent ' + add.length + ' word(s).')); updateQueueBar(); btn.disabled = false; return;
        }
        if (r.status !== 409 && r.status !== 422) throw new Error('GitHub said ' + r.status);
      }
      throw new Error('the inbox changed while sending, press Send again');
    } catch (e) {
      $('queueMsg').textContent = "Couldn't send (" + e.message + '). ' + queue.length + ' saved on this phone; try again later.';
    }
    btn.disabled = false;
  }

  // ---------- settings ----------
  function openSettings() {
    $('sWho').value = who; $('sToken').value = token;
    $('sInfo').textContent = ignored.size + ' ignored word(s) saved on this phone.';
    $('settings').showModal();
  }

  // ---------- start ----------
  $('inCamera').addEventListener('change', function () { onFile(this); });
  $('inPick').addEventListener('change', function () { onFile(this); });
  $('btnCheck').addEventListener('click', check);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnLookup').addEventListener('click', lookup);
  $('fEnglish').addEventListener('input', function () { looked = false; });
  $('sheetForm').addEventListener('submit', onSheetSubmit);
  $('btnIgnore').addEventListener('click', function () {
    ignored.add(M.norm($('fDutch').value.trim())); store.set('ignored', Array.from(ignored));
    $('sheet').close(); if (last) check();
  });
  $('btnSend').addEventListener('click', send);
  $('sSave').addEventListener('click', function () {
    who = $('sWho').value; token = $('sToken').value.trim();
    store.set('who', who); store.set('token', token); loadList();
  });
  $('sReload').addEventListener('click', function () { who = $('sWho').value; token = $('sToken').value.trim(); store.set('who', who); store.set('token', token); loadList(); });
  $('sClearIgnored').addEventListener('click', function () { ignored = new Set(); store.set('ignored', []); $('sInfo').textContent = 'Ignored words cleared.'; if (last) check(); });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  rebuildIndex(); updateQueueBar(); loadList();

  // for the tests
  window.__dr = { check: check, getIndex: function () { return index; }, getQueue: function () { return queue; } };
})();

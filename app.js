/* app.js: the screens.
   Sort words: one word at a time, tap 0-5 (six levels). Ratings are saved into the person's own progress
   file (dutch/<person>.csv), changing only the lines of the rated words.
   Add a word: type a word + meaning; "Send" appends it to dutch/inbox.csv (a later tool merges it into the list). */
(function () {
  'use strict';
  var M = window.Matcher, T = window.Triage;
  var CFG = { owner: 'dozer94-NZ', repo: 'learning-progress', vocab: 'dutch/vocab/dutch-vocab.csv',
              inbox: 'dutch/inbox.csv', api: 'https://api.github.com' };
  var INBOX_HEADER = 'dutch,english,phrase,who,date,source';
  var ISSUES = { path: 'dutch/issues.csv', header: 'dutch,english,type,note,who,date' };
  var IDEAS = { path: 'dutch/ideas.csv', header: 'date,who,idea' };
  var AUTOSAVE_EVERY = 10;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- saved on this phone only ----------
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
  var vocabCsv = store.get('vocabCsv', '');
  var inboxCsv = store.get('inboxCsv', '');
  var progText = store.get('prog.' + who, '');
  var pending = store.get('pending.' + who, {});     // ratings not yet saved to the wordlist
  var inboxQueue = store.get('queue', []);           // typed words not yet sent
  var issueQueue = store.get('issues', []);          // flags not yet sent
  var ideaQueue = store.get('ideas', []);            // ideas not yet sent
  var flagged = new Set(store.get('flagged', []));   // words this phone has flagged
  var people = store.get('people', ['Noah', 'Anna']);  // everyone with a progress file
  var RESERVED = ['inbox', 'issues', 'ideas', 'people', 'readme', 'vocab'];
  var PROG_HEADER = 'dutch,english,status,right,wrong,streak,last_practised,next_due,pronunciation';
  var words = [], progress = new Map(), index = M.buildIndex([]);
  var session = { queue: [], pos: 0, done: 0, undo: [] };
  var saving = false, looked = false;

  function today() { return new Date().toLocaleDateString('sv-SE'); }
  function progPath() { return 'dutch/' + who.toLowerCase() + '.csv'; }
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
  function setStatus(text, isErr) { var e = $('listStatus'); e.textContent = text; e.className = isErr ? 'err' : 'muted'; }

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
    if (!r.ok) throw new Error('the server said ' + r.status);
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
    if (!r.ok) throw new Error('the server said ' + r.status);
    var j = await r.json();
    var text = j.content ? fromB64(j.content) : (j.size ? await ghGetRaw(path) : '');
    return { sha: j.sha, text: text };
  }
  async function ghList(path) {
    var r = await fetch(ghUrl(path), { headers: ghHeaders(false), cache: 'no-store' });
    if (!r.ok) throw new Error('the server said ' + r.status);
    var j = await r.json();
    return Array.isArray(j) ? j : [];
  }
  async function ghPut(path, message, text, sha) {
    var body = { message: message, content: toB64(text) };
    if (sha) body.sha = sha;
    var hd = ghHeaders(false); hd['Content-Type'] = 'application/json';
    return fetch(ghUrl(path), { method: 'PUT', headers: hd, body: JSON.stringify(body) });
  }

  // ---------- loading ----------
  function pendingList() { return Object.keys(pending).map(function (k) { return pending[k]; }); }
  function fieldsOfEntry(e) { return e.kind === 'restore' ? e.fields : T.fieldsFor(e.level, e.date); }
  function blankRow(w) {
    return { dutch: w.dutch, english: w.english, status: 'unknown', right: '0', wrong: '0', streak: '0',
             last_practised: '', next_due: '', pronunciation: '' };
  }
  function rebuild() {
    words = vocabCsv ? M.csvRecords(vocabCsv).filter(function (r) { return r.dutch && r.english; }).map(function (r) {
      return { dutch: r.dutch, english: r.english, level: r.level || '', type: r.type || 'word' };
    }) : [];
    progress = new Map();
    if (progText) M.csvRecords(progText).forEach(function (r) { progress.set(T.keyOf(r.dutch, r.english), r); });
    pendingList().forEach(function (e) {       // ratings not saved yet still count on screen
      var k = T.keyOf(e.dutch, e.english), row = progress.get(k) || blankRow(e);
      Object.assign(row, fieldsOfEntry(e)); progress.set(k, row);
    });
    var inboxRows = inboxCsv ? M.csvRecords(inboxCsv) : [];
    index = M.buildIndex(words.concat(inboxRows, inboxQueue).map(function (r) { return { dutch: r.dutch, english: r.english, type: r.type }; }));
  }
  function ratedTotal() {
    var n = 0, t0 = today();
    words.forEach(function (w) { if (T.levelOf(progress.get(T.keyOf(w.dutch, w.english)), t0) !== null) n++; });
    return n;
  }
  async function loadAll() {
    setStatus('Loading…');
    var note = '', bad = false;
    if (token) {
      try {
        var v = await ghGetRaw(CFG.vocab);
        if (v === null) throw new Error('word list not found, check the access key');
        var p = await ghGetRaw(progPath());
        if (p === null) throw new Error(progPath() + ' not found');
        var ib = await ghGetRaw(CFG.inbox);
        vocabCsv = v; progText = p; inboxCsv = ib || '';
        store.set('vocabCsv', vocabCsv); store.set('prog.' + who, progText); store.set('inboxCsv', inboxCsv);
        store.set('fetched', new Date().toISOString());
      } catch (e) { note = ". Couldn't reach the wordlist (" + e.message + '); using the copy saved on this phone.'; bad = true; }
    } else if (!vocabCsv) bad = true;
    rebuild();
    if (!words.length) setStatus('No word list yet. Open Settings and add your access key.', true);
    else {
      var f = store.get('fetched', '');
      setStatus('Word list: ' + words.length.toLocaleString() + ' words, ' + who + "'s progress" +
                (f ? ' (loaded ' + new Date(f).toLocaleString() + ')' : '') + note, bad);
    }
    startSession();
    renderQueue();
    flushExtras();
    if (token && !bad) loadPeople();
  }

  // ---------- Sort words ----------
  var rateBox = $('rate');
  T.LEVELS.forEach(function (l) {
    rateBox.appendChild(h('button', { type: 'button', 'data-n': String(l.n), onclick: function () { rate(l.n); } },
      h('b', { text: String(l.n) }), h('span', { text: l.short })));
  });
  function startSession() {
    var m = $('mode').value;
    session.queue = T.buildQueue(words, progress, (m === 'unrated' || m === 'all') ? m : Number(m), today());
    session.pos = 0; session.done = 0; session.undo = [];
    showCard();
  }
  function curRow(w) { return progress.get(T.keyOf(w.dutch, w.english)); }
  function updateCounts() {
    var n = pendingList().length;
    $('saveMsg').textContent = saving ? 'Saving…' : (n ? n + (n === 1 ? ' rating' : ' ratings') + ' waiting to save' : (words.length ? 'All saved' : ''));
    $('btnSave').disabled = saving || !n;
    var f = issueQueue.length;
    if (f) $('saveMsg').textContent += ' · ' + f + (f === 1 ? ' flag' : ' flags') + ' waiting to send';
  }
  function showCard() {
    var w = session.queue[session.pos];
    $('card').hidden = !w;
    var rated = ratedTotal();
    $('sortMsg').textContent = words.length
      ? session.done + ' rated this session · ' + rated.toLocaleString() + ' of ' + words.length.toLocaleString() + ' rated in total' +
        (w ? ' · ' + (session.queue.length - session.pos) + ' left in this set' : '')
      : '';
    if (!w) {
      if (words.length) $('sortMsg').textContent += session.queue.length ? ' · This set is finished.' : ' · Nothing to show in this set.';
      updateCounts(); return;
    }
    $('cWord').textContent = w.dutch;
    $('bLevel').textContent = w.level || 'no level'; $('bLevel').className = 'chip lv';
    var now = T.levelOf(curRow(w), today());
    $('bNow').textContent = now === null ? 'not rated yet' : 'now: ' + T.LEVELS[now].n + ' ' + T.LEVELS[now].short;
    $('bNow').className = 'chip' + (now === null ? '' : ' ok');
    $('bFlag').hidden = !flagged.has(T.keyOf(w.dutch, w.english));
    Array.prototype.forEach.call(rateBox.children, function (b) { b.className = (now !== null && Number(b.getAttribute('data-n')) === now) ? 'now' : ''; });
    var showEn = $('showEn').checked;
    $('cEng').textContent = showEn ? w.english : '';
    $('btnReveal').hidden = showEn;
    updateCounts();
  }
  function reveal() { var w = session.queue[session.pos]; if (!w) return; $('cEng').textContent = w.english; $('btnReveal').hidden = true; }
  function rate(n) {
    var w = session.queue[session.pos]; if (!w) return;
    var k = T.keyOf(w.dutch, w.english), prev = progress.get(k), entry = { dutch: w.dutch, english: w.english, kind: 'level', level: n, date: today() };
    session.undo.push({ key: k, prevRow: prev ? Object.assign({}, prev) : null, prevPending: pending[k], entry: entry });
    pending[k] = entry; store.set('pending.' + who, pending);
    var row = prev || blankRow(w); Object.assign(row, fieldsOfEntry(entry)); progress.set(k, row);
    session.done++; session.pos++;
    showCard();
    if (pendingList().length >= AUTOSAVE_EVERY && token && !saving) save();
  }
  function skip() { if (!session.queue[session.pos]) return; session.undo.push({ skip: true }); session.pos++; showCard(); }
  function undo() {
    var u = session.undo.pop(); if (!u) return;
    session.pos--;
    if (!u.skip) {
      var w = session.queue[session.pos];
      if (u.prevRow) progress.set(u.key, u.prevRow); else progress.delete(u.key);
      if (pending[u.key] === u.entry) { if (u.prevPending) pending[u.key] = u.prevPending; else delete pending[u.key]; }
      else {  // it was already saved: save the old values back
        var p = u.prevRow || blankRow(w);
        pending[u.key] = { dutch: w.dutch, english: w.english, kind: 'restore', fields: { status: p.status, streak: p.streak, next_due: p.next_due } };
      }
      store.set('pending.' + who, pending);
      session.done--;
    }
    showCard();
  }

  async function save() {
    var list = pendingList();
    if (!list.length || saving) return;
    if (!token) { $('saveMsg').textContent = 'Add your access key in Settings first.'; return; }
    saving = true; updateCounts();
    var snap = {}; Object.keys(pending).forEach(function (k) { snap[k] = pending[k]; });
    var changes = Object.keys(snap).map(function (k) { return { dutch: snap[k].dutch, english: snap[k].english, fields: fieldsOfEntry(snap[k]) }; });
    function forget(newText) {
      Object.keys(snap).forEach(function (k) { if (pending[k] === snap[k]) delete pending[k]; });
      store.set('pending.' + who, pending); progText = newText; store.set('prog.' + who, progText);
    }
    try {
      for (var attempt = 0; attempt < 3; attempt++) {
        var cur = await ghGetJson(progPath());
        if (!cur) throw new Error(progPath() + ' not found');
        var res = T.patchProgress(cur.text, changes);
        if (res.text === cur.text) { forget(cur.text); saving = false; updateCounts(); $('saveMsg').textContent = 'Already saved.'; return; }
        var r = await ghPut(progPath(), 'Self-assessed ' + res.changed + ' word(s) in Dutch words app (' + who + ')', res.text, cur.sha);
        if (r.ok) {
          forget(res.text); saving = false; updateCounts(); flushExtras();
          $('saveMsg').textContent = 'Saved ' + res.changed + (res.changed === 1 ? ' word' : ' words') + ' in the wordlist.';
          return;
        }
        if (r.status !== 409 && r.status !== 422) throw new Error('the server said ' + r.status);
      }   // 409/422: someone (the phone) saved first: read the newest file and apply again
      throw new Error('the file kept changing, press Save again');
    } catch (e) {
      saving = false; updateCounts();
      $('saveMsg').textContent = "Couldn't save (" + e.message + '). ' + pendingList().length + ' kept on this phone; try again later.';
    }
  }

  // ---------- Add a word ----------
  function onDutchInput() {
    var w = M.norm($('fDutch').value.trim()), n = $('dutchNote');
    if (!w) { n.textContent = ''; return; }
    if (index.known.has(w)) n.textContent = 'Already in your list (' + index.known.get(w) + '). You can still add another meaning.';
    else { var l = M.findLemma(w, index); n.textContent = l ? 'Looks like a form of "' + l + '", which is in your list.' : ''; }
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
  function addToQueue() {
    var dutch = $('fDutch').value.trim(), english = $('fEnglish').value.trim(), msg = $('lookupMsg');
    if (!dutch || !english) { msg.className = 'err'; msg.textContent = 'Type the Dutch word and its meaning first.'; return; }
    inboxQueue.push({ dutch: dutch, english: english, phrase: $('fPhrase').value.trim(), who: who, date: today(),
                      source: looked ? 'dutch-reader+wiktionary (meaning unreviewed)' : 'dutch-reader' });
    store.set('queue', inboxQueue);
    $('fDutch').value = ''; $('fEnglish').value = ''; $('fPhrase').value = ''; $('dutchNote').textContent = '';
    msg.className = 'muted'; msg.textContent = 'Added to the queue.'; looked = false;
    rebuild(); renderQueue(); $('fDutch').focus();
  }
  function renderQueue() {
    var n = inboxQueue.length;
    $('queueBar').hidden = !n;
    $('queueMsg').textContent = n + (n === 1 ? ' word' : ' words') + ' waiting to be sent';
    var ul = $('queueList'); ul.textContent = '';
    inboxQueue.forEach(function (q, i) {
      ul.appendChild(h('li', {}, h('span', { class: 'w', text: q.dutch }), h('span', { class: 'n', text: q.english }),
        h('button', { class: 'btn small', type: 'button', text: 'Remove', onclick: function () { inboxQueue.splice(i, 1); store.set('queue', inboxQueue); rebuild(); renderQueue(); } })));
    });
  }
  // Append rows to a CSV file in the wordlist folder (creates it with a header if needed).
  // keyOf makes a duplicate check string for one row (an array of fields). Returns how many rows were added.
  async function appendRows(path, header, rows, message, keyOf) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var cur = await ghGetJson(path);
      var text = cur ? cur.text : '';
      if (!text) text = header + '\n'; else if (text.slice(-1) !== '\n') text += '\n';
      var seen = new Set(M.csvRecords(text).map(function (r) { return keyOf(Object.keys(r).map(function (k) { return r[k]; })); }));
      var add = rows.filter(function (r) { return !seen.has(keyOf(r)); });
      if (!add.length) return { added: 0, text: text };
      text += add.map(function (r) { return M.csvLine(r); }).join('\n') + '\n';
      var res = await ghPut(path, message(add.length), text, cur && cur.sha);
      if (res.ok) return { added: add.length, text: text };
      if (res.status !== 409 && res.status !== 422) throw new Error('the server said ' + res.status);
    }
    throw new Error('the file changed while sending, try again');
  }
  async function sendQueue() {
    if (!inboxQueue.length) return;
    if (!token) { openSettings(); return; }
    var btn = $('btnSend'); btn.disabled = true; $('queueMsg').textContent = 'Sending…';
    try {
      var rows = inboxQueue.map(function (q) { return [q.dutch, q.english, q.phrase, q.who, q.date, q.source]; });
      var r = await appendRows(CFG.inbox, INBOX_HEADER, rows, function (n) { return 'Add ' + n + ' word(s) from Dutch words app (' + who + ')'; },
                               function (f) { return M.norm(f[0]) + '|' + M.norm(f[1]); });
      inboxQueue = []; store.set('queue', inboxQueue); inboxCsv = r.text; store.set('inboxCsv', r.text);
      rebuild(); renderQueue(); $('lookupMsg').textContent = r.added ? 'Sent ' + r.added + ' word(s).' : 'Those words were already sent.';
    } catch (e) {
      $('queueMsg').textContent = "Couldn't send (" + e.message + '). ' + inboxQueue.length + ' saved on this phone; try again later.';
    }
    btn.disabled = false;
  }

  // ---------- flags and ideas (sent straight away; kept on the phone if that fails) ----------
  var flushing = false;
  async function flushExtras() {
    if (flushing || !token || (!issueQueue.length && !ideaQueue.length)) return;
    flushing = true;
    try {
      if (issueQueue.length) {
        var rows = issueQueue.map(function (q) { return [q.dutch, q.english, q.type, q.note, q.who, q.date]; });
        await appendRows(ISSUES.path, ISSUES.header, rows, function (n) { return 'Flag ' + n + ' word problem(s) from Dutch words app (' + who + ')'; },
                         function (f) { return M.norm(f[0]) + '|' + M.norm(f[1]) + '|' + f[2] + '|' + f[4] + '|' + M.norm(f[3]); });
        issueQueue = []; store.set('issues', issueQueue);
      }
      if (ideaQueue.length) {
        var irows = ideaQueue.map(function (q) { return [q.date, q.who, q.idea]; });
        await appendRows(IDEAS.path, IDEAS.header, irows, function (n) { return 'Idea from ' + who + ' (Dutch words app)'; },
                         function (f) { return f[0] + '|' + f[1] + '|' + f[2]; });
        ideaQueue = []; store.set('ideas', ideaQueue);
        $('ideaMsg').textContent = 'Sent. Thank you!';
      }
    } catch (e) { /* stays on the phone, tried again at the next save */ }
    flushing = false; updateCounts();
  }
  function openFlag() {
    var w = session.queue[session.pos]; if (!w) return;
    $('flagWord').textContent = w.dutch + ' = ' + w.english;
    $('flagNote').value = ''; $('flagType').selectedIndex = 0;
    $('flagDlg').showModal();
  }
  function onFlagSubmit(ev) {
    if (!(ev.submitter && ev.submitter.value === 'flag')) return;
    var w = session.queue[session.pos]; if (!w) return;
    issueQueue.push({ dutch: w.dutch, english: w.english, type: $('flagType').value, note: $('flagNote').value.trim(), who: who, date: today() });
    store.set('issues', issueQueue);
    flagged.add(T.keyOf(w.dutch, w.english)); store.set('flagged', Array.from(flagged));
    showCard(); flushExtras();
  }
  function sendIdea() {
    var t = $('ideaText').value.trim(), msg = $('ideaMsg');
    if (!t) { msg.className = 'err grow'; msg.textContent = 'Write your idea first.'; return; }
    ideaQueue.push({ date: today(), who: who, idea: t }); store.set('ideas', ideaQueue);
    $('ideaText').value = ''; msg.className = 'muted grow';
    msg.textContent = token ? 'Sending…' : 'Saved on this phone. Add the access key in Settings to send it.';
    flushExtras().then(function () { if (ideaQueue.length && token) msg.textContent = "Couldn't send it yet. It is saved on this phone and goes out next time."; });
  }

  // ---------- people ----------
  function nice(name) { return name.charAt(0).toUpperCase() + name.slice(1); }
  function populateWho() {
    var list = people.slice(); if (list.indexOf(who) < 0) list.push(who);
    list.sort(); people = list;
    var sel = $('sWho'); sel.textContent = '';
    list.forEach(function (n) { var o = document.createElement('option'); o.textContent = n; sel.appendChild(o); });
    sel.value = who;
  }
  async function loadPeople() {
    if (!token) return;
    try {
      var names = (await ghList('dutch')).filter(function (e) { return e.type === 'file' && /\.csv$/.test(e.name); })
        .map(function (e) { return e.name.slice(0, -4); }).filter(function (n) { return RESERVED.indexOf(n) < 0; }).map(nice);
      if (names.length) { people = names; store.set('people', people); }
    } catch (e) { /* keep the saved list */ }
  }
  async function addPerson() {
    var raw = $('sNewName').value.trim().toLowerCase().replace(/\s+/g, ''), msg = $('sPersonMsg');
    msg.className = 'muted';
    if (!/^[a-z][a-z0-9-]{1,19}$/.test(raw)) { msg.className = 'err'; msg.textContent = 'Use 2 to 20 letters or numbers, no spaces or accents.'; return; }
    if (RESERVED.indexOf(raw) >= 0) { msg.className = 'err'; msg.textContent = '"' + raw + '" is used for something else. Pick another name.'; return; }
    if (!token) { msg.className = 'err'; msg.textContent = 'Add your access key first.'; return; }
    if (!words.length) { msg.className = 'err'; msg.textContent = 'Load the wordlist first.'; return; }
    var path = 'dutch/' + raw + '.csv', name = nice(raw);
    msg.textContent = 'Creating…';
    try {
      if (await ghGetJson(path)) {
        if (people.indexOf(name) < 0) people.push(name);
        populateWho(); $('sWho').value = name;
        msg.textContent = name + ' already has a list. Chosen above; tap Save to switch to it.'; return;
      }
      var seen = new Set(), rows = [];
      words.forEach(function (w) { var k = T.keyOf(w.dutch, w.english); if (!seen.has(k)) { seen.add(k); rows.push(w); } });
      rows.sort(function (a, b) {
        var x = a.dutch.toLowerCase(), y = b.dutch.toLowerCase();
        if (x !== y) return x < y ? -1 : 1;
        x = a.english.toLowerCase(); y = b.english.toLowerCase();
        return x < y ? -1 : (x > y ? 1 : 0);
      });
      var text = PROG_HEADER + '\n' + rows.map(function (w) { return M.csvLine([w.dutch, w.english, 'unknown', '0', '0', '0', '', '', '']); }).join('\n') + '\n';
      var r = await ghPut(path, "Add " + name + "'s progress file (" + rows.length + ' words, all unknown) from Dutch words app', text, null);
      if (!r.ok) throw new Error('the server said ' + r.status);
      if (people.indexOf(name) < 0) people.push(name);
      store.set('people', people); populateWho(); $('sWho').value = name; $('sNewName').value = '';
      msg.textContent = 'Created ' + name + "'s list with " + rows.length.toLocaleString() + ' words. Tap Save to switch to it.';
    } catch (e) { msg.className = 'err'; msg.textContent = "Couldn't create it (" + e.message + ').'; }
  }

  // ---------- tabs, settings, start ----------
  function tab(which) {
    ['sort', 'add', 'ideas'].forEach(function (t) {
      var cap = t.charAt(0).toUpperCase() + t.slice(1);
      $('tab' + cap).hidden = which !== t; $('tab' + cap + 'Btn').className = 'tab' + (which === t ? ' on' : '');
    });
  }
  function openSettings() {
    populateWho(); $('sToken').value = token; $('sPersonMsg').textContent = '';
    loadPeople().then(populateWho);
    $('sInfo').textContent = pendingList().length + ' rating(s) not saved yet.';
    $('settings').showModal();
  }
  function applySettings() {
    var newWho = $('sWho').value;
    token = $('sToken').value.trim(); store.set('token', token);
    if (newWho !== who) {
      who = newWho; store.set('who', who);
      progText = store.get('prog.' + who, ''); pending = store.get('pending.' + who, {});
    }
    loadAll();
  }

  $('tabSortBtn').addEventListener('click', function () { tab('sort'); });
  $('tabAddBtn').addEventListener('click', function () { tab('add'); });
  $('tabIdeasBtn').addEventListener('click', function () { tab('ideas'); });
  $('btnFlag').addEventListener('click', openFlag);
  $('flagForm').addEventListener('submit', onFlagSubmit);
  $('btnIdea').addEventListener('click', sendIdea);
  $('mode').addEventListener('change', startSession);
  $('showEn').checked = !!store.get('showEn', false);
  $('showEn').addEventListener('change', function () { store.set('showEn', this.checked); showCard(); });
  $('btnReveal').addEventListener('click', reveal);
  $('btnBack').addEventListener('click', undo);
  $('btnSkip').addEventListener('click', skip);
  $('btnSave').addEventListener('click', save);
  $('btnSettings').addEventListener('click', openSettings);
  $('sSave').addEventListener('click', applySettings);
  $('sAddPerson').addEventListener('click', addPerson);
  $('sNewName').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addPerson(); } });
  $('sReload').addEventListener('click', function () { $('settings').close(); applySettings(); });
  $('fDutch').addEventListener('input', onDutchInput);
  $('fEnglish').addEventListener('input', function () { looked = false; });
  $('btnLookup').addEventListener('click', lookup);
  $('btnAdd').addEventListener('click', addToQueue);
  $('btnSend').addEventListener('click', sendQueue);
  document.addEventListener('keydown', function (ev) {
    var tg = ev.target && ev.target.tagName;
    if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT' || $('tabSort').hidden || $('settings').open || $('flagDlg').open) return;
    if (/^[0-5]$/.test(ev.key)) rate(Number(ev.key));
    else if (ev.key === ' ') { ev.preventDefault(); reveal(); }
    else if (ev.key === 'Backspace') undo();
    else if (ev.key === 'ArrowRight') skip();
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden && token && pendingList().length) save(); });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  rebuild(); renderQueue(); loadAll();
})();

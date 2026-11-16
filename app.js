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
  var SCORES = { path: 'dutch/scores.csv', header: 'id,date,who,mode,points,right,total,wotw' };
  var BATTLES = { path: 'dutch/battles.csv', header: 'id,type,date,who,opponent,mode,score,right,total,questions' };
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
  var scoresCsv = store.get('scoresCsv', ''), battlesCsv = store.get('battlesCsv', '');
  var scoreQueue = store.get('scoreQ', []), battleQueue = store.get('battleQ', []);   // game results not yet sent
  var flagTarget = null;
  var flagged = new Set(store.get('flagged', []));   // words this phone has flagged
  var people = store.get('people', ['Noah', 'Anna']);  // everyone with a progress file
  var RESERVED = ['inbox', 'issues', 'ideas', 'people', 'readme', 'vocab', 'scores', 'battles'];
  var PROG_HEADER = 'dutch,english,status,right,wrong,streak,last_practised,next_due,pronunciation';
  var words = [], drills = [], progress = new Map(), index = M.buildIndex([]);
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
  function fieldsOfEntry(e) { return (e.kind === 'restore' || e.kind === 'answer') ? e.fields : T.fieldsFor(e.level, e.date); }
  function blankRow(w) {
    return { dutch: w.dutch, english: w.english, status: 'unknown', right: '0', wrong: '0', streak: '0',
             last_practised: '', next_due: '', pronunciation: '' };
  }
  function rebuild() {
    var all = vocabCsv ? M.csvRecords(vocabCsv).filter(function (r) { return r.dutch && r.english; }).map(function (r) {
      return { dutch: r.dutch, english: r.english, level: r.level || '', type: r.type || 'word' };
    }) : [];
    words = all.filter(function (w) { return !/^verb-/.test(w.type); });      // sorting, quick rounds, battles
    drills = all.filter(function (w) { return /^verb-/.test(w.type); });      // the Verb drill only
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
    loadGame();
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
        var r = await ghPut(progPath(), (Object.keys(snap).some(function (k) { return snap[k].kind === 'answer'; }) ? 'Practised ' : 'Self-assessed ') + res.changed + ' word(s) in Dutch words app (' + who + ')', res.text, cur.sha);
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
    if (flushing || !token || (!issueQueue.length && !ideaQueue.length && !scoreQueue.length && !battleQueue.length)) return;
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
      if (scoreQueue.length) {
        var srows = scoreQueue.map(function (q) { return [q.id, q.date, q.who, q.mode, q.points, q.right, q.total, q.wotw]; });
        var sr = await appendRows(SCORES.path, SCORES.header, srows, function (n) { return 'Score from ' + who + ' (Dutch words app)'; }, function (f) { return f[0]; });
        scoreQueue = []; store.set('scoreQ', scoreQueue); scoresCsv = sr.text; store.set('scoresCsv', scoresCsv);
      }
      if (battleQueue.length) {
        var brows = battleQueue.map(function (q) { return [q.id, q.type, q.date, q.who, q.opponent, q.mode, q.score, q.right, q.total, q.questions]; });
        var br = await appendRows(BATTLES.path, BATTLES.header, brows, function (n) { return 'Battle ' + battleQueue[0].type + ' from ' + who + ' (Dutch words app)'; }, function (f) { return f[0] + '|' + f[1] + '|' + f[3]; });
        battleQueue = []; store.set('battleQ', battleQueue); battlesCsv = br.text; store.set('battlesCsv', battlesCsv);
      }
      renderGame();
    } catch (e) { /* stays on the phone, tried again at the next save */ }
    flushing = false; updateCounts();
  }
  function openFlag(w) {
    w = w || session.queue[session.pos]; if (!w) return;
    flagTarget = w;
    $('flagWord').textContent = w.dutch + ' = ' + w.english;
    $('flagNote').value = ''; $('flagType').selectedIndex = 0;
    $('flagDlg').showModal();
  }
  function onFlagSubmit(ev) {
    if (!(ev.submitter && ev.submitter.value === 'flag')) return;
    var w = flagTarget; if (!w) return;
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

  // ---------- games: quick round, battles, leaderboard ----------
  var G = window.Game;
  var round = null;
  function modeName(m) { return m === 'handicap' ? 'handicap' : 'normal'; }
  function scoreRows() {
    var by = new Map();
    (scoresCsv ? M.csvRecords(scoresCsv) : []).concat(scoreQueue).forEach(function (r) { by.set(r.id, r); });
    return Array.from(by.values());
  }
  function battleRows() {
    var by = new Map();
    (battlesCsv ? M.csvRecords(battlesCsv) : []).concat(battleQueue).forEach(function (r) { by.set(r.id + '|' + r.type + '|' + r.who, r); });
    return Array.from(by.values());
  }
  function myDates() { return scoreRows().filter(function (r) { return r.who === who; }).map(function (r) { return r.date; }); }
  function wotwDone(wk) { return scoreRows().some(function (r) { return r.who === who && r.wotw === '1' && G.weekStart(r.date) === wk; }); }
  async function loadGame() {
    if (token) {
      try {
        var s = await ghGetRaw(SCORES.path), b = await ghGetRaw(BATTLES.path);
        scoresCsv = s || ''; battlesCsv = b || '';
        store.set('scoresCsv', scoresCsv); store.set('battlesCsv', battlesCsv);
      } catch (e) { /* keep the copies saved on this phone */ }
    }
    renderGame();
  }
  function renderGame() { renderPlayHome(); renderBoard(); renderBattles(); }

  function renderPlayHome() {
    var t0 = today(), wk = G.weekStart(t0), w = words.length ? G.wordOfWeek(words, wk) : null, box = $('wotwBox');
    box.textContent = '';
    if (!w) box.appendChild(h('p', { class: 'muted', text: 'Load the wordlist first.' }));
    else {
      box.appendChild(h('div', { class: 'word small', text: w.dutch }));
      box.appendChild(h('p', { class: 'muted', text: wotwDone(wk) ? 'Done this week ✓ (+' + G.WOTW_BONUS + ' points earned)'
        : 'Get it right in a quick round this week for +' + G.WOTW_BONUS + ' points. It is the first question of your next round.' }));
    }
    var streak = G.streakDays(myDates(), t0), mine = G.leaderboard(scoreRows().filter(function (r) { return r.who === who; }), wk)[0];
    $('streakMsg').textContent = 'Daily streak: ' + streak + (streak === 1 ? ' day' : ' days') + ' · This week: ' + (mine ? mine.points : 0) + ' points';
    var sel = $('bOpp'), keep = sel.value; sel.textContent = '';
    people.filter(function (n) { return n !== who; }).forEach(function (n) { var o = document.createElement('option'); o.textContent = n; sel.appendChild(o); });
    if (keep) sel.value = keep;
    $('btnChallenge').disabled = !sel.options.length;
  }
  function renderBattles() {
    var states = G.battleStates(battleRows()), box = $('battleLists'); box.textContent = '';
    var todo = states.filter(function (s) { return !s.done && s.b === who; }),
        wait = states.filter(function (s) { return !s.done && s.a === who; }),
        done = states.filter(function (s) { return s.done && (s.a === who || s.b === who); }).slice(-8).reverse();
    function row(text, btn) { return h('div', { class: 'brow' }, h('span', { class: 'grow', text: text }), btn); }
    if (todo.length) box.appendChild(h('h3', { text: 'Waiting for you' }));
    todo.forEach(function (s) {
      box.appendChild(row(s.a + ' challenged you (' + modeName(s.mode) + ', ' + s.date + ')',
        h('button', { class: 'btn small primary', type: 'button', text: 'Play', onclick: function () { playReply(s); } })));
    });
    if (wait.length) box.appendChild(h('h3', { text: 'Waiting for them' }));
    wait.forEach(function (s) { box.appendChild(row('You vs ' + s.b + ': you scored ' + s.aScore + ' (' + modeName(s.mode) + ', ' + s.date + ')')); });
    if (done.length) box.appendChild(h('h3', { text: 'Finished' }));
    done.forEach(function (s) {
      box.appendChild(row(s.a + ' ' + s.aScore + ' – ' + s.bScore + ' ' + s.b + ' · ' + (s.winner === 'draw' ? 'draw' : s.winner + ' won') + ' (' + modeName(s.mode) + ', ' + s.date + ')'));
    });
    if (!states.length) box.appendChild(h('p', { class: 'muted', text: 'No battles yet. Challenge someone above.' }));
  }
  function renderBoard() {
    var rows = scoreRows(), wk = G.weekStart(today()), lb = G.leaderboard(rows, wk), ul = $('boardList'); ul.textContent = '';
    $('boardWeek').textContent = 'Week of ' + wk + ' (Monday to Sunday)';
    lb.forEach(function (o, i) {
      ul.appendChild(h('li', {}, h('span', { class: 'rank', text: ['🥇', '🥈', '🥉'][i] || String(i + 1) }),
        h('span', { class: 'w', text: o.who + (o.who === who ? ' (you)' : '') }),
        h('span', { class: 'n', text: o.rounds + (o.rounds === 1 ? ' round' : ' rounds') + ' · ' + o.right + '/' + o.total + ' right' }),
        h('b', { text: o.points + ' pts' })));
    });
    if (!lb.length) ul.appendChild(h('li', {}, h('span', { class: 'n', text: 'Nobody has played this week yet. Be the first!' })));
    var last = G.leaderboard(rows, T.addDays(wk, -7));
    $('boardLast').textContent = last.length ? 'Last week: ' + last[0].who + ' won with ' + last[0].points + ' points.' : 'Last week: no rounds played.';
    var all = G.leaderboard(rows);
    $('boardAll').textContent = all.length ? 'All time: ' + all.map(function (o) { return o.who + ' ' + o.points; }).join(' · ') : '';
    var wins = G.battleWins(G.battleStates(battleRows())), wn = Object.keys(wins).sort(function (a, b) { return wins[b] - wins[a]; });
    $('boardWins').textContent = wn.length ? 'Battle wins: ' + wn.map(function (n) { return n + ' ' + wins[n]; }).join(' · ') : 'No battles finished yet.';
  }

  function showPlay(view) { $('playHome').hidden = view !== 'home'; $('quiz').hidden = view !== 'quiz'; $('quizEnd').hidden = view !== 'end'; }
  function startRound(r) {
    round = Object.assign({ pos: 0, answers: [], pts: 0, locked: false }, r);
    showPlay('quiz'); renderQuestion();
  }
  function startPractice() {
    if (!words.length) { $('roundMsg').textContent = 'Load the wordlist first (Settings).'; return; }
    $('roundMsg').textContent = '';
    var t0 = today(), wk = G.weekStart(t0), seed = 'p' + Date.now() + Math.random();
    var chosen = G.pickPractice(words, progress, t0, seed, G.ROUND), wotw = wotwDone(wk) ? null : G.wordOfWeek(words, wk), wotwKey = null;
    if (wotw) {
      wotwKey = T.keyOf(wotw.dutch, wotw.english);
      chosen = [wotw].concat(chosen.filter(function (w) { return T.keyOf(w.dutch, w.english) !== wotwKey; })).slice(0, G.ROUND);
    }
    startRound({ kind: 'practice', flat: false, qs: G.makeQuestions(chosen, words, seed), wotwKey: wotwKey });
  }
  function startDrill() {
    var msg = $('drillMsg'); msg.textContent = '';
    if (!drills.length) { msg.textContent = 'No verb drills in the wordlist yet.'; return; }
    var seed = 'd' + Date.now() + Math.random(), chosen = G.pickPractice(drills, progress, today(), seed, G.ROUND);
    startRound({ kind: 'drill', flat: false, qs: G.makeDrillQuestions(chosen, drills, seed), wotwKey: null });
  }
  async function startBattle() {
    var opp = $('bOpp').value, mode = $('bMode').value, msg = $('battleMsg');
    msg.className = 'muted';
    if (!opp) { msg.textContent = 'Add a person in Settings first.'; return; }
    if (!token) { msg.className = 'err'; msg.textContent = 'Add your access key in Settings first.'; return; }
    if (!words.length) { msg.className = 'err'; msg.textContent = 'Load the wordlist first.'; return; }
    var seed = 'b' + Date.now() + Math.random(), chosen;
    $('btnChallenge').disabled = true;
    try {
      if (mode === 'handicap') {
        msg.textContent = 'Reading ' + opp + "'s list…";
        var txt = await ghGetRaw('dutch/' + opp.toLowerCase() + '.csv');
        if (txt === null) throw new Error(opp + ' has no list yet');
        var oppProg = new Map(); M.csvRecords(txt).forEach(function (r) { oppProg.set(T.keyOf(r.dutch, r.english), r); });
        chosen = G.pickHandicap(words, progress, oppProg, today(), seed, G.ROUND);
      } else chosen = G.pickNormal(words, seed, G.ROUND);
      msg.textContent = '';
      startRound({ kind: 'challenge', flat: true, mode: mode, opp: opp, id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                   qs: G.makeQuestions(chosen, words, seed) });
    } catch (e) { msg.className = 'err'; msg.textContent = "Couldn't start the battle (" + e.message + ').'; }
    $('btnChallenge').disabled = false;
  }
  function playReply(s) {
    var qs; try { qs = JSON.parse(s.questions); } catch (e) { qs = null; }
    if (!qs || !qs.length) { $('battleMsg').className = 'err'; $('battleMsg').textContent = 'That challenge has no questions. Ask ' + s.a + ' to send it again.'; return; }
    startRound({ kind: 'reply', flat: true, mode: s.mode, opp: s.a, id: s.id, qs: qs });
  }

  function renderQuestion() {
    var q = round.qs[round.pos]; round.locked = false; round.t0 = Date.now();
    $('qInfo').textContent = 'Question ' + (round.pos + 1) + ' of ' + round.qs.length + ' · ' + round.pts + ' points' +
      (round.opp ? ' · battle vs ' + round.opp : '');
    $('qWord').textContent = q.d;
    $('qPrompt').hidden = !q.p; $('qPrompt').textContent = q.p || '';
    $('qStar').hidden = !(round.wotwKey && round.wotwKey === T.keyOf(q.d, q.e));
    var box = $('qOpts'); box.textContent = '';
    q.o.forEach(function (o, i) {
      box.appendChild(h('button', { type: 'button', class: 'opt', onclick: function () { answer(i); } }, h('b', { text: String(i + 1) }), h('span', { text: o })));
    });
    $('qFeedback').textContent = ''; $('qNext').hidden = true; $('qFlag').hidden = true;
  }
  function answer(i) {
    if (!round || round.locked) return;
    round.locked = true;
    var q = round.qs[round.pos], k = T.keyOf(q.d, q.e), good = q.a || q.e, ok = q.o[i] === good, ms = Date.now() - round.t0, t0 = today();
    var lv = T.levelOf(progress.get(k), t0), pts = ok ? G.questionPoints(lv, ms, round.flat) : 0;
    round.answers.push({ ok: ok, pts: pts, key: k }); round.pts += pts;
    var row = progress.get(k) || blankRow({ dutch: q.d, english: q.e }), fields = G.applyAnswer(row, ok, t0);
    pending[k] = { dutch: q.d, english: q.e, kind: 'answer', fields: fields }; store.set('pending.' + who, pending);
    Object.assign(row, fields); progress.set(k, row);
    Array.prototype.forEach.call($('qOpts').children, function (b, n) {
      b.disabled = true;
      if (q.o[n] === good) b.className = 'opt right'; else if (n === i) b.className = 'opt wrong';
    });
    $('qInfo').textContent = 'Question ' + (round.pos + 1) + ' of ' + round.qs.length + ' · ' + round.pts + ' points' +
      (round.opp ? ' · battle vs ' + round.opp : '');
    $('qFeedback').textContent = ok ? 'Right! +' + pts : 'Not quite. ' + (q.a ? q.a : q.d + ' = ' + q.e);
    $('qFeedback').className = ok ? 'ok' : 'err';
    $('qNext').textContent = round.pos + 1 >= round.qs.length ? 'Finish' : 'Next →'; $('qNext').hidden = false; $('qFlag').hidden = false;
    updateCounts();
  }
  function nextQuestion() {
    if (!round || !round.locked) return;
    round.locked = false;
    round.pos++;
    if (round.pos >= round.qs.length) finishRound(); else renderQuestion();
  }
  function quitRound() { round = null; showPlay('home'); $('roundMsg').textContent = 'Round stopped, no points. (Answers you gave still updated your word list.)'; if (pendingList().length && token) save(); }
  function finishRound() {
    var t0 = today(), dates = myDates(), flat = !!round.flat, newDay = dates.indexOf(t0) < 0;
    var streak = G.streakDays(dates.concat([t0]), t0);
    var wotwHit = !!round.wotwKey && round.answers.some(function (a) { return a.key === round.wotwKey && a.ok; });
    var res = G.scoreRound(round.answers, { flat: flat, wotwHit: wotwHit, newDay: newDay, streak: streak });
    var rid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    scoreQueue.push({ id: rid, date: t0, who: who, mode: round.kind === 'practice' ? 'practice' : (round.kind === 'drill' ? 'drill' : (round.mode === 'handicap' ? 'handicap' : 'battle')),
                      points: String(res.points), right: String(res.right), total: String(res.total), wotw: wotwHit ? '1' : '' });
    store.set('scoreQ', scoreQueue);
    var lines = ['You got ' + res.right + ' of ' + res.total + ' right and scored ' + res.points + ' points.'], p = res.parts;
    if (!flat) {
      if (p.perfect) lines.push('Perfect round: +' + p.perfect);
      if (p.wotw) lines.push('Word of the week: +' + p.wotw);
      if (p.streak) lines.push('Daily streak of ' + streak + (streak === 1 ? ' day' : ' days') + ': +' + p.streak);
    }
    if (flat) {
      battleQueue.push({ id: round.id, type: round.kind === 'challenge' ? 'challenge' : 'reply', date: t0, who: who, opponent: round.opp, mode: round.mode || 'normal',
                         score: String(res.points), right: String(res.right), total: String(res.total), questions: round.kind === 'challenge' ? JSON.stringify(round.qs) : '' });
      store.set('battleQ', battleQueue);
      if (round.kind === 'challenge') lines.push('Challenge sent to ' + round.opp + '. They will see it the next time they open the app.');
      else {
        var s = G.battleStates(battleRows()).filter(function (b) { return b.id === round.id; })[0];
        if (s && s.done) lines.push(s.winner === 'draw' ? 'It is a draw with ' + round.opp + '!' : (s.winner === who ? 'You beat ' + round.opp + '! ' : round.opp + ' won this one. ') + s.aScore + ' – ' + s.bScore);
      }
    }
    $('qSummary').textContent = ''; lines.forEach(function (l) { $('qSummary').appendChild(h('p', { text: l })); });
    round = null; showPlay('end');
    if (token) save();
    flushExtras(); renderGame();
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
      words.concat(drills).forEach(function (w) { var k = T.keyOf(w.dutch, w.english); if (!seen.has(k)) { seen.add(k); rows.push(w); } });
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
    if (which === 'play' || which === 'board') loadGame();
    ['sort', 'play', 'board', 'add', 'ideas'].forEach(function (t) {
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
  $('tabPlayBtn').addEventListener('click', function () { tab('play'); });
  $('tabBoardBtn').addEventListener('click', function () { tab('board'); });
  $('tabAddBtn').addEventListener('click', function () { tab('add'); });
  $('tabIdeasBtn').addEventListener('click', function () { tab('ideas'); });
  $('btnFlag').addEventListener('click', function () { openFlag(); });
  $('btnRound').addEventListener('click', startPractice);
  $('btnDrill').addEventListener('click', startDrill);
  $('btnChallenge').addEventListener('click', startBattle);
  $('qNext').addEventListener('click', nextQuestion);
  $('qQuit').addEventListener('click', quitRound);
  $('qFlag').addEventListener('click', function () { if (round) openFlag({ dutch: round.qs[round.pos].d, english: round.qs[round.pos].e }); });
  $('qDone').addEventListener('click', function () { showPlay('home'); });
  $('btnBoardRefresh').addEventListener('click', loadGame);
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
    if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT' || $('settings').open || $('flagDlg').open) return;
    if (!$('tabPlay').hidden && round) {
      if (/^[1-4]$/.test(ev.key)) answer(Number(ev.key) - 1);
      else if ((ev.key === 'Enter' || ev.key === ' ') && tg !== 'BUTTON') { ev.preventDefault(); nextQuestion(); }
      return;
    }
    if ($('tabSort').hidden) return;
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

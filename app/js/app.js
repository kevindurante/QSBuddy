/*
 * app.js — QSBuddy patch browser UI.
 *
 * Three kinds of bank show up in the sidebar:
 *   synth:<id>  banks inside the QS (User, Presets, GenMIDI, cards). Picking a
 *               program sends Bank Select (CC 0) + Program Change.
 *   lib:<id>    banks bundled from this repo (library/). Picking a program
 *               sends it to the QS edit buffer (SysEx 02 + 08) to audition it.
 *   file:<n>    .syx files the user opened or dropped in. Same as lib.
 * plus favs, a list of references into the other three.
 */
(function () {
  'use strict';

  var QS = window.QS;
  var INDEX = window.QSLIB_INDEX || { collections: [], cards: [] };

  function $(id) { return document.getElementById(id); }

  /* ---------------- persistence ---------------- */
  var store = {
    get: function (key, fallback) {
      try {
        var v = localStorage.getItem('qsb.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem('qsb.' + key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
    },
    remove: function (key) {
      try { localStorage.removeItem('qsb.' + key); } catch (e) { /* ignore */ }
    }
  };

  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  /* ---------------- banks on the synth ----------------
   * Bank Select (CC 0) values from the QS7 Reference Manual: 0 User,
   * 1-3 Preset 1-3, 4 GenMIDI, 5-15 card banks in the order the QS finds them.
   */
  var SYNTH_BANKS = [
    { id: 'user', title: 'User', short: 'USER', cc: 0, factory: 'factory-user' },
    { id: 'p1', title: 'Preset 1', short: 'PRESET1', cc: 1, factory: 'factory-p1' },
    { id: 'p2', title: 'Preset 2', short: 'PRESET2', cc: 2, factory: 'factory-p2' },
    { id: 'p3', title: 'Preset 3', short: 'PRESET3', cc: 3, factory: 'factory-p3' },
    { id: 'gm', title: 'GenMIDI', short: 'GENMIDI', cc: 4, factory: 'factory-gm' },
    { id: 'card1', title: 'Card bank 1', short: 'CARD1', cc: 5, card: true },
    { id: 'card2', title: 'Card bank 2', short: 'CARD2', cc: 6, card: true }
  ];
  var SYNTH_BY_ID = {};
  SYNTH_BANKS.forEach(function (b) { SYNTH_BY_ID[b.id] = b; });

  var LIB = {};
  INDEX.collections.forEach(function (c) {
    c.banks.forEach(function (b) { LIB[b.id] = { info: b, collection: c }; });
  });
  var CARDS = {};
  INDEX.cards.forEach(function (c) { CARDS[c.id] = c; });

  /* ---------------- state ---------------- */
  var midi = new window.QSMidi();
  var editor = null; // the program editor view (editor.js), created in start()
  var state = {
    view: store.get('view', 'synth:p1'),
    sel: store.get('sel', 0),
    live: null,
    query: '',
    results: [],
    resultSel: 0,
    ch: store.get('ch', 0),
    cards: store.get('cards', { card1: '', card2: '' }),
    scans: store.get('scans', {}),
    userEdits: store.get('userEdits', {}),
    favs: store.get('favs', []),
    collapsed: store.get('openGroups', { factory: false }),
    settings: Object.assign({ arrowSend: true, follow: true }, store.get('settings', {})),
    files: [],
    fileSeq: 0,
    identity: null,
    inquiry: 'idle',
    midiError: null,
    incomingBank: null,
    scan: null
  };
  var scanDataCache = {};

  /* ---------------- small helpers ---------------- */
  function pad3(n) { return String(n).padStart(3, '0'); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function norm(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function refEq(a, b) { return !!a && !!b && a.key === b.key && a.n === b.n; }

  function timeAgo(t) {
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString();
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isError ? 5000 : 2600);
  }

  /* ---------------- bank model ---------------- */
  function parseKey(key) {
    var i = key.indexOf(':');
    return i < 0 ? { kind: key, id: '' } : { kind: key.slice(0, i), id: key.slice(i + 1) };
  }

  function synthNames(sb) {
    var scan = state.scans[sb.id];
    var names;
    if (scan) names = scan.names.slice();
    else if (sb.factory && LIB[sb.factory]) names = LIB[sb.factory].info.names.slice();
    else if (sb.card && CARDS[state.cards[sb.id]]) names = CARDS[state.cards[sb.id]].names.slice();
    else names = new Array(128).fill(null);
    if (sb.id === 'user') {
      Object.keys(state.userEdits).forEach(function (n) { names[n] = state.userEdits[n].name; });
    }
    return names;
  }

  function bankExists(key) {
    var k = parseKey(key);
    if (k.kind === 'synth') return !!SYNTH_BY_ID[k.id];
    if (k.kind === 'lib') return !!LIB[k.id];
    if (k.kind === 'file') return state.files.some(function (f) { return f.key === key; });
    return k.kind === 'favs';
  }

  function getView(key) {
    var k = parseKey(key);
    var items;
    if (k.kind === 'synth') {
      var sb = SYNTH_BY_ID[k.id];
      items = synthNames(sb).map(function (name, n) { return { n: n, name: name, ref: { key: key, n: n } }; });
      return { key: key, kind: 'synth', synth: sb, title: sb.title, short: sb.short, items: items };
    }
    if (k.kind === 'lib') {
      var lib = LIB[k.id];
      items = lib.info.names.map(function (name, n) { return { n: n, name: name, ref: { key: key, n: n } }; });
      return { key: key, kind: 'lib', lib: lib, title: lib.info.title, short: lib.info.title, items: items };
    }
    if (k.kind === 'file') {
      var f = state.files.filter(function (x) { return x.key === key; })[0];
      items = f.bank.names.map(function (name, n) {
        return { n: n, name: name ? name.trimEnd() : null, ref: { key: key, n: n } };
      });
      return { key: key, kind: 'file', file: f, title: f.title, short: f.title, items: items };
    }
    items = state.favs.map(function (fav) {
      return { n: fav.n, name: fav.name, sub: shortLabel(fav.key), ref: { key: fav.key, n: fav.n } };
    });
    return { key: 'favs', kind: 'favs', title: 'Favorites', short: 'FAV', items: items };
  }

  function shortLabel(key) {
    if (!bankExists(key)) return '?';
    var k = parseKey(key);
    if (k.kind === 'synth') return SYNTH_BY_ID[k.id].title;
    if (k.kind === 'lib') return libLabel(k.id);
    return getView(key).title;
  }

  // "Alesis Expando · Synths" reads better than a bare "Synths" outside the sidebar.
  function libLabel(id) {
    var lib = LIB[id];
    if (lib.collection.id === 'qcard-extras' || lib.collection.id === 'category') return lib.info.title;
    return lib.collection.title + ' · ' + lib.info.title;
  }

  function currentView() { return getView(state.view); }

  function itemFor(ref) {
    if (!ref || !bankExists(ref.key)) return null;
    return getView(ref.key).items[ref.n] || null;
  }

  function currentRef() {
    if (state.query) {
      var r = state.results[state.resultSel];
      return r ? { key: r.key, n: r.n } : null;
    }
    var item = currentView().items[state.sel];
    return item ? item.ref : null;
  }

  function sidebarOrder() {
    var keys = SYNTH_BANKS.map(function (b) { return 'synth:' + b.id; });
    keys.push('favs');
    state.files.forEach(function (f) { keys.push(f.key); });
    INDEX.collections.forEach(function (c) { c.banks.forEach(function (b) { keys.push('lib:' + b.id); }); });
    return keys;
  }

  /* ---------------- program data (for inspector, audition, store) ---------------- */
  function loadScanData(id) {
    if (!scanDataCache[id]) {
      var raw = store.get('scanData.' + id, null);
      scanDataCache[id] = raw ? raw.map(function (s) { return s ? window.QSLIB.fromBase64(s) : null; }) : [];
    }
    return scanDataCache[id];
  }

  function getProgramData(ref) {
    var k = parseKey(ref.key);
    if (k.kind === 'synth') {
      var sb = SYNTH_BY_ID[k.id];
      var edit = sb.id === 'user' && state.userEdits[ref.n];
      if (edit) {
        return Promise.resolve({
          program: window.QSLIB.fromBase64(edit.program),
          effect: edit.effect ? window.QSLIB.fromBase64(edit.effect) : null,
          origin: 'Stored from this browser ' + timeAgo(edit.at)
        });
      }
      var scanned = state.scans[sb.id] && loadScanData(sb.id)[ref.n];
      if (scanned) {
        return Promise.resolve({ program: scanned, effect: null, origin: 'Read from the QS ' + timeAgo(state.scans[sb.id].at) });
      }
      if (sb.factory) {
        return window.QSLIB.load(sb.factory).then(function (bank) {
          return {
            program: bank.programs[ref.n],
            effect: bank.effects[ref.n],
            origin: sb.id === 'user' ? 'Factory default data. Your QS may hold something else here.' : 'Factory data'
          };
        });
      }
      return Promise.resolve(null);
    }
    if (k.kind === 'lib') {
      return window.QSLIB.load(k.id).then(function (bank) {
        return { program: bank.programs[ref.n], effect: bank.effects[ref.n], origin: 'Library' };
      });
    }
    if (k.kind === 'file') {
      var f = state.files.filter(function (x) { return x.key === ref.key; })[0];
      if (!f || !f.bank.programs[ref.n]) return Promise.resolve(null);
      return Promise.resolve({ program: f.bank.programs[ref.n], effect: f.bank.effects[ref.n], origin: 'Opened file' });
    }
    return Promise.resolve(null);
  }

  /* ---------------- sending ---------------- */
  function needOutput() {
    if (midi.out) return true;
    toast(state.midiError ? state.midiError : 'Choose the MIDI output connected to your QS first.', true);
    return false;
  }

  function sendRef(ref) {
    if (!ref || !bankExists(ref.key)) return Promise.resolve(false);
    var k = parseKey(ref.key);
    if (k.kind === 'synth') return Promise.resolve(sendSynth(SYNTH_BY_ID[k.id], ref));
    return audition(ref);
  }

  // Plain Bank Select + Program Change only, so patch changes also work through
  // MIDI chains that drop SysEx. Don't put SysEx (such as Mode Select) in front
  // without re-testing on a real QS; see docs/architecture.md.
  function sendSynth(sb, ref) {
    if (!needOutput()) return false;
    midi.send(QS.build.bankSelect(state.ch, sb.cc));
    midi.send(QS.build.programChange(state.ch, ref.n));
    setLive(ref, 'program');
    return true;
  }

  function audition(ref) {
    if (!needOutput()) return Promise.resolve(false);
    if (!midi.sysex) {
      toast('Library patches need SysEx. Reload the page and allow SysEx access when the browser asks.', true);
      return Promise.resolve(false);
    }
    return getProgramData(ref).then(function (d) {
      if (!d || !d.program) return false;
      midi.send(QS.build.editProgramDump(0, d.program));
      if (d.effect) midi.send(QS.build.editEffectDump(0, d.effect));
      setLive(ref, 'edit');
      return true;
    }).catch(function (err) { toast(err.message, true); return false; });
  }

  // Arrow-key browsing through library banks sends ~500 bytes per step;
  // debounce so holding a key doesn't queue up dozens of dumps.
  var sendTimer = null;
  function sendSoon(ref) {
    clearTimeout(sendTimer);
    var k = parseKey(ref.key);
    if (k.kind === 'synth') { sendRef(ref); return; }
    sendTimer = setTimeout(function () { sendRef(ref); }, 140);
  }

  function setLive(ref, how) {
    state.live = { key: ref.key, n: ref.n, how: how };
    renderLcd();
    updateGridMarks();
    updateResultMarks();
    updateSidebarMarks();
  }

  /* ---------------- MIDI setup ---------------- */
  function guessPort(ports, storedId) {
    if (storedId && ports.some(function (p) { return p.id === storedId; })) return storedId;
    var named = ports.filter(function (p) { return /\bqs|alesis|quadra/i.test(p.name); });
    if (named.length) return named[0].id;
    var real = ports.filter(function (p) { return !/microsoft gs|wavetable/i.test(p.name); });
    return real.length === 1 ? real[0].id : '';
  }

  function fillSelect(sel, ports, selectedId, emptyLabel) {
    sel.innerHTML = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = ports.length ? emptyLabel : 'No ports found';
    sel.appendChild(none);
    ports.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.value = selectedId || '';
  }

  function renderPorts() {
    var outs = midi.outputs();
    var ins = midi.inputs();
    var outId = midi.out ? midi.out.id : guessPort(outs, store.get('out', ''));
    var inId = midi.in ? midi.in.id : guessPort(ins, store.get('in', ''));
    fillSelect($('outSelect'), outs, outId, '— choose output —');
    fillSelect($('inSelect'), ins, inId, '— none —');
    if (!midi.out && outId) midi.setOutput(outId);
    if (!midi.in && inId) midi.setInput(inId);
  }

  function identify() {
    state.identity = null;
    if (!midi.out || !midi.in || !midi.sysex) { state.inquiry = 'idle'; renderStatus(); return; }
    state.inquiry = 'pending';
    renderStatus();
    midi.request(QS.build.deviceInquiry(), function (b, p) { return p && p.kind === 'identity'; }, 1500)
      .then(function (id) {
        state.identity = id;
        state.inquiry = 'done';
        renderStatus();
      })
      .catch(function () {
        state.inquiry = 'none';
        renderStatus();
      });
  }

  function renderStatus() {
    var el = $('status');
    var text, st, title = '';
    if (state.midiError) { text = state.midiError; st = 'error'; }
    else if (!midi.out) { text = 'No output'; st = 'warn'; title = 'Choose the MIDI output that goes to the QS MIDI In.'; }
    else if (state.identity) {
      text = state.identity.model + ' · v' + state.identity.version + (midi.sysex ? '' : ' · no SysEx');
      st = 'ok';
    }
    else if (!midi.sysex) { text = 'No SysEx'; st = 'warn'; title = 'Program changes work. Allow SysEx to audition library patches and read names.'; }
    else if (!midi.in) { text = 'Output only'; st = 'ok'; title = 'Program changes and auditions work. Pick a MIDI In to read names from the QS.'; }
    else if (state.inquiry === 'pending') { text = 'Looking for the QS…'; st = 'idle'; }
    else if (state.inquiry === 'none') { text = 'No reply from QS'; st = 'warn'; title = 'Program changes still work. Either SysEx isn\'t reaching the QS (a sequencer or merger in the MIDI chain may drop it), or the QS MIDI Out isn\'t connected to your MIDI In. Click to retry.'; }
    else { text = 'Ready'; st = 'ok'; }
    el.textContent = text;
    el.dataset.state = st;
    el.title = title;
  }

  function onMidiIn(bytes, parsed) {
    if (parsed && parsed.kind === 'identity') {
      state.identity = parsed;
      renderStatus();
      return;
    }
    var status = bytes[0] & 0xF0;
    var ch = bytes[0] & 0x0F;
    if (status === 0xC0 && ch === state.ch && editor.isOpen()) {
      editor.externalChange('The QS switched to program ' + bytes[1] + ' (a Program Change on channel ' + (ch + 1) +
        '), so it no longer plays what you\'re editing. Resync sends your version back to its edit buffer.');
    }
    if (ch !== state.ch || !state.settings.follow) return;
    if (status === 0xB0 && bytes[1] === 0x00) {
      state.incomingBank = bytes[2];
    } else if (status === 0xC0) {
      var sb = null;
      var cc = state.incomingBank;
      if (cc === null) {
        var liveK = state.live ? parseKey(state.live.key) : null;
        sb = liveK && liveK.kind === 'synth' ? SYNTH_BY_ID[liveK.id] : null;
      } else {
        sb = SYNTH_BANKS.filter(function (b) { return b.cc === cc; })[0] || null;
      }
      if (!sb) return;
      var ref = { key: 'synth:' + sb.id, n: bytes[1] };
      setLive(ref, 'program');
      if (parseKey(state.view).kind === 'synth' && !state.query) setView(ref.key, { sel: ref.n });
    }
  }

  /* ---------------- rendering: LCD ---------------- */
  function renderLcd() {
    var top = $('lcdTop');
    var name = $('lcdName');
    var live = state.live;
    if (editor && editor.name() !== null) {
      top.textContent = ('EDIT' + (editor.isModified() ? '*' : '') + ' ← ' + editor.title() + '   CH' + (state.ch + 1)).toUpperCase();
      name.textContent = editor.name();
      return;
    }
    if (!live || !bankExists(live.key)) {
      top.textContent = 'NO PROGRAM SENT';
      name.textContent = '----------';
      return;
    }
    var item = itemFor(live);
    var k = parseKey(live.key);
    var label = k.kind === 'synth' ? SYNTH_BY_ID[k.id].short + ' ' + pad3(live.n) : 'EDIT ← ' + shortLabel(live.key) + ' ' + pad3(live.n);
    top.textContent = (label + '   CH' + (state.ch + 1)).toUpperCase();
    name.textContent = item && item.name ? item.name : '?';
  }

  /* ---------------- rendering: sidebar ---------------- */
  function navButton(key, label, tag, meta) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-item';
    b.dataset.key = key;
    b.innerHTML = (tag !== null ? '<span class="tag">' + esc(tag) + '</span>' : '') +
      '<span class="label">' + esc(label) + '</span>' +
      (meta ? '<span class="meta">' + esc(meta) + '</span>' : '');
    return b;
  }

  function heading(text) {
    var h = document.createElement('div');
    h.className = 'nav-heading';
    h.textContent = text;
    return h;
  }

  function renderSidebar() {
    var nav = $('sidebar');
    nav.innerHTML = '';
    var model = state.identity ? state.identity.model : 'QS';
    nav.appendChild(heading('On the ' + model + ' · bank select'));
    SYNTH_BANKS.forEach(function (sb) {
      var meta = '';
      if (sb.card) meta = CARDS[state.cards[sb.id]] ? CARDS[state.cards[sb.id]].title.split(' ')[0] : '';
      if (state.scans[sb.id]) meta = meta || 'read';
      nav.appendChild(navButton('synth:' + sb.id, sb.title, String(sb.cc), meta));
    });

    nav.appendChild(heading('Yours'));
    nav.appendChild(navButton('favs', 'Favorites', '★', String(state.favs.length)));
    state.files.forEach(function (f) {
      nav.appendChild(navButton(f.key, f.title, 'syx', String(f.bank.programCount)));
    });
    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'nav-open';
    open.textContent = 'Open .syx file…';
    open.addEventListener('click', function () { $('fileInput').click(); });
    nav.appendChild(open);

    nav.appendChild(heading('Library · audition via SysEx'));
    INDEX.collections.forEach(function (c) {
      var d = document.createElement('details');
      d.className = 'nav-group';
      var isOpen = state.collapsed[c.id] !== undefined ? state.collapsed[c.id] : false;
      if (isOpen || parseKey(state.view).kind === 'lib' && LIB[parseKey(state.view).id].collection === c) d.open = true;
      var s = document.createElement('summary');
      s.innerHTML = esc(c.title) + '<span class="count">' + c.banks.length + '</span>';
      d.appendChild(s);
      c.banks.forEach(function (b) {
        d.appendChild(navButton('lib:' + b.id, b.title, null, ''));
      });
      d.addEventListener('toggle', function () {
        state.collapsed[c.id] = d.open;
        store.set('openGroups', state.collapsed);
      });
      nav.appendChild(d);
    });
    updateSidebarMarks();
  }

  function updateSidebarMarks() {
    var liveKey = state.live ? state.live.key : null;
    document.querySelectorAll('#sidebar .nav-item').forEach(function (b) {
      var current = b.dataset.key === state.view;
      b.setAttribute('aria-current', current ? 'true' : 'false');
      b.classList.toggle('live', b.dataset.key === liveKey);
    });
  }

  /* ---------------- rendering: toolbar + notice ---------------- */
  function renderToolbar() {
    var view = currentView();
    $('bankTitle').textContent = view.title;
    var sub = '';
    var actions = $('bankActions');
    actions.innerHTML = '';

    if (view.kind === 'synth') {
      var sb = view.synth;
      var scan = state.scans[sb.id];
      sub = 'Bank select ' + sb.cc + ' · ';
      if (scan) sub += 'names read from the QS ' + timeAgo(scan.at);
      else if (sb.id === 'user') sub += 'factory default names';
      else if (sb.factory) sub += 'ROM preset bank';
      else sub += CARDS[state.cards[sb.id]] ? CARDS[state.cards[sb.id]].title + ' (names from the card image)' : 'names unknown';

      if (sb.card) {
        var sel = document.createElement('select');
        sel.setAttribute('aria-label', 'Card in this bank');
        sel.innerHTML = '<option value="">Card: unknown / other</option>' + INDEX.cards.map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>';
        }).join('');
        sel.value = state.cards[sb.id] || '';
        sel.addEventListener('change', function () {
          state.cards[sb.id] = sel.value;
          store.set('cards', state.cards);
          delete state.scans[sb.id];
          store.set('scans', state.scans);
          store.remove('scanData.' + sb.id);
          delete scanDataCache[sb.id];
          renderAll();
        });
        actions.appendChild(sel);
      }
      var read = document.createElement('button');
      read.type = 'button';
      read.className = 'btn small';
      read.textContent = state.scan ? 'Reading…' : 'Read names from QS';
      read.disabled = !!state.scan;
      read.title = sb.id === 'user'
        ? 'Requests each User program from the QS (about 20 s). Doesn\'t change anything on the QS.'
        : 'Steps through every program in this bank on the QS and reads its name (about 25 s).';
      read.addEventListener('click', function () { scanBank(sb); });
      actions.appendChild(read);
    } else if (view.kind === 'lib') {
      sub = view.lib.collection.title + ' · ' + view.lib.info.source.split('/').pop();
    } else if (view.kind === 'file') {
      sub = 'Opened file · ' + view.file.bank.programCount + ' programs · not saved between sessions';
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn small';
      close.textContent = 'Close file';
      close.addEventListener('click', function () {
        state.files = state.files.filter(function (f) { return f.key !== view.key; });
        state.favs = state.favs.filter(function (f) { return f.key !== view.key; });
        setView('synth:p1');
        renderSidebar();
      });
      actions.appendChild(close);
    } else {
      sub = state.favs.length ? 'Press F on any patch to add or remove it.' : '';
    }
    $('bankSub').textContent = sub;
    renderNotice();
  }

  function renderNotice() {
    var el = $('notice');
    var view = currentView();
    el.className = 'notice';
    if (state.scan) {
      el.hidden = false;
      el.innerHTML = '<span class="grow">Reading names from the QS · ' + esc(state.scan.title) + ' · ' +
        state.scan.done + ' / 128</span><span class="progress"><span style="width:' + (state.scan.done / 1.28) +
        '%"></span></span>';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn small';
      cancel.textContent = 'Stop';
      cancel.addEventListener('click', function () { state.scan.cancel = true; });
      el.appendChild(cancel);
      return;
    }
    var msg = '';
    var warn = false;
    if (view.kind === 'synth') {
      var sb = view.synth;
      if (sb.id === 'user' && !state.scans.user) {
        msg = 'These are the factory default User names. If you\'ve stored your own sounds, use "Read names from QS" to see what\'s really there.';
      } else if (sb.card && !state.scans[sb.id] && !CARDS[state.cards[sb.id]]) {
        msg = 'Pick the card that\'s in this bank to see its names, or read them from the QS. Card banks are numbered in the order the QS finds them, starting at bank select 5. You can still send programs without names.';
      }
    } else if (view.kind === 'lib' || view.kind === 'file') {
      if (!midi.sysex && !state.midiError) { msg = 'SysEx access is off, so these can\'t be sent. Reload and allow SysEx when the browser asks.'; warn = true; }
      else if (view.kind === 'lib' && view.lib.collection.id === 'qcard-extras') { msg = view.lib.collection.note; warn = true; }
      else if (view.kind === 'lib' && view.lib.info.quadraPlus) { msg = 'QuadraSynth / S4 Plus format. The QS remaps the samples when it receives these, so some programs will sound different from the original.'; warn = true; }
      else msg = 'Patches load into the QS edit buffer only. Your User bank isn\'t changed until you press STORE on the QS or use "Store to User…".';
    } else if (view.kind === 'favs' && !state.favs.length) {
      msg = 'No favorites yet. Select any patch and press F (or the star button) to keep it here.';
    }
    el.hidden = !msg;
    el.classList.toggle('warn', warn);
    el.textContent = msg;
  }

  /* ---------------- rendering: grid ---------------- */
  function renderGrid() {
    var grid = $('grid');
    var view = currentView();
    grid.innerHTML = '';
    state.sel = Math.max(0, Math.min(state.sel, view.items.length - 1));
    if (!view.items.length) {
      grid.innerHTML = '<div class="empty-state">Nothing here yet.</div>';
      renderInspector();
      return;
    }
    var frag = document.createDocumentFragment();
    view.items.forEach(function (it, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.dataset.i = i;
      b.setAttribute('role', 'option');
      b.tabIndex = -1;
      var sendable = !!it.name || view.kind === 'synth';
      if (!sendable) b.classList.add('empty');
      var name = it.name || (view.kind === 'synth' ? '—' : '');
      var num = view.kind === 'favs' ? '' : '<span class="num">' + pad3(it.n) + '</span>';
      if (it.sub) {
        b.innerHTML = num + '<span class="stack"><span class="name">' + esc(name) + '</span><span class="sub">' +
          esc(it.sub) + ' · ' + pad3(it.n) + '</span></span>';
      } else {
        b.innerHTML = num + '<span class="name">' + esc(name) + '</span>';
      }
      b.title = name + (it.sub ? ' (' + it.sub + ')' : '');
      frag.appendChild(b);
    });
    grid.appendChild(frag);
    updateGridMarks(true);
  }

  function isFav(ref) {
    return state.favs.some(function (f) { return refEq(f, ref); });
  }

  function updateGridMarks(scroll) {
    var view = currentView();
    var cells = $('grid').querySelectorAll('.cell');
    cells.forEach(function (c) {
      var i = Number(c.dataset.i);
      var it = view.items[i];
      if (!it) return;
      var sel = i === state.sel;
      c.classList.toggle('selected', sel);
      c.setAttribute('aria-selected', sel ? 'true' : 'false');
      c.classList.toggle('live', refEq(it.ref, state.live));
      c.classList.toggle('fav', view.kind !== 'favs' && isFav(it.ref));
    });
    if (scroll && cells[state.sel]) cells[state.sel].scrollIntoView({ block: 'nearest' });
  }

  function gridColumns() {
    var cols = getComputedStyle($('grid')).gridTemplateColumns.split(' ').length;
    return Math.max(1, cols);
  }

  /* ---------------- rendering: search results ---------------- */
  function runSearch() {
    var q = state.query.trim();
    var out = [];
    if (!q) { state.results = []; return; }
    var lq = q.toLowerCase();
    var nq = norm(q);
    var seen = {};
    function scan(key, names, label) {
      if (seen[key]) return;
      seen[key] = true;
      names.forEach(function (name, n) {
        if (!name) return;
        if (name.toLowerCase().indexOf(lq) >= 0 || (nq && norm(name).indexOf(nq) >= 0)) {
          out.push({ key: key, n: n, name: name.trimEnd(), label: label });
        }
      });
    }
    var view = currentView();
    if (view.kind !== 'favs') scan(view.key, view.items.map(function (i) { return i.name; }), shortLabel(view.key));
    SYNTH_BANKS.forEach(function (sb) { scan('synth:' + sb.id, synthNames(sb), 'QS ' + sb.title); });
    state.files.forEach(function (f) { scan(f.key, f.bank.names, f.title); });
    INDEX.collections.forEach(function (c) {
      if (c.id === 'factory') return; // already listed as the synth's own banks
      c.banks.forEach(function (b) { scan('lib:' + b.id, b.names, libLabel(b.id)); });
    });
    state.results = out;
  }

  var RESULT_LIMIT = 300;

  function renderResults() {
    var box = $('results');
    var searching = !!state.query.trim();
    var wasSearching = !box.hidden;
    box.hidden = !searching;
    $('grid').hidden = searching;
    if (!searching) {
      if (wasSearching) renderToolbar();
      return;
    }
    $('bankTitle').textContent = 'Search';
    $('bankSub').textContent = 'Every bank on the QS, in the library and in opened files';
    $('bankActions').innerHTML = '';
    $('notice').hidden = true;
    box.innerHTML = '';
    var meta = document.createElement('p');
    meta.className = 'results-meta';
    var n = state.results.length;
    meta.textContent = n === 0 ? 'No patches match.' :
      n + (n === 1 ? ' match' : ' matches') + (n > RESULT_LIMIT ? ', showing the first ' + RESULT_LIMIT : '') +
      ' · ↑↓ to move, Enter to send, Esc to go back';
    box.appendChild(meta);
    var frag = document.createDocumentFragment();
    state.results.slice(0, RESULT_LIMIT).forEach(function (r, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      b.dataset.i = i;
      b.tabIndex = -1;
      b.innerHTML = '<span class="name">' + esc(r.name) + '</span><span class="bank">' + esc(r.label) +
        '</span><span class="num">' + pad3(r.n) + '</span>';
      frag.appendChild(b);
    });
    box.appendChild(frag);
    updateResultMarks(true);
  }

  function updateResultMarks(scroll) {
    var rows = $('results').querySelectorAll('.result');
    rows.forEach(function (row) {
      var i = Number(row.dataset.i);
      var r = state.results[i];
      row.classList.toggle('selected', i === state.resultSel);
      row.style.boxShadow = refEq(r, state.live) ? 'inset 3px 0 0 var(--live)' : '';
    });
    if (scroll && rows[state.resultSel]) rows[state.resultSel].scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- rendering: inspector ---------------- */
  var inspectorToken = 0;

  function renderInspector() {
    var body = $('inspectorBody');
    var token = ++inspectorToken;
    if (editor && editor.isOpen()) {
      editor.renderInspector(body);
      return;
    }
    var ref = currentRef();
    var item = itemFor(ref);
    if (!ref || !item) {
      body.innerHTML = '<p class="muted">Pick a program to see its details.</p>';
      return;
    }
    var k = parseKey(ref.key);
    var isSynth = k.kind === 'synth';
    var sb = isSynth ? SYNTH_BY_ID[k.id] : null;
    var title = isSynth ? 'QS ' + sb.title : shortLabel(ref.key);
    var tags = [];
    if (k.kind === 'lib') {
      var lib = LIB[k.id];
      tags.push({ t: lib.collection.title });
      if (lib.info.quadraPlus) tags.push({ t: 'QuadraSynth Plus format', warn: true });
      if (lib.collection.id === 'qcard-extras') tags.push({ t: 'Needs ' + lib.info.title.split(' ')[0] + ' card', warn: true });
    }
    var fav = isFav(ref);
    var html = '<div><div class="insp-num">' + esc(title) + ' · ' + pad3(ref.n) + '</div>' +
      '<div class="insp-name">' + esc(item.name || '—') + '</div>' +
      (tags.length ? '<div class="tags">' + tags.map(function (t) {
        return '<span class="tag-pill' + (t.warn ? ' warn' : '') + '">' + esc(t.t) + '</span>';
      }).join('') + '</div>' : '') + '</div>';

    html += '<div class="insp-actions">';
    html += '<button type="button" class="btn primary" data-act="send">' + (isSynth ? '▶ Select on QS' : '▶ Audition') + '</button>';
    html += '<button type="button" class="btn' + (fav ? ' active' : '') + '" data-act="fav" title="Favorite (F)">' + (fav ? '★' : '☆') + '</button>';
    html += '<button type="button" class="btn" data-act="edit" title="Make this the playing program and edit it from here">Edit</button>';
    if (!isSynth) {
      html += '<button type="button" class="btn" data-act="store">Store to User…</button>';
    }
    html += '<button type="button" class="btn" data-act="download" title="Save this program as a .syx file">.syx</button>';
    html += '</div>';
    html += '<p class="insp-hint">' + (isSynth
      ? 'Sends Bank Select ' + sb.cc + ' and Program Change ' + ref.n + ' on channel ' + (state.ch + 1) + '.'
      : 'Loads into the QS edit buffer. Press STORE on the QS to keep it.') + '</p>';
    html += '<div id="inspDetails"><p class="muted">Loading details…</p></div>';
    body.innerHTML = html;

    getProgramData(ref).then(function (d) {
      if (token !== inspectorToken) return;
      var box = $('inspDetails');
      if (!d || !d.program) {
        box.innerHTML = '<p class="muted">' + (isSynth
          ? 'No program data for this bank yet. Use "Read names from QS" to fetch it.'
          : 'Empty slot.') + '</p>';
        body.querySelector('[data-act="download"]').disabled = true;
        // A synth program can still be edited: the editor reads it from the QS.
        if (!isSynth) body.querySelector('[data-act="edit"]').disabled = true;
        return;
      }
      box.innerHTML = renderDetails(d);
    }).catch(function (err) {
      if (token === inspectorToken) $('inspDetails').innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
    });
  }

  var PAN = ['L3', 'L2', 'L1', 'C', 'R1', 'R2', 'R3'];

  function signed(v) { return (v > 0 ? '+' : '') + v; }

  function renderDetails(d) {
    var prog = QS.decodeProgram(d.program);
    var html = '<div><h3 class="section-title">Sounds</h3><div class="sounds">';
    prog.sounds.forEach(function (s) {
      if (s.type === 'drum') {
        var notes = s.drums.map(function (x) { return x.note; });
        html += '<div class="sound' + (s.enabled ? '' : ' off') + '"><div class="sound-head"><b>Sound ' + (s.index + 1) +
          ' · Drums</b><span>' + (s.enabled ? 'on' : 'off') + '</span></div><dl class="kv">' +
          '<dt>Drums</dt><dd>10 (' + QS.noteName(Math.min.apply(null, notes)) + '–' + QS.noteName(Math.max.apply(null, notes)) + ')</dd>' +
          '</dl></div>';
        return;
      }
      html += '<div class="sound' + (s.enabled ? '' : ' off') + '"><div class="sound-head"><b>Sound ' + (s.index + 1) +
        ' · Keys</b><span>' + (s.enabled ? 'on' : 'off') + '</span></div><dl class="kv">' +
        '<dt>Sample</dt><dd>group ' + s.sampleGroup + ' · #' + s.sampleNum + '</dd>' +
        '<dt>Range</dt><dd>' + QS.noteName(s.lowNote) + ' – ' + QS.noteName(s.highNote) + '</dd>' +
        '<dt>Level</dt><dd>vol ' + s.volume + ' · pan ' + (PAN[s.pan] || s.pan) + '</dd>' +
        '<dt>Tune</dt><dd>' + signed(s.semitone) + ' st · ' + signed(s.detune) + ' ct</dd>' +
        '<dt>Filter</dt><dd>' + s.filterFreq + '</dd>' +
        '<dt>Amp env</dt><dd>' + [s.ampAttack, s.ampDecay, s.ampSustain, s.ampRelease].join(' / ') + '</dd>' +
        '<dt>FX send</dt><dd>bus ' + (s.fxBus + 1) + ' · ' + s.fxLevel + '</dd>' +
        '</dl></div>';
    });
    html += '</div></div>';
    if (d.effect) {
      var fx = QS.decodeEffect(d.effect);
      html += '<div><h3 class="section-title">Effect</h3><p class="muted" style="margin:0">Configuration ' + fx.config + ': ' + esc(fx.configName) + '</p></div>';
    }
    html += '<p class="muted" style="margin:0;font-size:12px">' + esc(d.origin) + '</p>';
    return html;
  }

  function renderAll() {
    renderSidebar();
    renderToolbar();
    renderGrid();
    renderResults();
    renderInspector();
    renderLcd();
  }

  /* ---------------- view + selection ---------------- */
  function setView(key, opts) {
    opts = opts || {};
    if (!bankExists(key)) key = 'synth:p1';
    var changed = key !== state.view;
    state.view = key;
    var view = currentView();
    var sel = opts.sel;
    if (sel === undefined) sel = changed ? (state.live && state.live.key === key ? state.live.n : 0) : state.sel;
    state.sel = Math.max(0, Math.min(sel, Math.max(0, view.items.length - 1)));
    store.set('view', key);
    store.set('sel', state.sel);
    updateSidebarMarks();
    renderToolbar();
    if (changed || opts.rerender) renderGrid();
    else updateGridMarks(true);
    renderInspector();
  }

  function select(i, send) {
    var view = currentView();
    if (!view.items.length) return;
    state.sel = Math.max(0, Math.min(i, view.items.length - 1));
    store.set('sel', state.sel);
    updateGridMarks(true);
    renderInspector();
    var item = view.items[state.sel];
    if (send && (item.name || view.kind === 'synth')) sendSoon(item.ref);
  }

  function selectResult(i, send) {
    if (!state.results.length) return;
    state.resultSel = Math.max(0, Math.min(i, Math.min(state.results.length, RESULT_LIMIT) - 1));
    updateResultMarks(true);
    renderInspector();
    if (send) sendSoon(currentRef());
  }

  function clearSearch() {
    var ref = state.query ? currentRef() : null;
    state.query = '';
    $('search').value = '';
    state.results = [];
    renderResults();
    if (ref) setView(ref.key, { sel: ref.n });
    else renderInspector();
  }

  function toggleFav(ref) {
    if (!ref) return;
    var item = itemFor(ref);
    if (!item || !item.name) return;
    if (isFav(ref)) {
      state.favs = state.favs.filter(function (f) { return !refEq(f, ref); });
      toast('Removed from favorites');
    } else {
      state.favs.push({ key: ref.key, n: ref.n, name: item.name });
      toast('Added ' + item.name.trim() + ' to favorites');
    }
    // Opened files don't survive a reload, so only persist the rest.
    store.set('favs', state.favs.filter(function (f) { return parseKey(f.key).kind !== 'file'; }));
    if (state.view === 'favs') {
      renderGrid();
      renderToolbar();
    } else {
      updateGridMarks();
    }
    renderInspector();
    var nav = document.querySelector('#sidebar [data-key="favs"] .meta');
    if (nav) nav.textContent = String(state.favs.length);
  }

  /* ---------------- reading names from the QS ---------------- */
  function isEditDump(b, p) { return p && p.kind === 'qs' && p.op === QS.OP.EDIT_PROGRAM; }

  function scanBank(sb) {
    if (state.scan) return;
    if (!needOutput()) return;
    if (!midi.sysex) { toast('Reading names needs SysEx access. Reload and allow it.', true); return; }
    if (!midi.in) { toast('Choose the MIDI In that the QS MIDI Out is connected to.', true); return; }
    var scan = { sb: sb, title: sb.title, done: 0, cancel: false };
    state.scan = scan;
    renderToolbar();
    var names = new Array(128).fill(null);
    var datas = new Array(128).fill(null);

    function isUserDump(n) { return function (b, p) { return p && p.kind === 'qs' && p.op === QS.OP.USER_PROGRAM && p.num === n; }; }

    (async function () {
      var error = null;
      try {
        for (var n = 0; n < 128; n++) {
          if (scan.cancel) break;
          var reply;
          if (sb.id === 'user') {
            reply = await midi.request(QS.build.userProgramRequest(n), isUserDump(n), 2500);
          } else {
            midi.send(QS.build.bankSelect(state.ch, sb.cc));
            midi.send(QS.build.programChange(state.ch, n));
            await sleep(60);
            reply = await midi.request(QS.build.editProgramRequest(0), isEditDump, 2500);
          }
          datas[n] = reply.data.slice(0, QS.SIZE.program);
          names[n] = QS.programName(datas[n]).trimEnd();
          scan.done = n + 1;
          if (n % 4 === 3) renderNotice();
        }
      } catch (err) {
        error = err;
      }
      state.scan = null;
      var got = scan.done;
      if (got > 0) {
        var prior = state.scans[sb.id];
        if (prior && got < 128) {
          // Keep names we already had for the part we didn't reach.
          for (var i = got; i < 128; i++) names[i] = prior.names[i];
        } else if (!prior && got < 128) {
          var fallback = synthNames(sb);
          for (var j = got; j < 128; j++) names[j] = fallback[j];
        }
        state.scans[sb.id] = { names: names, at: Date.now(), partial: got < 128 };
        store.set('scans', state.scans);
        var old = loadScanData(sb.id);
        var merged = datas.map(function (d, i) { return d || old[i] || null; });
        scanDataCache[sb.id] = merged;
        store.set('scanData.' + sb.id, merged.map(function (d) { return d ? toB64(d) : null; }));
        if (sb.id === 'user' && got === 128) { state.userEdits = {}; store.set('userEdits', {}); }
      }
      if (error && error.code === 'timeout' && got === 0) {
        toast('No reply from the QS. Check that its MIDI Out goes to the MIDI In you picked, then try again.', true);
      } else if (error) {
        toast('Stopped after ' + got + ' programs: ' + error.message, true);
      } else if (scan.cancel) {
        toast('Stopped after ' + got + ' programs.');
      } else {
        toast('Read 128 names from ' + sb.title + '.');
      }
      // Put back whatever the user was listening to.
      if (sb.id !== 'user' && state.live) sendRef(state.live);
      renderAll();
    })();
  }

  /* ---------------- connection test ----------------
   * Checks each link in turn and reads the QS edit buffer back to see
   * whether a program change and a SysEx audition actually landed.
   */
  var diagRunning = false;

  function readEditName() {
    return midi.request(QS.build.editProgramRequest(0), isEditDump, 1500).then(function (p) {
      return QS.programName(p.data).trimEnd();
    });
  }

  async function runDiagnostics() {
    if (diagRunning) return;
    diagRunning = true;
    var list = $('diagResults');
    var btn = $('runDiag');
    btn.disabled = true;
    list.innerHTML = '';
    function line(kind, text) {
      var li = document.createElement('li');
      li.className = 'diag-' + kind;
      li.textContent = text;
      list.appendChild(li);
    }
    var ch = state.ch + 1;
    var touched = false;
    try {
      if (!midi.out) { line('fail', 'No MIDI output is selected. Pick the port that goes to the QS MIDI In.'); return; }
      line('ok', 'Sending to "' + midi.out.name + '" on channel ' + ch + '.');
      if (!midi.sysex) {
        line('fail', 'SysEx access is off, so this test and library auditions can\'t work. Allow SysEx in the site settings next to the address bar, then reload.');
        return;
      }
      if (!midi.in) {
        line('info', 'No MIDI In is selected, so the test can\'t see what the QS does. Connect the QS MIDI Out to your interface and pick that port as In.');
        return;
      }
      try {
        var id = await midi.request(QS.build.deviceInquiry(), function (b, p) { return p && p.kind === 'identity'; }, 1500);
        state.identity = id;
        state.inquiry = 'done';
        renderStatus();
        line('ok', 'The QS answered: ' + id.model + ' v' + id.version + '.');
      } catch (e) {
        line('fail', 'No answer to a SysEx query. Either SysEx isn\'t reaching the QS, or the QS MIDI Out isn\'t connected back to "' +
          midi.in.name + '". If program changes work but library auditions don\'t, it\'s the first: something between the computer ' +
          'and the QS (a sequencer, merger or MIDI processor) is dropping SysEx. Auditions need a SysEx-clean path to the QS MIDI In.');
        return;
      }

      var before = await readEditName();
      line('info', 'The QS is playing "' + before + '".');

      var names = LIB['factory-p1'].info.names;
      var n = names[0] === before ? 1 : 0;
      touched = true;
      midi.send(QS.build.bankSelect(state.ch, 1));
      midi.send(QS.build.programChange(state.ch, n));
      await sleep(400);
      var after = await readEditName();
      if (after === names[n]) {
        line('ok', 'Program changes work: the QS switched to Preset 1 ' + pad3(n) + ' "' + after + '".');
      } else if (after !== before) {
        line('ok', 'Program changes work: the QS switched to "' + after + '". Your Preset 1 names differ from this browser\'s, so use "Read names from QS" on the Preset banks.');
      } else {
        line('fail', 'The QS ignored Bank Select 1 + Program Change ' + n + ' on channel ' + ch + '. On the QS, press PROGRAM to be in Program mode, then under GLOBAL set MIDI Program Select to On (or to channel ' + ch + ') and General MIDI to Off.');
      }

      var p2 = await window.QSLIB.load('factory-p2');
      var expect = QS.programName(p2.programs[0]).trimEnd();
      midi.send(QS.build.editProgramDump(0, p2.programs[0]));
      await sleep(400);
      var edited = await readEditName();
      if (edited === expect) {
        line('ok', 'SysEx auditions work: the QS edit buffer now holds "' + edited + '".');
      } else {
        line('fail', 'The QS didn\'t take a SysEx program dump (it still shows "' + edited + '"). Something in the MIDI path is dropping or ' +
          'cutting long SysEx messages: a sequencer or merger in the chain, or a cheap USB-MIDI cable.');
      }
    } catch (err) {
      line('fail', 'The test stopped: ' + err.message + '.');
    } finally {
      diagRunning = false;
      btn.disabled = false;
      if (touched && editor.isOpen()) editor.resend();
      else if (touched && state.live) sendRef(state.live);
    }
  }

  /* ---------------- store to user ---------------- */
  var pendingStore = null;

  function openStoreDialog(ref) {
    var item = itemFor(ref);
    getProgramData(ref).then(function (d) {
      if (!d || !d.program) return;
      showStoreDialog({ program: d.program, effect: d.effect, name: item.name, slot: ref.n });
    });
  }

  /*
   * p: { program, effect, name, slot, onStored(n) }. The dialog's submit
   * handler calls doStore() for the Overwrite button.
   */
  function showStoreDialog(p) {
    if (!needOutput()) return;
    if (!midi.sysex) { toast('Storing needs SysEx access.', true); return; }
    pendingStore = p;
    $('storeName').textContent = p.name.trim();
    var slot = $('storeSlot');
    slot.value = p.slot;
    updateStoreLabel();
    $('storeDialog').showModal();
    slot.focus();
    slot.select();
  }

  function updateStoreLabel() {
    var n = Number($('storeSlot').value);
    var ok = Number.isInteger(n) && n >= 0 && n <= 127;
    $('storeConfirm').disabled = !ok;
    if (!ok) { $('storeCurrent').textContent = 'Pick a slot from 0 to 127.'; return; }
    var names = synthNames(SYNTH_BY_ID.user);
    var src = state.scans.user ? 'read from the QS' : 'factory default, may be out of date';
    $('storeCurrent').textContent = 'User ' + pad3(n) + ' now holds: ' + (names[n] || '?') + ' (' + src + ')';
    $('storeConfirm').textContent = 'Overwrite User ' + pad3(n);
  }

  function doStore() {
    var p = pendingStore;
    pendingStore = null;
    if (!p) return;
    var n = Number($('storeSlot').value);
    if (!midi.send(QS.build.userProgramDump(n, p.program))) {
      toast('Couldn\'t send to the QS, so User ' + pad3(n) + ' wasn\'t changed. Check the MIDI output.', true);
      return;
    }
    if (p.effect && !midi.send(QS.build.userEffectDump(n, p.effect))) {
      toast('User ' + pad3(n) + ' got the program but not its effect. Check the MIDI output and store again.', true);
      return;
    }
    state.userEdits[n] = {
      name: p.name,
      at: Date.now(),
      program: toB64(p.program),
      effect: p.effect ? toB64(p.effect) : null
    };
    store.set('userEdits', state.userEdits);
    toast('Stored ' + p.name.trim() + ' to User ' + pad3(n) + '.');
    if (p.onStored) p.onStored(n);
    renderAll();
  }

  /* ---------------- download ---------------- */
  function downloadSyx(ref) {
    var item = itemFor(ref);
    getProgramData(ref).then(function (d) {
      if (d && d.program) saveSyx(item.name || 'program', d.program, d.effect);
    });
  }

  function saveSyx(name, program, effect) {
    var parts = [QS.build.editProgramDump(0, program)];
    if (effect) parts.push(QS.build.editEffectDump(0, effect));
    var blob = new Blob(parts, { type: 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (name.trim() || 'program').replace(/[^\w\-.& ]+/g, '_') + '.syx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------------- program editor ----------------
   * Makes the program the one playing (Bank Select + Program Change for synth
   * banks, edit buffer dumps otherwise), then reads the QS edit buffer and
   * edit effect back, so the editor starts from what the QS really holds.
   * Without a MIDI In, or when the QS doesn't answer, it falls back to the
   * library / factory data and says so.
   */
  function isEditEffectDump(b, p) { return p && p.kind === 'qs' && p.op === QS.OP.EDIT_EFFECT; }

  async function openEditor(ref) {
    var item = itemFor(ref);
    if (!item) return;
    var k = parseKey(ref.key);
    var title = (k.kind === 'synth' ? 'QS ' + SYNTH_BY_ID[k.id].title : shortLabel(ref.key)) + ' ' + pad3(ref.n);
    $('main').classList.add('editing');
    var token = editor.loading(title);
    renderInspector();
    var stored = await getProgramData(ref).catch(function () { return null; });
    if (!editor.isLoading(token)) return;
    var program = null;
    var effect = null;
    var why = null;
    var notices = [];
    var sent = false;
    if (midi.out) sent = refEq(state.live, ref) || await sendRef(ref);
    if (!midi.out) why = 'No MIDI output is selected';
    else if (!midi.sysex) why = 'SysEx access is off';
    else if (!midi.in) why = 'No MIDI In is selected, so the QS edit buffer can\'t be read';
    else {
      if (sent) await sleep(150);
      try {
        program = (await midi.request(QS.build.editProgramRequest(0), isEditDump, 2000)).data;
        try {
          effect = (await midi.request(QS.build.editEffectRequest(0), isEditEffectDump, 2000)).data;
        } catch (err) {
          effect = stored && stored.effect;
          notices.push('The QS sent its program but not its effect. The Effects page shows ' +
            (effect ? 'this browser\'s copy of the effect, which may not match the QS.' : 'nothing.'));
        }
      } catch (err) {
        why = 'The QS didn\'t answer the edit buffer request';
      }
    }
    if (!editor.isLoading(token)) return;
    if (!program) {
      if (!stored || !stored.program) {
        editor.failed(token, why + ', and this browser has no data for this program, so there\'s nothing to edit. ' +
          'Connect the QS MIDI Out to the MIDI In picked here and try again.');
        return;
      }
      program = stored.program;
      effect = stored.effect;
      notices.push(why + ', so the editor starts from this browser\'s copy (see under the name).' + (midi.out && midi.sysex
        ? ' Edits still go to the QS, but it may hold something else; Resync sends the whole program and effect to make them match.'
        : ' Edits stay in this browser, but you can save them as a .syx file.'));
    } else if (k.kind === 'synth' && item.name && QS.programName(program).trimEnd() !== item.name.trimEnd()) {
      notices.push('The QS edit buffer holds "' + QS.programName(program).trimEnd() + '", but this browser lists "' + item.name.trimEnd() +
        '" here. The editor shows what the QS holds. If that\'s not what you picked, check MIDI Program Select on the QS, or read this bank\'s names again.');
    }
    editor.open(token, {
      program: program,
      effect: effect,
      title: title,
      origin: why ? stored.origin : 'Read from the QS edit buffer',
      notices: notices,
      fromQS: !why,
      slot: ref.n
    });
    renderInspector();
  }

  function closeEditor() {
    return !editor.isOpen() || editor.close(false);
  }

  /* ---------------- opening files ---------------- */
  function openFiles(list) {
    Array.from(list).forEach(function (file) {
      file.arrayBuffer().then(function (buf) {
        var bank = QS.parseBank(new Uint8Array(buf));
        if (!bank.programCount) {
          toast(file.name + ' has no QS programs in it.', true);
          return;
        }
        var key = 'file:' + (++state.fileSeq);
        state.files.push({ key: key, title: file.name, bank: bank });
        renderSidebar();
        setView(key);
        toast('Opened ' + file.name + ' · ' + bank.programCount + ' programs');
      });
    });
  }

  /* ---------------- MIDI monitor ---------------- */
  var OP_NAMES = {
    0x00: 'User program dump', 0x01: 'User program request', 0x02: 'Edit program dump', 0x03: 'Edit program request',
    0x04: 'Old mix dump', 0x05: 'Old mix request', 0x06: 'User effect dump', 0x07: 'User effect request',
    0x08: 'Edit effect dump', 0x09: 'Edit effect request', 0x0A: 'Global dump', 0x0B: 'Global request',
    0x0C: 'All dump request', 0x0D: 'Mode select', 0x0E: 'Mix dump', 0x0F: 'Mix request', 0x10: 'Parameter edit'
  };

  function describe(bytes) {
    var s = bytes[0];
    if (s === 0xF0) {
      if (bytes[1] === 0x7E && bytes[4] === 0x01) return 'Device inquiry';
      var p = QS.parseMessage(bytes);
      if (p && p.kind === 'identity') return 'Device reply: ' + p.model + ' v' + p.version;
      if (p && p.kind === 'qs') {
        if (p.op === QS.OP.PARAM_EDIT) return editor.describeEdit(bytes) || OP_NAMES[p.op];
        var t = OP_NAMES[p.op] || ('QS opcode ' + p.op);
        if (p.op === QS.OP.MODE_SELECT) return t + ': ' + (p.num ? 'Mix' : 'Program');
        if (p.num !== null) t += ' #' + p.num;
        if (p.data && p.data.length >= QS.SIZE.program && (p.op === 0 || p.op === 2)) t += ' "' + QS.programName(p.data).trimEnd() + '"';
        return t;
      }
      return 'SysEx (' + bytes.length + ' bytes)';
    }
    var ch = ' · ch ' + ((s & 15) + 1);
    switch (s & 0xF0) {
      case 0xB0: return (bytes[1] === 0 ? 'Bank select ' + bytes[2] : 'CC ' + bytes[1] + ' = ' + bytes[2]) + ch;
      case 0xC0: return 'Program change ' + bytes[1] + ch;
      case 0x90: return (bytes[2] ? 'Note on ' : 'Note off ') + QS.noteName(bytes[1]) + ch;
      case 0x80: return 'Note off ' + QS.noteName(bytes[1]) + ch;
      default: return QS.toHex(bytes, 6);
    }
  }

  function addLog(entry) {
    var ol = $('log');
    var li = document.createElement('li');
    li.innerHTML = '<span class="dir-' + entry.dir + '">' + (entry.dir === 'out' ? '→' : '←') + '</span>' +
      '<span>' + esc(describe(entry.bytes)) + '<br><span class="hex">' + esc(QS.toHex(entry.bytes, 12)) + '</span></span>';
    ol.insertBefore(li, ol.firstChild);
    while (ol.children.length > 60) ol.removeChild(ol.lastChild);
  }

  /* ---------------- events ---------------- */
  function bindEvents() {
    $('sidebar').addEventListener('click', function (e) {
      var b = e.target.closest('.nav-item');
      if (!b || !closeEditor()) return;
      if (state.query) clearSearch();
      setView(b.dataset.key);
    });

    $('grid').addEventListener('click', function (e) {
      var c = e.target.closest('.cell');
      if (!c || c.classList.contains('empty')) return;
      // Keep keyboard focus on the grid so the focus ring doesn't linger on the clicked cell.
      $('grid').focus({ preventScroll: true });
      select(Number(c.dataset.i), true);
    });

    $('results').addEventListener('click', function (e) {
      var r = e.target.closest('.result');
      if (r) selectResult(Number(r.dataset.i), true);
    });

    $('inspectorBody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var ref = currentRef();
      if (!ref) return;
      var act = b.dataset.act;
      if (act === 'send') sendRef(ref);
      else if (act === 'fav') toggleFav(ref);
      else if (act === 'store') openStoreDialog(ref);
      else if (act === 'download') downloadSyx(ref);
      else if (act === 'edit') openEditor(ref);
    });

    var search = $('search');
    search.addEventListener('input', function () {
      state.query = search.value;
      state.resultSel = 0;
      runSearch();
      renderResults();
      renderInspector();
    });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); clearSearch(); search.blur(); $('grid').focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); selectResult(state.resultSel + 1, state.settings.arrowSend); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selectResult(state.resultSel - 1, state.settings.arrowSend); }
      else if (e.key === 'Enter') { e.preventDefault(); if (state.results.length) sendRef(currentRef()); }
    });

    document.addEventListener('keydown', function (e) {
      if (document.querySelector('dialog[open]')) return;
      var t = e.target;
      var inField = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
      if (e.key === '/' && !inField && !editor.isOpen()) { e.preventDefault(); search.focus(); search.select(); return; }
      if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
      var key = e.key;
      if (key === 't' || key === 'T') { if (!e.repeat) testNote(true); return; }
      // The grid's keys would send other programs over the one being edited.
      if (editor.isOpen()) return;
      if (key === 'f' || key === 'F') { toggleFav(currentRef()); return; }
      if (key === 'Escape' && state.query) { clearSearch(); return; }
      if (key === 'PageDown' || key === 'PageUp') {
        e.preventDefault();
        var order = sidebarOrder();
        var at = order.indexOf(state.view);
        var next = order[(at + (key === 'PageDown' ? 1 : -1) + order.length) % order.length];
        if (state.query) clearSearch();
        setView(next);
        return;
      }
      var arrow = state.settings.arrowSend;
      if (state.query) {
        if (key === 'ArrowDown') { e.preventDefault(); selectResult(state.resultSel + 1, arrow); }
        else if (key === 'ArrowUp') { e.preventDefault(); selectResult(state.resultSel - 1, arrow); }
        else if (key === 'Enter' || key === ' ') { e.preventDefault(); sendRef(currentRef()); }
        return;
      }
      var cols = gridColumns();
      var moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
      if (moves[key] !== undefined) { e.preventDefault(); select(state.sel + moves[key], arrow); }
      else if (key === 'Home') { e.preventDefault(); select(0, arrow); }
      else if (key === 'End') { e.preventDefault(); select(currentView().items.length - 1, arrow); }
      else if (key === 'Enter' || key === ' ') {
        if (t.closest && t.closest('.sidebar, .inspector, .topbar')) return;
        e.preventDefault();
        sendRef(currentRef());
      }
    });
    document.addEventListener('keyup', function (e) {
      if (e.key === 't' || e.key === 'T') testNote(false);
    });

    $('outSelect').addEventListener('change', function (e) {
      midi.setOutput(e.target.value);
      store.set('out', e.target.value);
      identify();
      renderNotice();
    });
    $('inSelect').addEventListener('change', function (e) {
      midi.setInput(e.target.value);
      store.set('in', e.target.value);
      identify();
    });
    var chSel = $('chSelect');
    for (var c = 0; c < 16; c++) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c + 1;
      chSel.appendChild(o);
    }
    chSel.value = state.ch;
    chSel.addEventListener('change', function () {
      state.ch = Number(chSel.value);
      store.set('ch', state.ch);
      renderLcd();
      renderInspector();
    });
    $('status').addEventListener('click', identify);

    var test = $('testNote');
    test.addEventListener('pointerdown', function () { testNote(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
      test.addEventListener(ev, function () { testNote(false); });
    });
    $('panic').addEventListener('click', function () {
      if (!needOutput()) return;
      for (var ch = 0; ch < 16; ch++) {
        midi.send(QS.build.allSoundOff(ch));
        midi.send(QS.build.allNotesOff(ch));
      }
      toast('Sent All Notes Off on all channels.');
    });

    // settings
    $('settingsBtn').addEventListener('click', function () {
      $('setArrowSend').checked = state.settings.arrowSend;
      $('setFollow').checked = state.settings.follow;
      $('settingsDialog').showModal();
    });
    $('runDiag').addEventListener('click', runDiagnostics);
    $('programModeBtn').addEventListener('click', function () {
      if (!needOutput()) return;
      if (!midi.sysex) { toast('This needs SysEx access. Reload and allow it.', true); return; }
      midi.send(QS.build.modeSelect(false));
      toast('Asked the QS to switch to Program mode.');
    });
    [['setArrowSend', 'arrowSend'], ['setFollow', 'follow']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function (e) {
        state.settings[pair[1]] = e.target.checked;
        store.set('settings', state.settings);
      });
    });
    $('forgetScans').addEventListener('click', function () {
      Object.keys(state.scans).forEach(function (id) { store.remove('scanData.' + id); });
      state.scans = {};
      state.userEdits = {};
      scanDataCache = {};
      store.set('scans', {});
      store.set('userEdits', {});
      toast('Forgot names read from the QS.');
      renderAll();
    });

    // store dialog
    $('storeSlot').addEventListener('input', updateStoreLabel);
    // Act on the submit itself rather than the dialog's (asynchronous) close event.
    $('storeDialog').querySelector('form').addEventListener('submit', function (e) {
      if (e.submitter && e.submitter.value === 'ok') doStore();
      else pendingStore = null;
    });

    // files
    $('fileInput').addEventListener('change', function (e) {
      openFiles(e.target.files);
      e.target.value = '';
    });
    var overlay = $('dropOverlay');
    var dragDepth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0; }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      dragDepth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) overlay.hidden = true;
    });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      openFiles(e.dataTransfer.files);
    });
  }

  var noteHeld = false;
  function testNote(on) {
    if (on === noteHeld) return;
    if (on && !needOutput()) return;
    noteHeld = on;
    if (!midi.out) return;
    midi.send(on ? QS.build.noteOn(state.ch, 60, 100) : QS.build.noteOff(state.ch, 60));
  }

  /* ---------------- start ---------------- */
  function loadDemo() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'js/demo-qs.js';
      s.onload = function () { resolve(window.QSDemo.createAccess); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function start() {
    editor = window.QSEditor.create({
      root: $('editor'),
      midi: midi,
      toast: toast,
      esc: esc,
      store: showStoreDialog,
      save: saveSyx,
      changed: function () { renderLcd(); renderInspector(); },
      closed: function () {
        $('main').classList.remove('editing');
        renderInspector();
        renderLcd();
        $('grid').focus({ preventScroll: true });
      }
    });
    window.addEventListener('beforeunload', function (e) {
      if (!editor.isModified()) return;
      e.preventDefault();
      e.returnValue = '';
    });
    bindEvents();
    if (!bankExists(state.view)) state.view = 'synth:p1';
    renderAll();
    midi.onLog(addLog);
    midi.onMessage(onMidiIn);
    midi.onPortsChanged(function () { renderPorts(); renderStatus(); });
    try {
      var demo = /[?&]demo\b/.test(location.search) ? await loadDemo() : null;
      await midi.init(demo);
      renderPorts();
      identify();
    } catch (err) {
      state.midiError = err.code === 'unsupported' ? 'No Web MIDI in this browser'
        : (err.name === 'SecurityError' || err.name === 'NotAllowedError') ? 'MIDI access blocked' : 'MIDI unavailable';
      renderPorts();
      toast(err.code === 'unsupported' ? err.message
        : 'MIDI access was blocked. Click the site settings icon in the address bar, allow MIDI, then reload.', true);
    }
    renderStatus();
    renderNotice();
    $('grid').focus({ preventScroll: true });
  }

  start();
})();

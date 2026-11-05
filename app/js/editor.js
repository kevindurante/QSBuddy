/*
 * editor.js — the program editor view (roadmap phase 2).
 *
 * app.js reads the QS edit buffer and calls open(); from then on this file
 * owns the main area: tabs for the program, the four sounds and the effect,
 * with controls built from the field definitions in QS.PARAMDEFS. Each change
 * updates the local copy (QS.createEditSession in qs-edit.js) and goes to the
 * QS as one opcode 10H message, throttled per parameter. See
 * docs/architecture.md, "Program editor".
 */
(function () {
  'use strict';

  var QS = window.QS;
  var DEFS = QS.PARAMDEFS;
  var THROTTLE_MS = 30;    // at most one 10H message per parameter this often
  var DUMP_MS = 250;       // debounce for fields that need the whole dump resent
  var READBACK_MS = 150;   // wait before reading the QS back after a layout change
  var PAN = ['L3', 'L2', 'L1', 'C', 'R1', 'R2', 'R3'];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function isDump(kind) {
    var op = kind === 'program' ? QS.OP.EDIT_PROGRAM : QS.OP.EDIT_EFFECT;
    return function (b, p) { return p && p.kind === 'qs' && p.op === op; };
  }

  function requestFor(kind) {
    return kind === 'program' ? QS.build.editProgramRequest(0) : QS.build.editEffectRequest(0);
  }

  function dumpFor(kind, data) {
    return kind === 'program' ? QS.build.editProgramDump(0, data) : QS.build.editEffectDump(0, data);
  }

  function hasCoords(def) { return def.func !== null && def.page !== null && def.pot !== null; }

  function visible(f) { return !f.def.spare && !f.def.unlisted; }

  /*
   * host: { root, midi, toast, esc, store(opts), save(name, program, effect),
   *         changed(), closed() }
   */
  function create(host) {
    var root = host.root;
    var esc = host.esc;
    var ed = null;
    var loadingToken = 0;
    var lastTab = 'program';
    var throttle = QS.createThrottle(THROTTLE_MS, sendQueued);
    var dumpTimers = {};
    var describing = null; // monitor label for the message being sent, when the session can't name it

    /* ---------------- sending ---------------- */
    function linkProblem() {
      var m = host.midi;
      if (!m.out) return 'No MIDI output is selected, so edits stay in this browser.';
      if (!m.sysex) return 'SysEx access is off, so edits can\'t reach the QS. Reload and allow SysEx.';
      return 'The MIDI output refused the message. Is it unplugged, or open in another app?';
    }

    function send(bytes) {
      var ok = host.midi.send(bytes);
      if (ed && ok !== ed.sending) {
        ed.sending = ok;
        renderLink();
        if (!ok) host.toast('Edits aren\'t reaching the QS. ' + linkProblem(), true);
      }
      return ok;
    }

    function sendQueued(tkey, value) {
      if (!ed) return;
      var i = tkey.indexOf('|');
      var kind = tkey.slice(0, i);
      var f = ed.session.field(kind, tkey.slice(i + 1));
      if (!f) return;
      var msgs = ed.session.messages(kind, f, value);
      if (msgs) msgs.forEach(send);
      else dumpSoon(kind);
    }

    function sendDump(kind, data) {
      data = data || ed.session.data[kind];
      if (data) send(dumpFor(kind, data));
    }

    function dumpSoon(kind) {
      clearTimeout(dumpTimers[kind]);
      dumpTimers[kind] = setTimeout(function () {
        dumpTimers[kind] = null;
        if (ed) sendDump(kind);
      }, DUMP_MS);
    }

    // Send everything still waiting (throttled edits and debounced dumps).
    function flush() {
      throttle.flush();
      Object.keys(dumpTimers).forEach(function (kind) {
        if (!dumpTimers[kind]) return;
        clearTimeout(dumpTimers[kind]);
        dumpTimers[kind] = null;
        if (ed) sendDump(kind);
      });
    }

    /* ---------------- changes ---------------- */
    function change(kind, key, value) {
      var c = controlEl(kind, key);
      if (!ed || ed.comparing || ed.busy) { if (c) syncControl(c); return; }
      var f = ed.session.field(kind, key);
      if (!f) return;
      if (c) value = Math.max(Number(c.dataset.min), Math.min(Number(c.dataset.max), value));
      var res = ed.session.set(kind, key, value);
      if (res.layout) { layoutChange(kind, key, res); return; }
      if (c) syncControl(c);
      afterChange();
      if (hasCoords(f.def)) throttle.push(kind + '|' + key, res.value);
      else dumpSoon(kind);
    }

    function changeName(text) {
      if (!ed || ed.comparing || ed.busy) return;
      ed.session.setName(text).forEach(function (key) {
        throttle.push('program|' + key, ed.session.value('program', key));
      });
      root.querySelector('.ed-name').textContent = ed.session.name();
      afterChange();
    }

    function afterChange() {
      renderModified();
      host.changed();
    }

    /*
     * Sound mode, effect configuration and the pitch and delay types change
     * which fields exist. Send the 10H message for the old field, then read
     * the QS back to show what it made of the change; without a MIDI In, send
     * the whole dump so the QS matches the screen instead.
     */
    async function layoutChange(kind, key, res) {
      flush();
      var msgs = ed.session.messages(kind, res.field, res.value);
      // The field's old layout is gone by the time the monitor reads the message.
      describing = fieldTitle(res.field);
      if (msgs) msgs.forEach(send);
      describing = null;
      renderBody();
      afterChange();
      if (!msgs || !ed.fromQS || !host.midi.in) { sendDump(kind); return; }
      var mine = ed;
      mine.busy = true;
      await sleep(READBACK_MS);
      try {
        var reply = await host.midi.request(requestFor(kind), isDump(kind), 1500);
        if (ed !== mine) return;
        mine.session.adopt(kind, reply.data);
        if (mine.session.value(kind, key) !== res.value) {
          host.toast('The QS didn\'t take that change. If its COMPARE light is on, press COMPARE to leave it, then try again.', true);
        }
      } catch (err) {
        if (ed !== mine) return;
        sendDump(kind);
        host.toast('The QS didn\'t send its edit buffer back after that change, so QSBuddy sent the whole ' + kind + ' to match the screen.', true);
      }
      mine.busy = false;
      renderBody();
      afterChange();
    }

    /* ---------------- toolbar actions ---------------- */
    function toggleCompare() {
      flush();
      ed.comparing = !ed.comparing;
      var src = ed.comparing ? ed.session.original : ed.session.data;
      sendDump('program', src.program);
      if (src.effect) sendDump('effect', src.effect);
      renderHead();
      renderBody();
    }

    function revert() {
      if (ed.session.isModified() &&
          !window.confirm('Revert to the original program and effect? Every change made here is lost.')) return;
      throttle.cancel();
      ed.comparing = false;
      ed.session.revert();
      sendDump('program');
      if (ed.session.data.effect) sendDump('effect');
      renderHead();
      renderBody();
      afterChange();
    }

    function resync() {
      flush();
      if (ed.comparing) { ed.comparing = false; renderHead(); renderBody(); }
      sendDump('program');
      if (ed.session.data.effect) sendDump('effect');
      if (ed.sending !== false) host.toast('Sent the edited program' + (ed.session.data.effect ? ' and effect' : '') + ' to the QS edit buffer.');
    }

    // Put back whichever version the QS should be playing (after the connection test, say).
    function resend() {
      if (!ed) return;
      flush();
      var src = ed.comparing ? ed.session.original : ed.session.data;
      sendDump('program', src.program);
      if (src.effect) sendDump('effect', src.effect);
    }

    function store() {
      flush();
      var mine = ed;
      host.store({
        program: ed.session.data.program,
        effect: ed.session.data.effect,
        name: ed.session.name(),
        slot: ed.slot,
        onStored: function (n) {
          if (ed !== mine) return;
          mine.session.commit();
          mine.slot = n;
          mine.storedAs = n;
          renderHead();
          renderBody();
          afterChange();
        }
      });
    }

    /* ---------------- open / close ---------------- */
    function loading(title) {
      ed = null;
      throttle.cancel();
      root.hidden = false;
      root.innerHTML = headHtml(title, '') + '<p class="muted ed-loading">Reading the edit buffer from the QS…</p>';
      return ++loadingToken;
    }

    function isLoading(token) { return token === loadingToken && !ed && !root.hidden; }

    function failed(token, msg) {
      if (!isLoading(token)) return;
      root.querySelector('.ed-loading').outerHTML = '<div class="notice warn">' + esc(msg) + '</div>';
    }

    /*
     * opts: { program, effect, title, origin, notices, fromQS, slot }
     * fromQS: the data was read from the QS edit buffer (so the QS can be
     * read back after layout changes).
     */
    function open(token, opts) {
      if (!isLoading(token)) return;
      ed = {
        session: QS.createEditSession(opts.program, opts.effect),
        title: opts.title,
        origin: opts.origin,
        notices: opts.notices || [],
        fromQS: !!opts.fromQS,
        slot: opts.slot || 0,
        tab: lastTab,
        pages: [KEY_PAGE0, KEY_PAGE0, KEY_PAGE0, KEY_PAGE0],
        drums: [0, 0, 0, 0],
        comparing: false,
        busy: false,
        sending: host.midi.out && host.midi.sysex ? true : false,
        storedAs: null
      };
      root.innerHTML = headHtml(opts.title, opts.origin) + '<div class="ed-notices"></div>' +
        '<div class="ed-tabs" role="tablist"></div><div class="ed-body"></div>';
      renderHead();
      renderNotices();
      renderBody();
      host.changed();
    }

    function close(force) {
      if (!ed) {
        loadingToken++;
        root.hidden = true;
        root.innerHTML = '';
        host.closed();
        return true;
      }
      if (!force && ed.session.isModified() && !window.confirm(
        'Leave the editor without storing?\n\nYour changes stay in the QS edit buffer until it plays another program, ' +
        'but they aren\'t saved anywhere. Use "Store to User…" to keep them.')) return false;
      flush();
      ed = null;
      loadingToken++;
      root.hidden = true;
      root.innerHTML = '';
      host.closed();
      return true;
    }

    // Something outside the editor changed the QS (a program change from the front panel, say).
    function externalChange(msg) {
      if (!ed) return;
      ed.notices.push(msg);
      renderNotices();
    }

    /* ---------------- rendering: head ---------------- */
    function headHtml(title, origin) {
      return '<div class="ed-head">' +
        '<button type="button" class="btn small" data-ed="back" title="Back to the program grid">&larr; Programs</button>' +
        '<div class="ed-title"><div class="ed-from">' + esc(title) + '</div>' +
        '<h1><span class="ed-name"></span><span class="ed-mod" hidden>Modified</span></h1>' +
        '<p class="ed-origin">' + esc(origin) + '</p></div>' +
        '<div class="ed-actions"></div></div>';
    }

    function renderHead() {
      root.querySelector('.ed-name').textContent = ed.session.name();
      var a = root.querySelector('.ed-actions');
      a.innerHTML =
        '<span class="ed-link"></span>' +
        '<button type="button" class="btn' + (ed.comparing ? ' active' : '') + '" data-ed="compare" aria-pressed="' + ed.comparing +
          '" title="Switch the QS between the original and the edited version">Compare</button>' +
        '<button type="button" class="btn" data-ed="revert" title="Throw away every change and send the original back">Revert</button>' +
        '<button type="button" class="btn" data-ed="resync" title="Send the whole edited program and effect to the QS edit buffer">Resync</button>' +
        '<button type="button" class="btn" data-ed="syx" title="Save the edited program as a .syx file">.syx</button>' +
        '<button type="button" class="btn primary" data-ed="store">Store to User…</button>';
      renderLink();
      renderModified();
    }

    function renderLink() {
      var el = root.querySelector('.ed-link');
      if (!el || !ed) return;
      if (ed.comparing) {
        el.textContent = 'Comparing: QS plays the original';
        el.dataset.state = 'warn';
        el.title = 'Edits are paused. Press Compare again to go back to your version.';
      } else if (ed.sending) {
        el.textContent = 'Live';
        el.dataset.state = 'ok';
        el.title = 'Each change goes to the QS as a parameter edit (SysEx 10H).';
      } else {
        el.textContent = 'Not sending';
        el.dataset.state = 'warn';
        el.title = linkProblem();
      }
    }

    function renderModified() {
      if (!ed) return;
      var mod = ed.session.isModified();
      var el = root.querySelector('.ed-mod');
      el.hidden = !mod && ed.storedAs === null;
      el.textContent = mod ? 'Modified' : ed.storedAs !== null ? 'Stored to User ' + String(ed.storedAs).padStart(3, '0') : '';
      el.classList.toggle('stored', !mod);
    }

    function renderNotices() {
      var box = root.querySelector('.ed-notices');
      var hint = ed.fromQS
        ? 'Edits go to the QS live. It ignores them while its COMPARE light is on, and they\'re lost when it plays another program unless you store them.'
        : null;
      box.innerHTML = ed.notices.map(function (n) { return '<div class="notice warn">' + esc(n) + '</div>'; }).join('') +
        (hint && !ed.notices.length ? '<div class="notice">' + esc(hint) + '</div>' : '');
    }

    /* ---------------- rendering: tabs and body ---------------- */
    function tabs() {
      var list = [{ id: 'program', title: 'Program' }];
      for (var s = 0; s < 4; s++) {
        var on = ed.session.value('program', 's' + (s + 1) + '.enable') === 1;
        list.push({
          id: 's' + s,
          title: 'Sound ' + (s + 1),
          sub: (ed.session.isDrum(s) ? 'Drums' : 'Keys') + (on ? '' : ' · off'),
          off: !on
        });
      }
      list.push({ id: 'effect', title: 'Effects', sub: ed.session.data.effect ? 'Config ' + ed.session.value('effect', 'effectConfiguration') : 'none' });
      return list;
    }

    function renderTabs() {
      root.querySelector('.ed-tabs').innerHTML = tabs().map(function (t) {
        var cur = t.id === ed.tab;
        return '<button type="button" class="ed-tab' + (t.off ? ' off' : '') + '" role="tab" data-tab="' + t.id + '" aria-selected="' + cur + '">' +
          esc(t.title) + (t.sub ? '<small>' + esc(t.sub) + '</small>' : '') + '</button>';
      }).join('');
    }

    function renderBody() {
      if (!ed) return;
      renderTabs();
      var body = root.querySelector('.ed-body');
      var html;
      if (ed.tab === 'program') html = programHtml();
      else if (ed.tab === 'effect') html = effectHtml();
      else {
        var s = Number(ed.tab.slice(1));
        html = ed.session.isDrum(s) ? drumSoundHtml(s) : keyboardSoundHtml(s);
      }
      body.innerHTML = html;
      body.querySelectorAll('.ed-fields').forEach(function (fs) { fs.disabled = ed.comparing || ed.busy; });
    }

    /* ---------------- controls ---------------- */
    function fmt(f) {
      var d = f.def;
      if (d.id === 'pan' && PAN[f.value]) return PAN[f.value];
      if (d.id === 'effectBus' && !d.unlisted && d.display === 'number') return 'Bus ' + (f.value + 1);
      return QS.formatParam(d, f.raw);
    }

    function controlId(kind, key) { return 'ed-' + kind + '-' + key.replace(/[^\w-]/g, '_'); }

    function controlEl(kind, key) {
      return root.querySelector('.ctl[data-kind="' + kind + '"][data-key="' + key + '"]');
    }

    /*
     * One control for field f. opts: { label, col } (col: grid column, for
     * pot positions).
     */
    function control(kind, f, opts) {
      var d = f.def;
      var id = controlId(kind, f.key);
      var r = QS.editRange(d, f.value);
      var input;
      if (d.display === 'enum' && d.options) {
        var n = Math.max(d.options.length, f.raw + 1);
        var o = '';
        for (var i = 0; i < n; i++) {
          o += '<option value="' + i + '"' + (i === f.raw ? ' selected' : '') + '>' +
            esc(i < d.options.length ? QS.formatParam(d, i) : String(i)) + '</option>';
        }
        input = '<select id="' + id + '">' + o + '</select>';
      } else if (d.display === 'onoff') {
        input = '<input type="checkbox" id="' + id + '"' + (f.value ? ' checked' : '') + '><output>' + fmt(f) + '</output>';
      } else {
        input = '<input type="range" id="' + id + '" min="' + r[0] + '" max="' + r[1] + '" step="1" value="' + f.value + '">';
        input += d.display === 'number' || d.display === 'signed'
          ? '<input type="number" class="ctl-num" min="' + r[0] + '" max="' + r[1] + '" step="1" value="' + f.value + '" aria-label="' + esc(opts.label) + ' value">'
          : '<output>' + esc(fmt(f)) + '</output>';
      }
      var cls = 'ctl ctl-' + (d.display === 'enum' && d.options ? 'enum' : d.display === 'onoff' ? 'onoff' : 'range');
      return '<div class="' + cls + stateClasses(kind, f) + '" data-kind="' + kind + '" data-key="' + esc(f.key) + '" data-min="' + r[0] +
        '" data-max="' + r[1] + '"' + (opts.col ? ' style="grid-column:' + opts.col + '"' : '') + ' title="' + esc(tip(d, f)) + '">' +
        '<label for="' + id + '">' + esc(opts.label) + '</label><div class="ctl-in">' + input + '</div></div>';
    }

    function stateClasses(kind, f) {
      return (ed.session.isChanged(kind, f) ? ' changed' : '') + (QS.paramInRange(f.def, f.raw) ? '' : ' over');
    }

    function tip(d, f) {
      var t = d.name + ' · spec #' + d.num;
      if (hasCoords(d)) t += ' · func ' + d.func + ', page ' + d.page + ', pot ' + d.pot;
      else t += ' · no 10H address, so changes resend the whole dump';
      var r = QS.paramRange(d);
      if (r && !QS.paramInRange(d, f.raw)) t += ' · above the spec limit of ' + r[1] + ' (Alesis banks use it, so the spec may be wrong)';
      return t;
    }

    /*
     * Bring a control's inputs and marks in line with the session. A number
     * box being typed in keeps its text unless force is set.
     */
    function syncControl(c, force) {
      if (!ed) return;
      var kind = c.dataset.kind;
      var f = ed.session.field(kind, c.dataset.key);
      if (!f) return;
      c.className = c.className.replace(/ (changed|over)\b/g, '') + stateClasses(kind, f);
      c.querySelectorAll('input, select').forEach(function (el) {
        if (el.tagName === 'SELECT') el.value = String(f.raw);
        else if (el.type === 'checkbox') el.checked = !!f.value;
        else if (force || el !== document.activeElement || el.type === 'range') el.value = String(f.value);
      });
      var out = c.querySelector('output');
      if (out) out.textContent = fmt(f);
    }

    function fieldsOn(kind, pred) {
      return ed.session.fields(kind).filter(function (f) { return visible(f) && pred(f); });
    }

    /* ---------------- pages ---------------- */
    var KEY_PAGE0 = QS.KEYBOARD_PAGES[0].id;

    function programHtml() {
      var s = ed.session;
      var name = s.name().replace(/\s+$/, '');
      var html = '<fieldset class="ed-fields ed-card"><legend>Program</legend>' +
        '<div class="ed-name-row"><label for="edName">Name</label>' +
        '<input type="text" id="edName" class="ed-name-input" maxlength="10" spellcheck="false" autocomplete="off" value="' + esc(name) + '">' +
        '<span class="muted">10 characters, sent letter by letter</span></div>' +
        '<div class="ed-grid">' + control('program', s.field('program', 'romIdentifier'), { label: 'ROM identifier' }) + '</div>' +
        '</fieldset>';
      html += '<fieldset class="ed-fields ed-card"><legend>Sounds</legend><div class="ed-sounds">';
      for (var i = 0; i < 4; i++) {
        var pre = 's' + (i + 1) + '.';
        html += '<div class="ed-sound-row"><button type="button" class="btn small" data-tab="s' + i + '">Sound ' + (i + 1) + ' &rarr;</button>' +
          control('program', s.field('program', pre + 'keyboardDrumMode'), { label: 'Mode' }) +
          control('program', s.field('program', pre + 'enable'), { label: 'Enabled' }) +
          '<span class="muted">' + esc(soundSummary(i)) + '</span></div>';
      }
      html += '</div></fieldset>';
      return html;
    }

    function soundSummary(i) {
      var s = ed.session;
      var pre = 's' + (i + 1) + '.';
      if (s.isDrum(i)) return '10 drums';
      return 'Sample ' + s.value('program', pre + 'sampleGroup') + ' / ' + s.value('program', pre + 'sampleNumber') +
        ' · ' + QS.noteName(s.value('program', pre + 'lowNoteLimit')) + '–' + QS.noteName(s.value('program', pre + 'highNoteLimit')) +
        ' · volume ' + s.value('program', pre + 'volume');
    }

    function soundHead(s) {
      var pre = 's' + (s + 1) + '.';
      return '<fieldset class="ed-fields ed-sound-head">' +
        control('program', ed.session.field('program', pre + 'keyboardDrumMode'), { label: 'Mode' }) +
        control('program', ed.session.field('program', pre + 'enable'), { label: 'Enabled' }) +
        '</fieldset>';
    }

    function rowTitle(page, row, rows) {
      if (page.id === 'mod') return 'Slot ' + (row.page + 1);
      if (page.funcs.length > 1) return row.func === 2 ? 'Effect send' : 'Output';
      return rows.length > 1 ? 'Page ' + (row.page + 1) : '';
    }

    function keyboardSoundHtml(s) {
      var pre = 's' + (s + 1) + '.';
      var page = QS.KEYBOARD_PAGES.filter(function (p) { return p.id === ed.pages[s]; })[0] || QS.KEYBOARD_PAGES[0];
      var html = soundHead(s);
      html += '<nav class="ed-pages" aria-label="Sound ' + (s + 1) + ' pages">' + QS.KEYBOARD_PAGES.map(function (p) {
        return '<button type="button" class="ed-page' + (p.id === page.id ? ' current' : '') + '" data-page="' + p.id + '">' + esc(p.title) + '</button>';
      }).join('') + '</nav>';
      var rows = QS.pageRows(DEFS.keyboardSound.params, page.funcs);
      html += '<fieldset class="ed-fields ed-rows">' + rows.map(function (row) {
        return '<div class="ed-row"><div class="ed-row-title">' + esc(rowTitle(page, row, rows)) + '</div>' + row.defs.map(function (d) {
          return control('program', ed.session.field('program', pre + d.id), { label: QS.editLabel(d.name, page.strip), col: d.pot + 2 });
        }).join('') + '</div>';
      }).join('') + '</fieldset>';
      return html;
    }

    function drumSoundHtml(s) {
      var pre = 's' + (s + 1) + '.';
      var sel = ed.drums[s];
      var dr = DEFS.drumSound.drum;
      var html = soundHead(s);
      html += '<div class="ed-drums"><nav class="ed-drum-list" aria-label="Drums">';
      for (var n = 0; n < dr.count; n++) {
        var dp = pre + 'drum' + (n + 1) + '.';
        var v = function (id) { return ed.session.value('program', dp + id); };
        html += '<button type="button" class="ed-drum' + (n === sel ? ' current' : '') + '" data-drum="' + n + '">' +
          '<b>' + (n + 1) + '</b><span class="note">' + QS.noteName(v('noteNumber')) + '</span>' +
          '<span class="smp">' + v('sampleGroup') + ' / ' + v('sampleNumber') + '</span>' +
          '<span class="vol">vol ' + v('volume') + '</span></button>';
      }
      html += '</nav><fieldset class="ed-fields ed-rows">';
      var dp2 = pre + 'drum' + (sel + 1) + '.';
      html += '<h3 class="section-title">Drum ' + (sel + 1) + '</h3>';
      QS.DRUM_GROUPS.forEach(function (g) {
        var rows = QS.pageRows(dr.params, g.funcs);
        rows.forEach(function (row) {
          // Drums use pots 1-3 only (pot 4 is the drum number).
          html += '<div class="ed-row ed-row3"><div class="ed-row-title">' + esc(g.title) + '</div>' + row.defs.map(function (d) {
            return control('program', ed.session.field('program', dp2 + d.id), { label: QS.editLabel(d.name, ''), col: d.pot + 2 });
          }).join('') + '</div>';
        });
      });
      html += '<p class="muted ed-note">Drum parameters edit the drum selected on the QS, so QSBuddy selects the drum first ' +
        '(drum number, pot 4) when you change another one.</p></fieldset></div>';
      return html;
    }

    function effectHtml() {
      if (!ed.session.data.effect) {
        return '<p class="muted">No effect data came with this program, so there\'s nothing to edit here. ' +
          'Read the program from the QS (with its MIDI Out connected) to get its effect.</p>';
      }
      var cfg = ed.session.value('effect', 'effectConfiguration');
      var html = '<fieldset class="ed-fields ed-card"><legend>Configuration</legend><div class="ed-grid">' +
        control('effect', ed.session.field('effect', 'effectConfiguration'), { label: 'Configuration' }) + '</div>';
      if (cfg === 4) {
        html += '<p class="muted ed-note">In this configuration the spec gives overdrive mix and threshold the same 10H address ' +
          'as other parameters (low and high EQ frequency). Not checked on hardware yet, so those edits may land elsewhere; ' +
          'Resync sends the whole effect if in doubt.</p>';
      }
      html += '</fieldset>';
      var groups = [];
      var byName = {};
      fieldsOn('effect', function (f) { return !!f.def.group; }).forEach(function (f) {
        var g = f.def.group;
        if (!byName[g]) { byName[g] = []; groups.push(g); }
        byName[g].push(f);
      });
      html += '<div class="ed-fx">' + groups.map(function (g) {
        var strip = g.split(' ')[0];
        return '<fieldset class="ed-fields ed-card"><legend>' + esc(g) + '</legend><div class="ed-grid">' + byName[g].map(function (f) {
          return control('effect', f, { label: QS.editLabel(f.def.name, /send \d$/i.test(g) ? strip : '') });
        }).join('') + '</div></fieldset>';
      }).join('') + '</div>';
      return html;
    }

    /* ---------------- inspector + monitor ---------------- */
    function renderInspector(el) {
      if (!ed) {
        el.innerHTML = '<p class="muted">Loading the program…</p>';
        return;
      }
      var s = ed.session;
      el.innerHTML = '<div><div class="insp-num">Editing · ' + esc(ed.title) + '</div>' +
        '<div class="insp-name">' + esc(s.name()) + '</div></div>' +
        '<p class="insp-hint">' + esc(ed.origin) + '</p>' +
        '<p class="insp-hint">Each change goes to the QS as a parameter edit (SysEx 10H), at most one per parameter every ' +
        THROTTLE_MS + ' ms while you drag. Changing a sound\'s mode or an effect type reads the QS back' +
        (ed.fromQS ? '' : ' (here it sends the whole dump instead, since the QS wasn\'t read)') + '.</p>' +
        '<p class="insp-hint">Samples, mod sources and destinations show as numbers until the Reference Manual\'s lists are added.</p>';
    }

    // "S2 Filter frequency", "S1 drum 5 Volume", "S1 Drum number".
    function fieldTitle(f) {
      var name = f.drum !== undefined ? QS.editLabel(f.def.name, '') : f.def.name.replace(/^Sound (\w)/, function (m, c) { return c.toUpperCase(); });
      return (f.sound !== undefined ? 'S' + (f.sound + 1) + ' ' : '') + (f.drum !== undefined ? 'drum ' + (f.drum + 1) + ' ' : '') + name;
    }

    // MIDI monitor text for a 10H message, naming the field when the editor knows it.
    function describeEdit(bytes) {
      var e = QS.parseParamEdit(bytes);
      if (!e) return null;
      var kind = e.mode === 2 ? 'program' : e.mode === 3 ? 'effect' : null;
      var f = kind && ed && ed.session.data[kind] ? QS.fieldForEdit(kind, ed.session.data[kind], e) : null;
      var what;
      if (describing) {
        what = describing;
      } else if (f) {
        what = fieldTitle(f);
      } else {
        what = ['Global', 'Mix', 'Program', 'Effects'][e.mode] + (e.mode === 2 ? ' sound ' + (e.sound + 1) : e.mode === 3 ? ' send ' + (e.sound + 1) : '') +
          ' func ' + e.func + ' page ' + e.page + ' pot ' + e.pot;
      }
      return 'Parameter edit: ' + what + ' = ' + e.value;
    }

    /* ---------------- events ---------------- */
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !root.contains(b)) return;
      if (b.dataset.ed === 'back') { close(false); return; }
      if (!ed) return;
      if (b.dataset.ed === 'compare') toggleCompare();
      else if (b.dataset.ed === 'revert') revert();
      else if (b.dataset.ed === 'resync') resync();
      else if (b.dataset.ed === 'store') store();
      else if (b.dataset.ed === 'syx') { flush(); host.save(ed.session.name(), ed.session.data.program, ed.session.data.effect); }
      else if (b.dataset.tab) { ed.tab = lastTab = b.dataset.tab; renderBody(); }
      else if (b.dataset.page) { ed.pages[Number(ed.tab.slice(1))] = b.dataset.page; renderBody(); }
      else if (b.dataset.drum) { ed.drums[Number(ed.tab.slice(1))] = Number(b.dataset.drum); renderBody(); }
    });

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (t.id === 'edName') { changeName(t.value); return; }
      var c = t.closest('.ctl');
      if (!c || t.type === 'checkbox' || t.tagName === 'SELECT') return;
      if (t.value === '' || !isFinite(Number(t.value))) return;
      change(c.dataset.kind, c.dataset.key, Math.round(Number(t.value)));
    });

    root.addEventListener('change', function (e) {
      var t = e.target;
      var c = t.closest('.ctl');
      if (!c || !ed) return;
      var f = ed.session.field(c.dataset.kind, c.dataset.key);
      if (!f) return;
      if (t.type === 'checkbox') change(c.dataset.kind, c.dataset.key, t.checked ? 1 : 0);
      else if (t.tagName === 'SELECT') change(c.dataset.kind, c.dataset.key, QS.paramValue(f.def, Number(t.value)));
      else syncControl(c, true); // a number box left empty or out of range snaps back
    });

    // Drum and sound summaries elsewhere on the page follow the controls.
    root.addEventListener('change', function (e) {
      if (!ed || !e.target.closest('.ctl')) return;
      if (/(^s\d\.(enable|keyboardDrumMode)$|^effectConfiguration$)/.test(e.target.closest('.ctl').dataset.key)) renderTabs();
      if (ed.tab !== 'program' && ed.tab !== 'effect' && ed.session.isDrum(Number(ed.tab.slice(1)))) {
        var cur = root.querySelector('.ed-drum.current');
        if (cur) {
          var s = Number(ed.tab.slice(1));
          var dp = 's' + (s + 1) + '.drum' + (ed.drums[s] + 1) + '.';
          var v = function (id) { return ed.session.value('program', dp + id); };
          cur.querySelector('.note').textContent = QS.noteName(v('noteNumber'));
          cur.querySelector('.smp').textContent = v('sampleGroup') + ' / ' + v('sampleNumber');
          cur.querySelector('.vol').textContent = 'vol ' + v('volume');
        }
      }
    });

    return {
      loading: loading,
      isLoading: isLoading,
      failed: failed,
      open: open,
      close: close,
      isOpen: function () { return !root.hidden; },
      isModified: function () { return !!ed && ed.session.isModified(); },
      name: function () { return ed ? ed.session.name() : null; },
      title: function () { return ed ? ed.title : null; },
      externalChange: externalChange,
      resend: resend,
      renderInspector: renderInspector,
      describeEdit: describeEdit
    };
  }

  window.QSEditor = { create: create };
})();

/*
 * qs-edit.js — the program editor's model, without the DOM.
 *
 *   QS.createEditSession(program, effect)  edited copies of a program and its
 *                                          effect, with the originals kept for
 *                                          compare and revert
 *   QS.createThrottle(interval, send)      per-parameter rate limit that always
 *                                          sends the last value
 *   QS.KEYBOARD_PAGES, QS.DRUM_GROUPS      the editor's pages, by the spec's
 *                                          func numbers
 *
 * Pure functions on top of qs-params.js, so the Node tests load it too. The
 * view is app/js/editor.js.
 */
(function (QS) {
  'use strict';

  var DEFS = QS.PARAMDEFS;

  /* ---------------- pages ----------------
   * Keyboard sound pages follow the QS's own functions. Func 16 (mode and
   * enable) sits in the sound's header and func 8 is the program name, so
   * neither has a page. strip is the words the page title makes redundant
   * in its parameter names.
   */
  var KEYBOARD_PAGES = [
    { id: 'sample', title: 'Sample', funcs: [0], strip: '' },
    { id: 'level', title: 'Level', funcs: [1, 2], strip: '' },
    { id: 'pitch', title: 'Pitch', funcs: [3], strip: 'pitch' },
    { id: 'filter', title: 'Filter', funcs: [4], strip: 'filter' },
    { id: 'amp', title: 'Amp', funcs: [5], strip: 'amp' },
    { id: 'range', title: 'Range', funcs: [6], strip: '' },
    { id: 'mod', title: 'Mod matrix', funcs: [7], strip: '' },
    { id: 'pitchLfo', title: 'Pitch LFO', funcs: [9], strip: 'pitch lfo' },
    { id: 'filterLfo', title: 'Filter LFO', funcs: [10], strip: 'filter lfo' },
    { id: 'ampLfo', title: 'Amp LFO', funcs: [11], strip: 'amp lfo' },
    { id: 'pitchEnv', title: 'Pitch env', funcs: [12], strip: 'pitch env' },
    { id: 'filterEnv', title: 'Filter env', funcs: [13], strip: 'filter env' },
    { id: 'ampEnv', title: 'Amp env', funcs: [14], strip: 'amp env' },
    { id: 'tracking', title: 'Tracking', funcs: [15], strip: 'tracking' }
  ];

  // A drum's parameters, one QS function each (all on page 0).
  var DRUM_GROUPS = [
    { title: 'Sample', funcs: [0] },
    { title: 'Level', funcs: [1] },
    { title: 'Effect send', funcs: [2] },
    { title: 'Pitch', funcs: [3] },
    { title: 'Filter', funcs: [4] },
    { title: 'Velocity', funcs: [5] },
    { title: 'Note', funcs: [6] },
    { title: 'Envelope and mute', funcs: [8] }
  ];

  /*
   * Definitions on the given funcs, as rows: one row per QS page (func, page),
   * each ordered by pot, which is how the QS lays them out on its four knobs.
   */
  function pageRows(defs, funcs) {
    var rows = [];
    var byPage = {};
    defs.forEach(function (d) {
      if (d.spare || d.func === null || funcs.indexOf(d.func) < 0) return;
      var k = d.func + '/' + d.page;
      if (!byPage[k]) {
        byPage[k] = { func: d.func, page: d.page, defs: [] };
        rows.push(byPage[k]);
      }
      byPage[k].defs.push(d);
    });
    rows.sort(function (a, b) { return funcs.indexOf(a.func) - funcs.indexOf(b.func) || a.page - b.page; });
    rows.forEach(function (r) { r.defs.sort(function (a, b) { return a.pot - b.pot; }); });
    return rows;
  }

  /*
   * A parameter's name without what its context already says: "Sound pitch
   * LFO speed" on the Pitch LFO page is "Speed", "Send 1 reverb decay" under
   * Reverb send 1 is "Decay", "Drum pan" is "Pan".
   */
  function editLabel(name, strip) {
    var s = name.replace(/^(sound|drum|send \d) /i, '');
    if (strip && s.toLowerCase().indexOf(strip.toLowerCase() + ' ') === 0) s = s.slice(strip.length + 1);
    s = s.replace(/\blfo\b/gi, 'LFO').replace(/\beq\b/gi, 'EQ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /*
   * Range for a control: the spec range, widened to take in value when a
   * dump already holds more (several limits look too low; see the limits
   * test), or every value the bits can hold where the spec gives no limit.
   */
  function editRange(def, value) {
    var r = QS.paramRange(def);
    if (!r) {
      var lo = QS.paramValue(def, 0);
      r = [lo, lo + Math.pow(2, def.bits) - 1];
    }
    return [Math.min(r[0], value), Math.max(r[1], value)];
  }

  /* ---------------- edit session ---------------- */
  // Fields whose value changes which other fields exist.
  var LAYOUT_IDS = { keyboardDrumMode: true, effectConfiguration: true };
  DEFS.effect.configs.forEach(function (c) {
    c.params.forEach(function (d) { if (d.when) LAYOUT_IDS[d.when.id] = true; });
  });

  var DRUM_NUMBER = QS.parseAddress(DEFS.drumSound.params.filter(function (d) { return d.id === 'drumNumber'; })[0].addr);

  function copyOf(kind, data) {
    var d = new Uint8Array(QS.SIZE[kind]);
    d.set(data.subarray ? data.subarray(0, d.length) : data.slice(0, d.length));
    return d;
  }

  function EditSession(program, effect) {
    this.original = { program: copyOf('program', program), effect: effect ? copyOf('effect', effect) : null };
    this.data = { program: null, effect: null };
    this.decoded = { program: null, effect: null };
    this.revert();
  }

  // Back to the original program and effect.
  EditSession.prototype.revert = function () {
    this.adopt('program', this.original.program);
    if (this.original.effect) this.adopt('effect', this.original.effect);
  };

  // Replace the edited dump (with what the QS sent back, say) and decode it.
  EditSession.prototype.adopt = function (kind, data) {
    this.data[kind] = copyOf(kind, data);
    var dec = QS.decodeParams(kind, this.data[kind]);
    var byKey = {};
    dec.fields.forEach(function (f) { byKey[f.key] = f; });
    this.decoded[kind] = { fields: dec.fields, byKey: byKey };
  };

  // The edited version becomes the original (after storing it).
  EditSession.prototype.commit = function () {
    this.original.program = copyOf('program', this.data.program);
    if (this.data.effect) this.original.effect = copyOf('effect', this.data.effect);
  };

  EditSession.prototype.fields = function (kind) {
    return this.decoded[kind] ? this.decoded[kind].fields : [];
  };

  EditSession.prototype.field = function (kind, key) {
    var d = this.decoded[kind];
    return (d && d.byKey[key]) || null;
  };

  EditSession.prototype.value = function (kind, key) {
    var f = this.field(kind, key);
    return f ? f.value : undefined;
  };

  EditSession.prototype.isDrum = function (sound) {
    return this.value('program', 's' + (sound + 1) + '.keyboardDrumMode') === 1;
  };

  EditSession.prototype.name = function () {
    return QS.programName(this.data.program);
  };

  /*
   * Sets one field to value (display terms; kept to what its bits can hold)
   * and returns { field, value, layout }. field is the field as it was before
   * the change, which is what a 10H message for it must address: switching a
   * sound to drums is func 16 on the keyboard sound, not func 9 on the drum
   * sound it becomes. layout is true when the change altered which fields
   * exist (sound mode, effect configuration, pitch and delay types); they are
   * decoded afresh then.
   */
  EditSession.prototype.set = function (kind, key, value) {
    var f = this.field(kind, key);
    if (!f) return null;
    var raw = Math.max(0, Math.min(Math.pow(2, f.def.bits) - 1, QS.paramRaw(f.def, value)));
    var data = this.data[kind];
    QS.setBits(data, f.def.addr, raw, f.base);
    var layout = false;
    if (LAYOUT_IDS[f.def.id] && raw !== f.raw) {
      var before = keysOf(this.decoded[kind].fields);
      this.adopt(kind, data);
      layout = keysOf(this.decoded[kind].fields) !== before;
      if (!layout) f = this.field(kind, key);
    } else {
      // Re-read every field: configuration 4 has fields that share bits.
      this.decoded[kind].fields.forEach(function (x) {
        x.raw = QS.getBits(data, x.def.addr, x.base);
        x.value = QS.paramValue(x.def, x.raw);
      });
    }
    return { field: f, value: QS.paramValue(f.def, raw), layout: layout };
  };

  function keysOf(fields) {
    return fields.map(function (f) { return f.key; }).join();
  }

  /*
   * Sets the program name; returns the keys of the name digits that changed.
   */
  EditSession.prototype.setName = function (name) {
    var padded = (name + '          ').slice(0, 10);
    var changed = [];
    for (var k = 0; k < 10; k++) {
      var key = 'programNameDigit' + k;
      var code = QS.codeFromChar(padded[k]);
      if (this.value('program', key) !== code) {
        this.set('program', key, code);
        changed.push(key);
      }
    }
    return changed;
  };

  /*
   * The 10H messages that set field to value on the QS, or null when the spec
   * gives the field no func/page/pot (send the whole dump instead). A drum's
   * parameters edit whichever drum is selected, so when field is on another
   * drum this first sends drumNumber, and notes the new selection in the local
   * copy as the QS does. The program name goes through sound 1, with func 7
   * when that's a drum sound.
   */
  EditSession.prototype.messages = function (kind, field, value, channel) {
    var opts = { channel: channel || 0 };
    if (kind === 'program' && field.sound === undefined) {
      opts.sound = 0;
      opts.drum = this.isDrum(0);
    }
    var msg = QS.paramEditFor(kind, field, value, opts);
    if (!msg) return null;
    var out = [];
    if (field.drum !== undefined) {
      var sel = this.field('program', 's' + (field.sound + 1) + '.drumNumber');
      if (sel && sel.value !== field.drum) {
        out.push(QS.paramEditFor('program', sel, field.drum, opts));
        this.set('program', sel.key, field.drum);
      }
    }
    out.push(msg);
    return out;
  };

  // Whether field differs from the original (at the same place in the dump).
  EditSession.prototype.isChanged = function (kind, field) {
    var orig = this.original[kind];
    return !!orig && QS.getBits(orig, field.def.addr, field.base) !== field.raw;
  };

  /*
   * Whether anything differs from the original. Which drum is selected
   * doesn't count: editing a drum selects it, as on the QS.
   */
  EditSession.prototype.isModified = function () {
    var p = Uint8Array.from(this.data.program);
    var orig = this.original.program;
    for (var s = 0; s < 4; s++) {
      if (!this.isDrum(s)) continue;
      var base = DEFS.program.soundOffsets[s];
      QS.setBits(p, DRUM_NUMBER, QS.getBits(orig, DRUM_NUMBER, base), base);
    }
    return !sameBytes(p, orig) || !!(this.data.effect && !sameBytes(this.data.effect, this.original.effect));
  };

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ---------------- throttle ----------------
   * Rate limit per key. The first push for a key sends at once; pushes within
   * interval ms of the last send wait, and only the newest value goes out
   * when the wait is over. Dragging a slider so sends at most one message
   * every interval ms and always ends on the final value. clock defaults to
   * Date.now / setTimeout; the tests pass a fake one.
   */
  function createThrottle(interval, send, clock) {
    clock = clock || {
      now: function () { return Date.now(); },
      setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimeout: function (t) { clearTimeout(t); }
    };
    var slots = {};

    function fire(key, s) {
      s.timer = null;
      s.last = clock.now();
      send(key, s.value);
    }

    return {
      push: function (key, value) {
        var s = slots[key] || (slots[key] = { last: -Infinity, timer: null, value: undefined });
        s.value = value;
        if (s.timer) return;
        var wait = s.last + interval - clock.now();
        if (wait <= 0) fire(key, s);
        else s.timer = clock.setTimeout(function () { fire(key, s); }, wait);
      },
      // Send everything that's waiting, now.
      flush: function () {
        Object.keys(slots).forEach(function (key) {
          var s = slots[key];
          if (!s.timer) return;
          clock.clearTimeout(s.timer);
          fire(key, s);
        });
      },
      // Drop everything that's waiting.
      cancel: function () {
        Object.keys(slots).forEach(function (key) {
          if (slots[key].timer) clock.clearTimeout(slots[key].timer);
        });
        slots = {};
      }
    };
  }

  QS.KEYBOARD_PAGES = KEYBOARD_PAGES;
  QS.DRUM_GROUPS = DRUM_GROUPS;
  QS.pageRows = pageRows;
  QS.editLabel = editLabel;
  QS.editRange = editRange;
  QS.createEditSession = function (program, effect) { return new EditSession(program, effect); };
  QS.createThrottle = createThrottle;
})(typeof module !== 'undefined' && module.exports
  ? (module.exports = require('./qs-params.js'))
  : (window.QS = window.QS || {}));

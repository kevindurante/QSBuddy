/*
 * qs-params.js — decode and encode QS dumps field by field.
 *
 * The field definitions live in qs-paramdefs.js, generated from
 * docs/spec/QS678R-sysex-spec.txt by tools/gen_params.py. This file turns a
 * dump into a flat list of fields and back:
 *
 *   QS.decodeParams(kind, data)    kind: 'program' | 'effect' | 'newMix' | 'global'
 *   QS.encodeParams(kind, fields)  a fresh dump built only from the fields' raw values
 *
 * Every bit of a dump belongs to some field; bits the spec doesn't list
 * become "unlisted" fields, so decode then encode is byte-identical.
 *
 *   QS.paramEditFor(kind, field, value, opts)  opcode 10H message for one field
 *   QS.applyParamEdit(kind, data, msg)         the reverse, as the QS does it (the demo QS uses it)
 *
 * QS.decodeProgram / QS.decodeEffect are the inspector's summaries, built on
 * top of the same fields.
 */
(function (QS) {
  'use strict';

  var DEFS = QS.PARAMDEFS;
  var TABLES = { global: DEFS.global, newMix: DEFS.newMix, program: DEFS.program, effect: DEFS.effect };
  var MODE_ADDR = DEFS.keyboardSound.params[0].addr; // keyboard / drum mode, same bit in both sound types
  var DRUM_NUMBER_DEF = DEFS.drumSound.params.filter(function (d) { return d.id === 'drumNumber'; })[0];

  var EFFECT_CONFIGS = [
    '4 sends, 1 reverb',
    '4 sends, 2 reverb',
    '4 sends, 1 Leslie',
    '2 sends with EQ',
    'Overdrive, chorus, delay, reverb, Leslie'
  ];

  function byId(params) {
    var m = {};
    params.forEach(function (p) { if (!p.when) m[p.id] = p; });
    return m;
  }
  var EFFECT_CONFIG_DEF = byId(DEFS.effect.params).effectConfiguration;
  var CONFIG_IDS = DEFS.effect.configs.map(function (c) { return byId(c.params); });

  // Parsed bit addresses, cached per definition.
  var SPANS = typeof Map === 'function' ? new Map() : null;
  function span(def) {
    var a = SPANS && SPANS.get(def);
    if (!a) {
      a = QS.parseAddress(def.addr);
      if (SPANS) SPANS.set(def, a);
    }
    return a;
  }

  function fmtAddr(hi, lo) {
    var a = (hi >> 3) + ':' + (hi & 7);
    return hi === lo ? a : a + '-' + (lo >> 3) + ':' + (lo & 7);
  }

  /*
   * The fields of one dump, in spec order. Each is
   *   { key, def, base, table, sound?, drum?, channel? }
   * where key is unique in the dump ("s2.pan", "s1.drum3.noteNumber",
   * "ch5.volume", "send1PitchType") and base is the byte offset to add to
   * def.addr. Which fields exist depends on the data: each sound's keyboard /
   * drum bit, and the effect configuration and type fields.
   */
  function layout(kind, data) {
    var out = listed(kind, data);
    return out.concat(unlisted(out, TABLES[kind].size));
  }

  // The defined fields alone, without the unlisted bits.
  function listed(kind, data) {
    var t = TABLES[kind];
    if (!t) throw new Error('Unknown dump kind: ' + kind);
    var out = [];
    function add(defs, base, prefix, table, extra) {
      defs.forEach(function (d) {
        var f = { key: prefix + d.id, def: d, base: base, table: table };
        for (var k in extra) f[k] = extra[k];
        out.push(f);
      });
    }
    add(t.params, 0, '', kind);
    if (kind === 'newMix') {
      for (var c = 0; c < t.channel.count; c++) {
        add(t.channel.params, c * t.channel.stride, 'ch' + (c + 1) + '.', 'newMix.channel', { channel: c });
      }
    } else if (kind === 'program') {
      t.soundOffsets.forEach(function (base, s) {
        var pre = 's' + (s + 1) + '.';
        if (QS.getBits(data, MODE_ADDR, base) === 1) {
          add(DEFS.drumSound.params, base, pre, 'drumSound', { sound: s });
          var dr = DEFS.drumSound.drum;
          for (var d = 0; d < dr.count; d++) {
            add(dr.params, base + d * dr.stride, pre + 'drum' + (d + 1) + '.', 'drumSound.drum', { sound: s, drum: d });
          }
        } else {
          add(DEFS.keyboardSound.params, base, pre, 'keyboardSound', { sound: s });
        }
      });
    } else if (kind === 'effect') {
      var n = QS.getBits(data, EFFECT_CONFIG_DEF.addr);
      var cfg = t.configs[n];
      if (cfg) {
        var ids = CONFIG_IDS[n];
        add(cfg.params.filter(function (d) {
          return !d.when || d.when.in.indexOf(QS.getBits(data, span(ids[d.when.id]))) >= 0;
        }), 0, '', 'effect.config' + n);
      }
    }
    return out;
  }

  // Fields for every run of bits no definition covers, one per byte.
  function unlisted(fields, size) {
    var covered = new Uint8Array(size * 8);
    fields.forEach(function (f) {
      var a = span(f.def);
      for (var b = a.lo; b <= a.hi; b++) covered[b + f.base * 8] = 1;
    });
    var out = [];
    for (var b = 0; b < covered.length; b++) {
      if (covered[b]) continue;
      var top = b;
      while (top + 1 < covered.length && !covered[top + 1] && (top + 1) % 8 !== 0) top++;
      var addr = fmtAddr(top, b);
      out.push({
        key: 'unlisted@' + addr, base: 0, table: 'unlisted',
        def: {
          id: 'unlisted@' + addr, name: 'Unlisted bits', addr: addr, bits: top - b + 1, offset: 0, limit: null,
          func: null, page: null, pot: null, display: 'number', unlisted: true
        }
      });
      b = top;
    }
    return out;
  }

  function decodeParams(kind, data) {
    var fields = layout(kind, data);
    var values = {};
    fields.forEach(function (f) {
      f.raw = QS.getBits(data, span(f.def), f.base);
      f.value = paramValue(f.def, f.raw);
      values[f.key] = f.value;
    });
    return { kind: kind, fields: fields, values: values };
  }

  function encodeParams(kind, fields) {
    var data = new Uint8Array(TABLES[kind].size);
    fields.forEach(function (f) { QS.setBits(data, span(f.def), f.raw, f.base); });
    return data;
  }

  /* ---------------- values ----------------
   * Most signed fields are offset binary (value = raw + offset). Global
   * signed fields and the Lezlie horn are two's complement (def.twos).
   */
  function paramValue(def, raw) {
    if (def.twos) return raw & (1 << (def.bits - 1)) ? raw - (1 << def.bits) : raw;
    return raw + (def.offset || 0);
  }

  function paramRaw(def, value) {
    if (def.twos) return value & ((1 << def.bits) - 1);
    return value - (def.offset || 0);
  }

  // [min, max] in value terms, or null where the spec gives no limit.
  function paramRange(def) {
    if (def.twos) return [def.min, def.max];
    if (def.limit === null || def.limit === undefined) return null;
    return [def.offset, def.offset + def.limit];
  }

  function paramInRange(def, raw) {
    var r = paramRange(def);
    if (!r) return true;
    var v = paramValue(def, raw);
    return v >= r[0] && v <= r[1];
  }

  function formatParam(def, raw) {
    var v = paramValue(def, raw);
    switch (def.display) {
      case 'note': return QS.noteName(v);
      case 'onoff': return v ? 'On' : 'Off';
      case 'char': return QS.charFromCode(v);
      case 'signed': return (v > 0 ? '+' : '') + v;
      case 'enum': {
        var label = def.options && def.options[raw];
        if (!label) return String(raw);
        var shared = def.options.indexOf(label) !== def.options.lastIndexOf(label);
        return shared ? label + ' (' + raw + ')' : label;
      }
      default: return String(v);
    }
  }

  /*
   * Opcode 10H message that sets one decoded field to value (in value terms,
   * e.g. -5 for a detune of -5). Returns null for fields the spec gives no
   * func/page/pot. opts.channel: MIDI channel 0-15 in Mix mode.
   * opts.drum: the addressed sound is a drum (program name digits then use
   * func 7). Drum fields edit the drum selected with drumNumber (pot 3).
   */
  function paramEditFor(kind, field, value, opts) {
    var d = field.def;
    opts = opts || {};
    if (d.func === null || d.page === null || d.pot === null) return null;
    var func = opts.drum && d.drumFunc !== undefined ? d.drumFunc : d.func;
    var sound = kind === 'effect' ? (d.send || 0) : (opts.sound !== undefined ? opts.sound : field.sound || 0);
    return QS.build.paramEdit(TABLES[kind].mode, func, sound, d.page, opts.channel || 0, d.pot, value);
  }

  /*
   * The parts of an opcode 10H message: { mode, func, sound, page, channel,
   * pot, value }, value sign-extended from 8-bit two's complement. null for
   * anything else.
   */
  function parseParamEdit(msg) {
    if (msg.length < 11 || msg[0] !== 0xF0 || msg[1] !== 0 || msg[2] !== 0 || msg[3] !== 0x0E || msg[4] !== 0x0E ||
        msg[5] !== QS.OP.PARAM_EDIT) return null;
    var v = ((msg[8] & 1) << 7) | (msg[9] & 0x7F);
    return {
      mode: (msg[6] >> 5) & 3, func: msg[6] & 31, sound: (msg[7] >> 5) & 3, page: msg[7] & 31,
      channel: (msg[8] >> 3) & 15, pot: (msg[8] >> 1) & 3, value: v & 0x80 ? v - 256 : v
    };
  }

  /*
   * The field of data that a parsed 10H edit addresses, as the QS would pick
   * it: the sound's keyboard / drum mode decides its table (and func 7 or 8
   * for the name), drum fields go to the drum selected with drumNumber, and
   * effects match on send. Spare fields never match. Where the spec gives two
   * fields the same coordinates (configuration 4's overdrive rows), the first
   * in spec order wins. null when nothing matches, which on the QS means
   * "no edit".
   */
  function fieldForEdit(kind, data, e) {
    var fields = listed(kind, data);
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var d = f.def;
      if (d.spare || d.func === null || d.page !== e.page || d.pot !== e.pot) continue;
      var func = d.func;
      if (kind === 'program') {
        var s = f.sound !== undefined ? f.sound : e.sound;
        if (s !== e.sound) continue;
        var base = DEFS.program.soundOffsets[s];
        if (f.sound === undefined && d.drumFunc !== undefined && QS.getBits(data, MODE_ADDR, base) === 1) func = d.drumFunc;
        if (f.drum !== undefined && f.drum !== QS.getBits(data, span(DRUM_NUMBER_DEF), base)) continue;
      } else if (kind === 'effect') {
        if ((d.send || 0) !== e.sound) continue;
      } else if (f.channel !== undefined && f.channel !== e.channel) {
        continue;
      }
      if (d.funcs ? d.funcs.indexOf(e.func) >= 0 : func === e.func) return f;
    }
    return null;
  }

  /*
   * Applies a 10H message to a dump in place, the way the QS edits its buffer:
   * the value is limited to the field's spec range. Returns { key, value }
   * for the field it changed, or null when the message isn't for this kind
   * of dump or addresses nothing.
   */
  function applyParamEdit(kind, data, msg) {
    var e = parseParamEdit(msg);
    if (!e || !TABLES[kind] || e.mode !== TABLES[kind].mode) return null;
    var f = fieldForEdit(kind, data, e);
    if (!f) return null;
    var v = e.value;
    var r = paramRange(f.def);
    if (r) v = Math.max(r[0], Math.min(r[1], v));
    QS.setBits(data, span(f.def), paramRaw(f.def, v), f.base);
    return { key: f.key, value: v };
  }

  /* ---------------- inspector summaries ---------------- */
  // Inspector keys -> keyboard sound ids.
  var KEYBOARD_SUMMARY = {
    mode: 'keyboardDrumMode', sampleGroup: 'sampleGroup', sampleNum: 'sampleNumber', volume: 'volume', pan: 'pan',
    output: 'output', fxLevel: 'effectLevel', fxBus: 'effectBus', semitone: 'pitchSemitone', detune: 'pitchDetune',
    filterFreq: 'filterFrequency', lowNote: 'lowNoteLimit', highNote: 'highNoteLimit', ampAttack: 'ampEnvAttack',
    ampDecay: 'ampEnvDecay', ampSustain: 'ampEnvSustain', ampRelease: 'ampEnvRelease', enable: 'enable'
  };
  var DRUM_SUMMARY = { sampleGroup: 'sampleGroup', sampleNum: 'sampleNumber', volume: 'volume', note: 'noteNumber' };

  function pick(values, prefix, map) {
    var o = {};
    Object.keys(map).forEach(function (k) { o[k] = values[prefix + map[k]]; });
    return o;
  }

  function decodeProgram(data) {
    var params = decodeParams('program', data);
    var v = params.values;
    var sounds = DEFS.program.soundOffsets.map(function (_, i) {
      var pre = 's' + (i + 1) + '.';
      if (v[pre + 'keyboardDrumMode'] === 1) {
        var drums = [];
        for (var d = 0; d < DEFS.drumSound.drum.count; d++) drums.push(pick(v, pre + 'drum' + (d + 1) + '.', DRUM_SUMMARY));
        return { index: i, type: 'drum', enabled: v[pre + 'enable'] === 1, drums: drums };
      }
      var s = pick(v, pre, KEYBOARD_SUMMARY);
      s.index = i;
      s.type = 'keyboard';
      s.enabled = s.enable === 1;
      return s;
    });
    return { name: QS.programName(data), romId: v.romIdentifier, sounds: sounds, params: params };
  }

  function decodeEffect(data) {
    var params = decodeParams('effect', data);
    var config = params.values.effectConfiguration;
    return { config: config, configName: EFFECT_CONFIGS[config] || ('Config ' + config), params: params };
  }

  QS.EFFECT_CONFIGS = EFFECT_CONFIGS;
  QS.decodeParams = decodeParams;
  QS.encodeParams = encodeParams;
  QS.paramValue = paramValue;
  QS.paramRaw = paramRaw;
  QS.paramRange = paramRange;
  QS.paramInRange = paramInRange;
  QS.formatParam = formatParam;
  QS.paramEditFor = paramEditFor;
  QS.parseParamEdit = parseParamEdit;
  QS.fieldForEdit = fieldForEdit;
  QS.applyParamEdit = applyParamEdit;
  QS.decodeProgram = decodeProgram;
  QS.decodeEffect = decodeEffect;
})(typeof module !== 'undefined' && module.exports
  ? (module.exports = require('./qs-paramdefs.js'))
  : (window.QS = window.QS || {}));

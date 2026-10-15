/*
 * qs-sysex.js — Alesis QS6/7/8/R SysEx codec.
 *
 * Everything here follows "QS6,7,8,R MIDI SYSEX SPECIFICATION" (Feb 1997),
 * which lives in this repo at synthzoneftp-dump/QS8/Alesis-QS678R.txt.
 *
 * Pure functions only (no DOM, no Web MIDI), so the same file runs in the
 * browser (window.QS) and in Node for tests (module.exports).
 */
(function (QS) {
  'use strict';

  var HEADER = [0xF0, 0x00, 0x00, 0x0E, 0x0E];

  var OP = {
    USER_PROGRAM: 0x00,
    USER_PROGRAM_REQ: 0x01,
    EDIT_PROGRAM: 0x02,
    EDIT_PROGRAM_REQ: 0x03,
    OLD_MIX: 0x04,
    OLD_MIX_REQ: 0x05,
    USER_EFFECT: 0x06,
    USER_EFFECT_REQ: 0x07,
    EDIT_EFFECT: 0x08,
    EDIT_EFFECT_REQ: 0x09,
    GLOBAL: 0x0A,
    GLOBAL_REQ: 0x0B,
    ALL_REQ: 0x0C,
    MODE_SELECT: 0x0D,
    NEW_MIX: 0x0E,
    NEW_MIX_REQ: 0x0F,
    PARAM_EDIT: 0x10
  };

  // Unpacked (8-bit) sizes of each dump type.
  var SIZE = { program: 350, effect: 65, newMix: 138, oldMix: 123, global: 20 };

  // Universal Device Inquiry family members.
  var FAMILY_MEMBERS = { 3: 'QS6', 4: 'QS8', 5: 'QS7', 6: 'QSR' };

  // Byte offset of each of the four sounds inside a program.
  var SOUND_OFFSETS = [10, 95, 180, 265];

  /* ---------------- 7-bit <-> 8-bit packing ----------------
   * Every 7 QS bytes travel as 8 MIDI bytes. Treat the 7 bytes as one
   * little-endian bit stream and slice it into 7-bit words, LSB first.
   * A trailing group of r < 7 bytes becomes r + 1 MIDI bytes.
   */
  function unpack(midi) {
    var out = [];
    for (var i = 0; i < midi.length; i += 8) {
      var n = Math.min(8, midi.length - i);
      var acc = 0n;
      for (var j = 0; j < n; j++) acc |= BigInt(midi[i + j] & 0x7F) << BigInt(7 * j);
      var bytes = Math.floor((n * 7) / 8);
      for (var k = 0; k < bytes; k++) out.push(Number((acc >> BigInt(8 * k)) & 0xFFn));
    }
    return Uint8Array.from(out);
  }

  function pack(data) {
    var out = [];
    for (var i = 0; i < data.length; i += 7) {
      var r = Math.min(7, data.length - i);
      var acc = 0n;
      for (var j = 0; j < r; j++) acc |= BigInt(data[i + j]) << BigInt(8 * j);
      var words = Math.ceil((r * 8) / 7);
      for (var k = 0; k < words; k++) out.push(Number((acc >> BigInt(7 * k)) & 0x7Fn));
    }
    return Uint8Array.from(out);
  }

  /* ---------------- bit fields ----------------
   * The spec writes addresses as "hiByte:hiBit-loByte:loBit" (MSB first),
   * e.g. "2:5-1:7", or "84:3" for a single bit. Bits are numbered as one
   * continuous stream: absolute bit = byte * 8 + bit.
   */
  function parseAddress(addr) {
    var parts = String(addr).split('-');
    var hi = parts[0].split(':').map(Number);
    var lo = (parts[1] || parts[0]).split(':').map(Number);
    return { hi: hi[0] * 8 + hi[1], lo: lo[0] * 8 + lo[1] };
  }

  function getBits(data, addr, base) {
    var a = typeof addr === 'string' ? parseAddress(addr) : addr;
    var off = (base || 0) * 8;
    var v = 0;
    for (var b = a.hi; b >= a.lo; b--) {
      var abs = b + off;
      v = (v << 1) | ((data[abs >> 3] >> (abs & 7)) & 1);
    }
    return v;
  }

  function setBits(data, addr, value, base) {
    var a = typeof addr === 'string' ? parseAddress(addr) : addr;
    var off = (base || 0) * 8;
    for (var b = a.lo; b <= a.hi; b++) {
      var abs = b + off;
      var bit = (value >> (b - a.lo)) & 1;
      if (bit) data[abs >> 3] |= 1 << (abs & 7);
      else data[abs >> 3] &= ~(1 << (abs & 7));
    }
    return data;
  }

  /* ---------------- names ----------------
   * Name digits are 7-bit indexes (0-95) into ASCII starting at space.
   * Program names are 10 consecutive 7-bit fields starting at 1:0.
   */
  function charFromCode(v) {
    if (v === 95) return '→'; // last slot isn't printable ASCII (DEL); the QS shows an arrow
    return v >= 0 && v < 95 ? String.fromCharCode(32 + v) : '?';
  }

  function codeFromChar(ch) {
    if (ch === '→') return 95;
    var c = ch.charCodeAt(0) - 32;
    return c >= 0 && c < 95 ? c : 0;
  }

  function programName(data) {
    var s = '';
    for (var k = 0; k < 10; k++) {
      var lo = 8 + 7 * k;
      s += charFromCode(getBits(data, { hi: lo + 6, lo: lo }));
    }
    return s;
  }

  function setProgramName(data, name) {
    var padded = (name + '          ').slice(0, 10);
    for (var k = 0; k < 10; k++) {
      var lo = 8 + 7 * k;
      setBits(data, { hi: lo + 6, lo: lo }, codeFromChar(padded[k]));
    }
    return data;
  }

  function mixName(data) {
    var s = '';
    for (var k = 0; k < 10; k++) {
      var lo = 5 + 7 * k; // "Mix name digit 0" = 1:3-0:5
      s += charFromCode(getBits(data, { hi: lo + 6, lo: lo }));
    }
    return s;
  }

  // ROM identifier (9:7-9:6). 0 = QuadraSynth Plus / S4 Plus program, which
  // the QS remaps to its own ROM automatically when it receives it.
  function romId(data) {
    return getBits(data, '9:7-9:6');
  }

  /* ---------------- message framing ---------------- */
  function splitSysex(bytes) {
    var msgs = [];
    var start = -1;
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xF0) start = i;
      else if (bytes[i] === 0xF7 && start >= 0) {
        msgs.push(bytes.slice(start, i + 1));
        start = -1;
      }
    }
    return msgs;
  }

  function isQS(msg) {
    return msg.length >= 7 && msg[0] === 0xF0 && msg[1] === 0x00 && msg[2] === 0x00 &&
      msg[3] === 0x0E && msg[4] === 0x0E;
  }

  /*
   * Parse one complete SysEx message.
   * Returns { kind: 'qs', op, num, data } for QS messages,
   *         { kind: 'identity', member, model, version } for a device inquiry reply,
   *         or null.
   */
  function parseMessage(msg) {
    if (msg.length >= 15 && msg[0] === 0xF0 && msg[1] === 0x7E && msg[3] === 0x06 && msg[4] === 0x02 &&
        msg[5] === 0x00 && msg[6] === 0x00 && msg[7] === 0x0E) {
      var member = msg[10] | (msg[11] << 7);
      var ver = String.fromCharCode(msg[12], msg[13], msg[14], msg[15]);
      return {
        kind: 'identity',
        family: msg[8] | (msg[9] << 7),
        member: member,
        model: FAMILY_MEMBERS[member] || ('QS (member ' + member + ')'),
        version: /^\d{4}$/.test(ver) ? (Number(ver.slice(0, 2)) + '.' + ver.slice(2)) : ver
      };
    }
    if (!isQS(msg)) return null;
    var op = msg[5];
    var hasNum = op !== OP.GLOBAL_REQ && op !== OP.ALL_REQ && op !== 0x14;
    var body = msg.slice(hasNum ? 7 : 6, msg.length - 1);
    var res = { kind: 'qs', op: op, num: hasNum ? msg[6] : null };
    if (op === OP.USER_PROGRAM || op === OP.EDIT_PROGRAM || op === OP.USER_EFFECT ||
        op === OP.EDIT_EFFECT || op === OP.NEW_MIX || op === OP.OLD_MIX || op === OP.GLOBAL) {
      res.data = unpack(body);
    }
    return res;
  }

  /*
   * Parse a .syx bank file (a QS "All Dump", a single dump, or a librarian
   * export). Programs and effects are returned as 128-slot arrays (null where
   * the file has nothing).
   *
   * Effect pairing: in an All Dump, user effect N belongs to user program N.
   * Some librarians (QE 1.1 .PAT files) instead write each program followed
   * immediately by its effect under an unrelated effect number; when every
   * program is directly followed by an effect we pair them by order.
   */
  function parseBank(bytes) {
    var msgs = splitSysex(bytes);
    var programs = new Array(128).fill(null);
    var effects = new Array(128).fill(null);
    var mixNames = [];
    var seq = [];
    msgs.forEach(function (m) {
      var p = parseMessage(m);
      if (!p || p.kind !== 'qs') return;
      if (p.op === OP.USER_PROGRAM && p.data.length >= SIZE.program) {
        programs[p.num & 0x7F] = p.data.slice(0, SIZE.program);
        seq.push({ t: 'p', num: p.num & 0x7F });
      } else if (p.op === OP.EDIT_PROGRAM && p.data.length >= SIZE.program) {
        // Single-patch files hold edit-buffer dumps; give each the next free slot.
        var slot = programs.indexOf(null);
        if (slot < 0) return;
        programs[slot] = p.data.slice(0, SIZE.program);
        seq.push({ t: 'p', num: slot });
      } else if ((p.op === OP.USER_EFFECT || p.op === OP.EDIT_EFFECT) && p.data.length >= SIZE.effect) {
        seq.push({ t: 'e', num: p.num & 0x7F, data: p.data.slice(0, SIZE.effect), edit: p.op === OP.EDIT_EFFECT });
      } else if (p.op === OP.NEW_MIX && p.num < 100) {
        mixNames[p.num] = mixName(p.data);
      }
    });

    var interleaved = seq.length > 1;
    for (var i = 0; i < seq.length; i++) {
      if (seq[i].t === 'p' && !(seq[i + 1] && seq[i + 1].t === 'e')) { interleaved = false; break; }
    }
    seq.forEach(function (s, i) {
      if (s.t !== 'e') return;
      if (interleaved) {
        var prev = seq[i - 1];
        if (prev && prev.t === 'p') effects[prev.num] = s.data;
      } else if (!s.edit) {
        effects[s.num] = s.data;
      } else {
        var prevP = seq[i - 1];
        if (prevP && prevP.t === 'p') effects[prevP.num] = s.data;
      }
    });

    return {
      programs: programs,
      effects: effects,
      names: programs.map(function (d) { return d ? programName(d) : null; }),
      mixNames: mixNames,
      programCount: programs.filter(Boolean).length
    };
  }

  /* ---------------- message builders ---------------- */
  function qsMessage(op, num, payload) {
    var out = HEADER.concat([op]);
    if (num !== null && num !== undefined) out.push(num & 0x7F);
    if (payload) for (var i = 0; i < payload.length; i++) out.push(payload[i]);
    out.push(0xF7);
    return Uint8Array.from(out);
  }

  var build = {
    deviceInquiry: function () { return Uint8Array.from([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]); },
    bankSelect: function (ch, bank) { return Uint8Array.from([0xB0 | (ch & 15), 0x00, bank & 0x7F]); },
    programChange: function (ch, prog) { return Uint8Array.from([0xC0 | (ch & 15), prog & 0x7F]); },
    noteOn: function (ch, note, vel) { return Uint8Array.from([0x90 | (ch & 15), note & 0x7F, vel & 0x7F]); },
    noteOff: function (ch, note) { return Uint8Array.from([0x80 | (ch & 15), note & 0x7F, 0]); },
    allNotesOff: function (ch) { return Uint8Array.from([0xB0 | (ch & 15), 123, 0]); },
    allSoundOff: function (ch) { return Uint8Array.from([0xB0 | (ch & 15), 120, 0]); },
    modeSelect: function (mix) { return qsMessage(OP.MODE_SELECT, mix ? 1 : 0); },
    userProgramRequest: function (n) { return qsMessage(OP.USER_PROGRAM_REQ, n); },
    editProgramRequest: function (edit) { return qsMessage(OP.EDIT_PROGRAM_REQ, edit || 0); },
    editEffectRequest: function (edit) { return qsMessage(OP.EDIT_EFFECT_REQ, edit || 0); },
    userProgramDump: function (n, data) { return qsMessage(OP.USER_PROGRAM, n, pack(data)); },
    editProgramDump: function (edit, data) { return qsMessage(OP.EDIT_PROGRAM, edit || 0, pack(data)); },
    userEffectDump: function (n, data) { return qsMessage(OP.USER_EFFECT, n, pack(data)); },
    editEffectDump: function (edit, data) { return qsMessage(OP.EDIT_EFFECT, edit || 0, pack(data)); },
    /*
     * Direct parameter edit (opcode 10H) — the building block for a future
     * editor. mode: 0 Global, 1 Mix, 2 Program, 3 Effects.
     */
    paramEdit: function (mode, func, sound, page, channel, pot, value) {
      var v = value & 0xFF; // 8-bit two's complement
      return qsMessage(OP.PARAM_EDIT, null, [
        ((mode & 3) << 5) | (func & 31),
        ((sound & 3) << 5) | (page & 31),
        ((channel & 15) << 3) | ((pot & 3) << 1) | (v >> 7),
        v & 0x7F
      ]);
    }
  };

  /* ---------------- helpers ---------------- */
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(n) { return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1); }

  function toHex(bytes, max) {
    var n = Math.min(bytes.length, max || bytes.length);
    var s = [];
    for (var i = 0; i < n; i++) s.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16).toUpperCase());
    return s.join(' ') + (bytes.length > n ? ' … (' + bytes.length + ' bytes)' : '');
  }

  QS.OP = OP;
  QS.SIZE = SIZE;
  QS.SOUND_OFFSETS = SOUND_OFFSETS;
  QS.FAMILY_MEMBERS = FAMILY_MEMBERS;
  QS.unpack = unpack;
  QS.pack = pack;
  QS.parseAddress = parseAddress;
  QS.getBits = getBits;
  QS.setBits = setBits;
  QS.programName = programName;
  QS.setProgramName = setProgramName;
  QS.mixName = mixName;
  QS.romId = romId;
  QS.splitSysex = splitSysex;
  QS.parseMessage = parseMessage;
  QS.parseBank = parseBank;
  QS.build = build;
  QS.noteName = noteName;
  QS.toHex = toHex;
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.QS = window.QS || {}));

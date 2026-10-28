// Program editor model tests: opcode 10H messages, applying them the way the
// demo QS does, the edit session and the throttle. Run with: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const QS = require('../app/js/qs-edit.js');

const FACTORY = path.resolve(__dirname, '..', 'archive', 'BANKS', 'FACTORY');
const DEFS = QS.PARAMDEFS;
const bank = (file) => QS.parseBank(new Uint8Array(fs.readFileSync(path.join(FACTORY, file))));
const P1 = bank('Q678PST1.SYX');
const P3 = bank('Q678PST3.SYX');
const hex = (msgs) => msgs.map((m) => QS.toHex(m));

// Keyboard sounds only, drums and keys mixed both ways round.
const PROGRAMS = [
  { name: 'P1 #0', data: P1.programs[0], modes: [0, 0, 0, 0] },
  { name: 'P1 #121', data: P1.programs[121], modes: [1, 1, 1, 0] },
  { name: 'P3 #121', data: P3.programs[121], modes: [0, 0, 1, 1] },
];

// Configuration 4 rows the spec gives the same func/page/pot (see qs-params.test.js).
const CONFIG4_CONFLICTS = new Set(['lowEqFrequency', 'send1OverdriveMix', 'send1OverdriveType', 'hiEqFrequency', 'send1OverdriveThreshold']);

function spanBits(field) {
  const a = QS.parseAddress(field.def.addr);
  const out = [];
  for (let b = a.lo; b <= a.hi; b++) out.push(b + field.base * 8);
  return out;
}

// Bits that differ between two dumps, as absolute bit numbers.
function changedBits(a, b) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ^ b[i];
    for (let k = 0; k < 8; k++) if (x & (1 << k)) out.push(i * 8 + k);
  }
  return out;
}

// A value other than the field's current one, inside its spec range.
function otherValue(def, value) {
  const r = QS.paramRange(def) || QS.editRange(def, value);
  return value >= r[0] && value < r[1] ? value + 1 : r[0];
}

function editable(f) {
  const d = f.def;
  return !d.spare && !d.unlisted && d.func !== null && d.page !== null && d.pot !== null;
}

/*
 * Edits every editable field of a session in turn, the way the editor does
 * (set, then send the session's messages), and applies the messages to a
 * second copy the way the demo QS does. After each edit the "QS" must hold
 * the new value, nothing outside the field (and the drum selection) may have
 * moved, and the editor's copy must equal the QS's byte for byte.
 */
function sweep(kind, session, where, skip) {
  const qs = Uint8Array.from(session.data[kind]);
  let edits = 0;
  for (const start of session.fields(kind).filter(editable)) {
    if (skip && skip(start)) continue;
    const f = session.field(kind, start.key);
    const value = otherValue(f.def, f.value);
    const res = session.set(kind, f.key, value);
    assert.ok(!res.layout, `${where} ${f.key} doesn't change the layout`);
    const msgs = session.messages(kind, res.field, res.value);
    const before = Uint8Array.from(qs);
    for (const m of msgs) assert.ok(QS.applyParamEdit(kind, qs, m), `${where} ${f.key}: ${QS.toHex(m)} addresses a field`);
    const dec = QS.decodeParams(kind, qs);
    assert.strictEqual(dec.values[f.key], value, `${where} ${f.key} reads back`);
    const allowed = new Set(spanBits(f));
    if (f.drum !== undefined) spanBits(session.field('program', `s${f.sound + 1}.drumNumber`)).forEach((b) => allowed.add(b));
    const stray = changedBits(before, qs).filter((b) => !allowed.has(b));
    assert.deepStrictEqual(stray, [], `${where} ${f.key} touches only its own bits`);
    assert.deepStrictEqual([...session.data[kind]], [...qs], `${where} ${f.key}: editor copy matches the QS`);
    edits++;
  }
  return edits;
}

/* ---------------- opcode 10H bytes ---------------- */

test('paramEditFor produces the expected bytes', () => {
  const s = QS.createEditSession(P1.programs[0], P1.effects[0]);
  // Filter frequency 42 on sound 1: program mode (2) func 4, sound 0 page 0, channel 0 pot 0.
  s.set('program', 's1.filterFrequency', 42);
  assert.deepStrictEqual(hex(s.messages('program', s.field('program', 's1.filterFrequency'), 42)),
    ['F0 00 00 0E 0E 10 44 00 00 2A F7']);
  // Detune -5 on sound 2 (func 3 page 0 pot 2): -5 is FB in two's complement, its top bit goes with the pot.
  assert.deepStrictEqual(hex(s.messages('program', s.field('program', 's2.pitchDetune'), -5)),
    ['F0 00 00 0E 0E 10 43 20 05 7B F7']);
  // Mod 6 amplitude on sound 4: func 7 page 5 pot 2.
  assert.deepStrictEqual(hex(s.messages('program', s.field('program', 's4.mod6Amplitude'), 99)),
    ['F0 00 00 0E 0E 10 47 65 04 63 F7']);
  // Name digit 0 = "H" (code 40): func 8 through sound 1.
  assert.deepStrictEqual(hex(s.messages('program', s.field('program', 'programNameDigit0'), 40)),
    ['F0 00 00 0E 0E 10 48 00 00 28 F7']);
  // Effects: mode 3, the send from the definition. Send 2 reverb input level is func 3 page 0 pot 3 on send 2.
  assert.strictEqual(s.value('effect', 'effectConfiguration'), 3);
  const lvl = s.field('effect', 'send2ReverbInputLevel');
  assert.deepStrictEqual(hex(s.messages('effect', lvl, 50)), ['F0 00 00 0E 0E 10 63 20 06 32 F7']);
});

test('drum edits select the drum first; the name uses func 7 on a drum sound', () => {
  const s = QS.createEditSession(P1.programs[121], P1.effects[121]);
  assert.strictEqual(s.isDrum(0), true);
  const sel = s.value('program', 's1.drumNumber');
  const other = sel === 4 ? 5 : 4;
  const f = s.field('program', `s1.drum${other + 1}.volume`);
  // drumNumber is func 0 page 0 pot 3; drum volume func 1 page 0 pot 0.
  assert.deepStrictEqual(hex(s.messages('program', f, 20)), [
    `F0 00 00 0E 0E 10 40 00 06 0${other} F7`,
    'F0 00 00 0E 0E 10 41 00 00 14 F7',
  ]);
  assert.strictEqual(s.value('program', 's1.drumNumber'), other, 'the session follows the selection');
  assert.deepStrictEqual(hex(s.messages('program', f, 21)), ['F0 00 00 0E 0E 10 41 00 00 15 F7'], 'no second select');
  assert.deepStrictEqual(hex(s.messages('program', s.field('program', 'programNameDigit0'), 40)),
    ['F0 00 00 0E 0E 10 47 00 00 28 F7']);
});

test('parseParamEdit reverses QS.build.paramEdit', () => {
  for (const [mode, func, sound, page, channel, pot] of [[2, 4, 0, 0, 0, 0], [3, 6, 1, 3, 0, 2], [1, 16, 3, 23, 15, 3]]) {
    for (let value = -128; value <= 127; value++) {
      const e = QS.parseParamEdit(QS.build.paramEdit(mode, func, sound, page, channel, pot, value));
      assert.deepStrictEqual(e, { mode, func, sound, page, channel, pot, value });
    }
  }
  assert.strictEqual(QS.parseParamEdit(QS.build.editProgramRequest(0)), null);
});

test('every editable value fits in 8-bit two\'s complement', () => {
  const tables = [DEFS.program.params, DEFS.keyboardSound.params, DEFS.drumSound.params, DEFS.drumSound.drum.params,
    DEFS.effect.params, ...DEFS.effect.configs.map((c) => c.params)];
  for (const defs of tables) {
    for (const d of defs) {
      if (d.spare || d.func === null) continue;
      const r = QS.paramRange(d);
      if (!r) continue;
      assert.ok(r[0] >= -128 && r[1] <= 127, `${d.id} ${r}`);
    }
  }
});

/* ---------------- applying edits (the demo QS) ---------------- */

for (const p of PROGRAMS) {
  test(`every program edit on ${p.name} lands on its field only`, () => {
    const s = QS.createEditSession(p.data, null);
    assert.deepStrictEqual([0, 1, 2, 3].map((i) => (s.isDrum(i) ? 1 : 0)), p.modes);
    // Mode switches change the layout; they have their own test.
    const edits = sweep('program', s, p.name, (f) => f.def.id === 'keyboardDrumMode');
    assert.ok(edits > 300, `${edits} edits`);
  });
}

test('every effect edit lands on its field only, in every configuration and type', () => {
  const s = QS.createEditSession(P1.programs[0], P1.effects[0]);
  const layoutIds = ['effectConfiguration'];
  let edits = 0;
  for (let cfg = 0; cfg <= 4; cfg++) {
    s.set('effect', 'effectConfiguration', cfg);
    const typeIds = [...new Set(DEFS.effect.configs[cfg].params.filter((d) => d.when).map((d) => d.when.id))];
    const types = typeIds.map((id) => DEFS.effect.configs[cfg].params.find((d) => d.id === id && !d.when));
    // Each type value in turn, with the other types at 0.
    const settings = [{}];
    for (const t of types) for (let v = 1; v <= t.limit; v++) settings.push({ [t.id]: v });
    for (const set of settings) {
      for (const t of types) s.set('effect', t.id, set[t.id] || 0);
      edits += sweep('effect', s, `config ${cfg} ${JSON.stringify(set)}`, (f) =>
        layoutIds.includes(f.def.id) || typeIds.includes(f.def.id) || (cfg === 4 && CONFIG4_CONFLICTS.has(f.def.id)));
    }
  }
  assert.ok(edits > 1000, `${edits} edits`);
});

test('configuration 4 conflicts go to the first field in spec order', () => {
  const s = QS.createEditSession(P1.programs[0], P1.effects[0]);
  s.set('effect', 'effectConfiguration', 4);
  const fx = Uint8Array.from(s.data.effect);
  const mix = s.field('effect', 'send1OverdriveMix');
  const hit = QS.applyParamEdit('effect', fx, QS.paramEditFor('effect', mix, 1));
  assert.strictEqual(hit.key, 'send1OverdriveType');
});

test('mode, configuration and type changes address the field as it was', () => {
  // Keyboard to drum: func 16 on the keyboard sound; drum to keyboard: func 9 on the drum sound.
  const s = QS.createEditSession(P3.programs[121], null);
  const qs = Uint8Array.from(s.data.program);
  let res = s.set('program', 's1.keyboardDrumMode', 1);
  assert.ok(res.layout);
  let msgs = s.messages('program', res.field, res.value);
  assert.deepStrictEqual(hex(msgs), ['F0 00 00 0E 0E 10 50 00 00 01 F7']);
  msgs.forEach((m) => QS.applyParamEdit('program', qs, m));
  assert.ok(s.isDrum(0) && s.field('program', 's1.drum1.noteNumber'), 'sound 1 now decodes as drums');
  res = s.set('program', 's3.keyboardDrumMode', 0);
  msgs = s.messages('program', res.field, res.value);
  assert.deepStrictEqual(hex(msgs), ['F0 00 00 0E 0E 10 49 40 00 00 F7']);
  msgs.forEach((m) => QS.applyParamEdit('program', qs, m));
  assert.deepStrictEqual([...qs], [...s.data.program], 'the QS made the same changes');

  const fx = QS.createEditSession(P1.programs[0], P1.effects[0]);
  const qfx = Uint8Array.from(fx.data.effect);
  for (const [key, value] of [['effectConfiguration', 0], ['send1PitchType', 5], ['send1DelayType', 1], ['effectConfiguration', 4], ['send1PitchType', 2]]) {
    res = fx.set('effect', key, value);
    fx.messages('effect', res.field, res.value).forEach((m) => assert.ok(QS.applyParamEdit('effect', qfx, m), key));
    assert.deepStrictEqual([...qfx], [...fx.data.effect], `${key} = ${value}`);
  }
  assert.ok(fx.field('effect', 'send1ResonatorTuning') && fx.field('effect', 'send1OverdriveThreshold'));
});

test('applyParamEdit limits values and ignores what it can\'t place', () => {
  const data = Uint8Array.from(P1.programs[0]);
  const vol = QS.decodeParams('program', data).fields.find((f) => f.key === 's1.volume');
  assert.deepStrictEqual(QS.applyParamEdit('program', data, QS.paramEditFor('program', vol, 120)), { key: 's1.volume', value: 99 });
  assert.strictEqual(QS.decodeParams('program', data).values['s1.volume'], 99);
  const before = Uint8Array.from(data);
  assert.strictEqual(QS.applyParamEdit('program', data, QS.build.paramEdit(2, 30, 0, 0, 0, 0, 1)), null, 'no func 30');
  assert.strictEqual(QS.applyParamEdit('effect', data, QS.paramEditFor('program', vol, 50)), null, 'program edit, effect dump');
  assert.deepStrictEqual([...data], [...before]);
});

/* ---------------- edit session ---------------- */

test('edit session: modified, revert, commit and name', () => {
  const s = QS.createEditSession(P1.programs[121], P1.effects[121]);
  assert.strictEqual(s.isModified(), false);
  // Selecting another drum doesn't count as a change.
  const sel = s.value('program', 's1.drumNumber');
  s.messages('program', s.field('program', `s1.drum${sel === 0 ? 2 : 1}.volume`), 10);
  assert.notStrictEqual(s.value('program', 's1.drumNumber'), sel);
  assert.strictEqual(s.isModified(), false);

  const pan = s.value('program', 's4.pan');
  s.set('program', 's4.pan', pan === 0 ? 1 : 0);
  assert.ok(s.isModified() && s.isChanged('program', s.field('program', 's4.pan')));
  s.set('program', 's4.pan', pan);
  assert.strictEqual(s.isModified(), false, 'back to the original value');

  const name = QS.programName(P1.programs[121]);
  const changed = [...Array(10).keys()].filter((k) => name[k] !== 'Pad       '[k]).map((k) => 'programNameDigit' + k);
  assert.deepStrictEqual(s.setName('Pad'), changed, 'digits that changed');
  assert.strictEqual(s.name(), 'Pad       ');
  assert.ok(s.isModified());
  s.set('effect', 'effectConfiguration', 1);
  s.revert();
  assert.strictEqual(s.isModified(), false);
  assert.strictEqual(s.name(), QS.programName(P1.programs[121]));
  assert.deepStrictEqual([...s.data.effect], [...P1.effects[121]]);

  s.setName('Stored');
  s.commit();
  assert.strictEqual(s.isModified(), false);
  assert.strictEqual(QS.programName(s.original.program), 'Stored    ');
});

test('editor pages cover every keyboard and drum parameter once', () => {
  const seen = new Map();
  for (const page of QS.KEYBOARD_PAGES) {
    for (const row of QS.pageRows(DEFS.keyboardSound.params, page.funcs)) {
      for (const d of row.defs) seen.set(d.id, (seen.get(d.id) || 0) + 1);
    }
  }
  const header = new Set(['keyboardDrumMode', 'enable']); // in the sound's header
  for (const d of DEFS.keyboardSound.params) {
    if (d.spare || d.func === null || header.has(d.id)) continue;
    assert.strictEqual(seen.get(d.id), 1, d.id);
  }
  const drums = new Map();
  for (const g of QS.DRUM_GROUPS) {
    for (const row of QS.pageRows(DEFS.drumSound.drum.params, g.funcs)) for (const d of row.defs) drums.set(d.id, (drums.get(d.id) || 0) + 1);
  }
  for (const d of DEFS.drumSound.drum.params) if (!d.spare) assert.strictEqual(drums.get(d.id), 1, d.id);
  assert.deepStrictEqual(QS.pageRows(DEFS.keyboardSound.params, [7]).map((r) => r.defs.map((d) => d.pot)),
    Array(6).fill([0, 1, 2, 3]), 'mod matrix: six slots of four');
  assert.strictEqual(QS.editLabel('Sound pitch lfo speed', 'pitch lfo'), 'Speed');
  assert.strictEqual(QS.editLabel('Send 1 reverb decay', 'reverb'), 'Decay');
  assert.strictEqual(QS.editLabel('Drum pan', ''), 'Pan');
});

/* ---------------- throttle ---------------- */

function fakeClock() {
  let now = 0;
  let timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

test('throttle: at most one send per key every 30 ms, ending on the last value', () => {
  const clock = fakeClock();
  const sent = [];
  const th = QS.createThrottle(30, (key, value) => sent.push([clock.now(), key, value]), clock);
  // A drag: a new value every 5 ms for 100 ms.
  for (let i = 0; i <= 20; i++) {
    th.push('cutoff', i);
    clock.advance(5);
  }
  clock.advance(100);
  assert.deepStrictEqual(sent.map(([, , v]) => v).slice(0, 1), [0], 'the first value goes at once');
  assert.strictEqual(sent[sent.length - 1][2], 20, 'the last value always goes');
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i][0] - sent[i - 1][0] >= 30, 'spaced by 30 ms');
  assert.ok(sent.length <= 5, `${sent.length} sends for 21 values over 100 ms`);

  // Keys don't hold each other up.
  sent.length = 0;
  th.push('a', 1);
  th.push('b', 1);
  assert.deepStrictEqual(sent.map(([, k]) => k), ['a', 'b']);

  // After a pause the next value goes at once again.
  clock.advance(1000);
  sent.length = 0;
  th.push('a', 2);
  assert.deepStrictEqual(sent.map(([, , v]) => v), [2]);

  // flush sends what's waiting; cancel drops it.
  th.push('a', 3);
  th.flush();
  assert.deepStrictEqual(sent.map(([, , v]) => v), [2, 3]);
  clock.advance(10);
  th.push('a', 4);
  th.cancel();
  clock.advance(100);
  assert.deepStrictEqual(sent.map(([, , v]) => v), [2, 3]);
});

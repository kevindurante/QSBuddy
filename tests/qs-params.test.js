// Parameter model tests: the generated definitions (app/js/qs-paramdefs.js)
// against every dump in archive/. Run with: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const QS = require('../app/js/qs-params.js');

const REPO = path.resolve(__dirname, '..');
const ARCHIVE = path.join(REPO, 'archive');
const DEFS = QS.PARAMDEFS;
const FACTORY_P1 = path.join(ARCHIVE, 'BANKS', 'FACTORY', 'Q678PST1.SYX');
const KINDS = ['program', 'effect', 'newMix', 'global'];
const OP_KIND = { 0x00: 'program', 0x02: 'program', 0x06: 'effect', 0x08: 'effect', 0x0E: 'newMix', 0x0A: 'global' };

function syxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) syxFiles(p, out);
    else if (/\.syx$/i.test(e.name)) out.push(p);
  }
  return out;
}

function libraryDumps() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(REPO, 'app', 'library', 'index.js'), 'utf8'), ctx);
  const out = [];
  for (const b of ctx.window.QSLIB_INDEX.collections.flatMap((c) => c.banks)) {
    let progs = null, fx = null, hasFx = null;
    const QSLIB = { addBank: (id, p, e, h) => { progs = Buffer.from(p, 'base64'); fx = Buffer.from(e, 'base64'); hasFx = h; } };
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'app', 'library', 'banks', b.id + '.js'), 'utf8'), { QSLIB });
    b.names.forEach((name, i) => {
      if (name !== null) out.push({ kind: 'program', data: new Uint8Array(progs.subarray(i * 350, (i + 1) * 350)), where: 'library ' + b.id + ' #' + i });
      if (hasFx[i]) out.push({ kind: 'effect', data: new Uint8Array(fx.subarray(i * 65, (i + 1) * 65)), where: 'library ' + b.id + ' effect #' + i });
    });
  }
  return out;
}

/*
 * Every program, effect, new mix and global dump in archive/**.syx,
 * deduplicated by content, each with where it was first seen. Programs and
 * effects from the bundled library are added too, since some banks only
 * exist inside zips.
 */
const DUMPS = (() => {
  const maps = { program: new Map(), effect: new Map(), newMix: new Map(), global: new Map() };
  const stats = { messages: 0, short: 0, long: 0 };
  function add(kind, data, where) {
    const size = DEFS[kind].size;
    if (data.length < size) {
      // Pre-2.00 global dumps leave off the last three bytes (spec line 151),
      // and a few files have a dump that is one MIDI byte short.
      stats.short++;
      const padded = new Uint8Array(size);
      padded.set(data);
      data = padded;
    } else if (data.length > size) {
      stats.long++;
      data = data.slice(0, size);
    }
    const key = Buffer.from(data).toString('latin1');
    if (!maps[kind].has(key)) maps[kind].set(key, { data, where });
  }
  for (const file of syxFiles(ARCHIVE)) {
    const rel = path.relative(ARCHIVE, file).split(path.sep).join('/');
    for (const m of QS.splitSysex(new Uint8Array(fs.readFileSync(file)))) {
      const p = QS.parseMessage(m);
      if (!p || p.kind !== 'qs' || !p.data || !OP_KIND[p.op]) continue;
      stats.messages++;
      add(OP_KIND[p.op], p.data, rel + ' op ' + p.op.toString(16).padStart(2, '0') + ' #' + p.num);
    }
  }
  for (const { kind, data, where } of libraryDumps()) add(kind, data, where);
  const out = { stats };
  for (const k of KINDS) out[k] = [...maps[k].values()];
  return out;
})();

const DECODED = {};
function decodedAll(kind) {
  if (!DECODED[kind]) DECODED[kind] = DUMPS[kind].map((d) => ({ where: d.where, dec: QS.decodeParams(kind, d.data) }));
  return DECODED[kind];
}

// A field is live unless it belongs to a disabled sound or mix channel.
function isLive(dec, f) {
  if (f.sound !== undefined) return dec.values['s' + (f.sound + 1) + '.enable'] === 1;
  if (f.channel !== undefined) return dec.values['ch' + (f.channel + 1) + '.enable'] === 1;
  return true;
}

/* ---------------- definitions ---------------- */

test('generated definitions are up to date with the spec', (t) => {
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, [path.join(REPO, 'tools', 'gen_params.py'), '--check'], { encoding: 'utf8' });
    if (r.error || /not found|was not found/i.test(r.stderr || '')) continue;
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return;
  }
  t.skip('Python not found');
});

function allDefs() {
  const out = [];
  const push = (table, params) => params.forEach((d) => out.push({ table, d }));
  push('global', DEFS.global.params);
  push('newMix', DEFS.newMix.params);
  push('newMix.channel', DEFS.newMix.channel.params);
  push('program', DEFS.program.params);
  push('keyboardSound', DEFS.keyboardSound.params);
  push('drumSound', DEFS.drumSound.params);
  push('drumSound.drum', DEFS.drumSound.drum.params);
  push('effect', DEFS.effect.params);
  DEFS.effect.configs.forEach((c) => push('effect.config' + c.index, c.params));
  return out;
}

test('every definition is well formed', () => {
  const displays = new Set(['number', 'signed', 'note', 'onoff', 'char', 'enum']);
  for (const { table, d } of allDefs()) {
    const where = table + '.' + d.id + ' (spec line ' + d.line + ')';
    const a = QS.parseAddress(d.addr);
    assert.strictEqual(a.hi - a.lo + 1, d.bits, where + ': bits');
    assert.ok(displays.has(d.display), where + ': display');
    if (d.display === 'enum') assert.ok(Array.isArray(d.options) && d.options.length > 0, where + ': options');
    if (d.limit !== null && !d.twos) assert.ok(d.limit < 2 ** d.bits, where + ': limit fits');
    if (d.twos) assert.ok(d.min >= -(2 ** (d.bits - 1)) && d.max < 2 ** (d.bits - 1), where + ': twos range');
    if (d.when) assert.ok(Array.isArray(d.when.in), where + ': when');
  }
  assert.strictEqual(DEFS.keyboardSound.params.length, 122);
  assert.strictEqual(DEFS.drumSound.drum.params.length, 16);
  assert.strictEqual(DEFS.drumSound.drum.count, 10);
  assert.strictEqual(DEFS.newMix.channel.params.length, 20);
  assert.strictEqual(DEFS.newMix.channel.count, 16);
  assert.strictEqual(DEFS.effect.configs.length, 5);
});

test('errata keep the spec values they replace', () => {
  const byLine = new Map(allDefs().map(({ d }) => [d.line, d]));
  assert.deepStrictEqual(byLine.get(842).spec, { addr: '16:8-16:5' });
  assert.strictEqual(byLine.get(842).addr, '17:0-16:5');
  assert.deepStrictEqual(byLine.get(882).spec, { send: 0 });
  assert.strictEqual(byLine.get(882).send, 1);
  assert.deepStrictEqual(byLine.get(1199).spec, { num: '65' });
  const ch16 = DEFS.newMix.channel.instances.find((i) => i.n === 16);
  assert.deepStrictEqual([ch16.num, ch16.spec], ['313-332', { num: '240-332' }]);
});

/* ---------------- round trips ---------------- */

test('archive holds the expected number of dumps', (t) => {
  t.diagnostic(`${DUMPS.stats.messages} dump messages; unique: ${KINDS.map((k) => DUMPS[k].length + ' ' + k).join(', ')}` +
    `; ${DUMPS.stats.short} short, ${DUMPS.stats.long} long`);
  assert.ok(DUMPS.program.length >= 6500, 'programs: ' + DUMPS.program.length);
  assert.ok(DUMPS.effect.length >= 4500, 'effects: ' + DUMPS.effect.length);
  assert.ok(DUMPS.newMix.length >= 3000, 'new mixes: ' + DUMPS.newMix.length);
  assert.ok(DUMPS.global.length >= 10, 'globals: ' + DUMPS.global.length);
});

for (const kind of KINDS) {
  test(`every ${kind} dump decodes and re-encodes byte-identically`, () => {
    const bad = [];
    DUMPS[kind].forEach(({ data, where }, i) => {
      const dec = decodedAll(kind)[i].dec;
      if (new Set(dec.fields.map((f) => f.key)).size !== dec.fields.length) bad.push(where + ': duplicate keys');
      const enc = QS.encodeParams(kind, dec.fields);
      if (Buffer.compare(Buffer.from(enc), Buffer.from(data)) !== 0) bad.push(where);
    });
    assert.deepStrictEqual(bad.slice(0, 10), [], `${bad.length} ${kind} dumps failed`);
  });
}

test('parseBank programs and effects round-trip too', () => {
  for (const file of [FACTORY_P1, path.join(ARCHIVE, 'BANKS', 'EXPANDO', 'Q678XDRM.syx')]) {
    const bank = QS.parseBank(new Uint8Array(fs.readFileSync(file)));
    bank.programs.forEach((p, i) => {
      assert.deepStrictEqual(QS.encodeParams('program', QS.decodeParams('program', p).fields), p, `${file} program ${i}`);
      const e = bank.effects[i];
      assert.deepStrictEqual(QS.encodeParams('effect', QS.decodeParams('effect', e).fields), e, `${file} effect ${i}`);
    });
  }
});

/* ---------------- limits ---------------- */

/*
 * Live fields seen above their spec limit, and what we think is going on.
 * "spec?" marks a limit that looks wrong in the spec (common in Alesis
 * banks, or the field's bits allow it); "data" marks a handful of odd
 * values in individual banks. A live field that goes out of range and
 * isn't listed here fails the test: look at the values, then either fix the
 * generator (tools/gen_params.py ERRATA) or add it here.
 */
const RARE = 'data: a few odd values in single banks';
const KNOWN_OUTLIERS = {
  'keyboardSound.keyMode': 'spec?: 3 in 570+ live sounds, mostly Alesis banks; the 2-bit field may have four key modes.',
  'keyboardSound.pitchEnvRelease': 'spec?: 100 in 230+ live sounds; pitch env decay and the env delays go to 100.',
  'keyboardSound.pitchLfoWaveform': 'spec?: 7 in ~100 Alesis programs; the 3-bit field may have eight waveforms.',
  'keyboardSound.filterLfoWaveform': 'spec?: 7 in ~80 Alesis programs; the 3-bit field may have eight waveforms.',
  'keyboardSound.ampLfoWaveform': 'spec?: 7 in ~40 Alesis programs; the 3-bit field may have eight waveforms.',
  'keyboardSound.ampVelocityCurve': 'spec?: 13-15 in 110+ live sounds, factory Preset 1 among them.',
  'keyboardSound.trackingInput': 'spec?: 30 and 24 in 210+ live sounds; the input list looks longer than 0-22.',
  'keyboardSound.trackingPoint3': 'spec?: the same values recur (points 3-7: 115, 118, 106, 108, 115), so not corruption.',
  'keyboardSound.trackingPoint4': 'spec?: see trackingPoint3.',
  'keyboardSound.trackingPoint5': 'spec?: see trackingPoint3.',
  'keyboardSound.trackingPoint6': 'spec?: see trackingPoint3.',
  'keyboardSound.trackingPoint7': 'spec?: see trackingPoint3.',
  'keyboardSound.trackingPoint2': RARE,
  'keyboardSound.trackingPoint9': RARE,
  'keyboardSound.trackingPoint10': RARE,
  'newMix.channel.programType': 'spec?: limit 1, but the field is 4 bits and live channels use 0-15. 0-4 match the Bank Select numbers, so it looks like the bank.',
  'effect.effectConfiguration': 'data: one effect in 22BANKS/chrom_fx.syx says configuration 5; it decodes as common fields plus unlisted bits.',
  'effect.config3.send2DelayType': 'data: 22BANKS/drum1.syx effect #71 is one MIDI byte short, so its end is padded with zeros.',
  'keyboardSound.ampEnvDecay': RARE,
  'keyboardSound.ampEnvLevel': RARE,
  'keyboardSound.ampEnvSustain': RARE,
  'keyboardSound.ampLfoAftertouchMod': RARE,
  'keyboardSound.ampLfoMod': RARE,
  'keyboardSound.effectLevel': RARE,
  'keyboardSound.filterEnvLevel': RARE,
  'keyboardSound.filterEnvMod': RARE,
  'keyboardSound.filterEnvRelease': RARE,
  'keyboardSound.filterEnvSustain': RARE,
  'keyboardSound.filterEnvVelocityMod': RARE,
  'keyboardSound.filterLfoMod': RARE,
  'keyboardSound.filterVelocityMod': RARE,
  'keyboardSound.mod3Amplitude': RARE,
  'keyboardSound.mod5Source': RARE,
  'keyboardSound.mod6Amplitude': RARE,
  'keyboardSound.overlap': RARE,
  'keyboardSound.pitchDetune': RARE,
  'keyboardSound.pitchEnvDecay': RARE,
  'keyboardSound.pitchEnvDelay': RARE,
  'keyboardSound.pitchEnvMod': RARE,
  'keyboardSound.pitchEnvSustainDecay': RARE,
  'keyboardSound.pitchSemitone': RARE,
  'keyboardSound.pitchWheelMod': RARE,
  'effect.config0.send1ReverbBalance': RARE,
  'effect.config0.send1ReverbInputLevel': RARE,
  'effect.config0.send2ResonatorTuning': RARE,
  'effect.config1.midimodDestination2': RARE,
  'effect.config1.midimodLevel1': RARE,
  'effect.config1.midimodSource1': RARE,
  'effect.config1.send2ReverbInputLevel': RARE,
  'effect.config3.midimodDestination2': RARE,
  'effect.config3.midimodSource2': RARE,
  'effect.config3.reverbType': RARE,
  'effect.config3.send1LeftDelay10ms': RARE,
  'effect.config3.send1PitchDepth': RARE,
  'effect.config3.send1ReverbBalance': RARE,
  'effect.config3.send1ReverbInputLevel': RARE,
  'effect.config3.send1ReverbPrdly10ms': RARE,
  'effect.config3.send2Delay10ms': RARE,
  'effect.config3.send2ResonatorDecay': RARE,
  'effect.config3.send2ResonatorTuning': RARE,
  'effect.config4.reverbType': RARE,
  'effect.config4.send1LeftDelay10ms': RARE,
  'effect.config4.send1LezlieHorn': RARE,
  'effect.config4.send1PitchSpeed': RARE,
  'effect.config4.send1ReverbDiffusion': RARE,
};

function outliers() {
  const live = new Map();
  let unused = 0;
  for (const kind of KINDS) {
    for (const { where, dec } of decodedAll(kind)) {
      for (const f of dec.fields) {
        const d = f.def;
        if (d.spare || d.unlisted || QS.paramInRange(d, f.raw)) continue;
        if (!isLive(dec, f)) { unused++; continue; }
        const key = f.table + '.' + d.id;
        let o = live.get(key);
        if (!o) live.set(key, (o = { key, range: QS.paramRange(d), count: 0, values: new Map(), where: [] }));
        o.count++;
        o.values.set(f.value, (o.values.get(f.value) || 0) + 1);
        if (o.where.length < 2 && !o.where.includes(where)) o.where.push(where);
      }
    }
  }
  return { live: [...live.values()].sort((a, b) => a.key.localeCompare(b.key)), unused };
}

test('fields above their spec limit (report)', (t) => {
  const { live, unused } = outliers();
  t.diagnostic(`${unused} out-of-range fields in disabled sounds and mix channels (left-over data, not counted)`);
  for (const o of live) {
    const vals = [...o.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${v}×${n}`).join(' ');
    const known = KNOWN_OUTLIERS[o.key];
    t.diagnostic(`${known ? known.split(':')[0].padEnd(5) : 'NEW  '} ${o.key} (${o.range.join('..')}): ${o.count}× ${vals}; e.g. ${o.where.join('; ')}`);
  }
  for (const k of Object.keys(KNOWN_OUTLIERS)) {
    if (!live.some((o) => o.key === k)) t.diagnostic('no longer out of range: ' + k);
  }
  const unknown = live.filter((o) => !KNOWN_OUTLIERS[o.key]).map((o) => o.key);
  assert.deepStrictEqual(unknown, [], 'new out-of-range fields; see the diagnostics');
});

test('non-zero spare and unlisted bits (report)', (t) => {
  const counts = new Map();
  for (const kind of KINDS) {
    for (const { dec } of decodedAll(kind)) {
      for (const f of dec.fields) {
        if (!(f.def.spare || f.def.unlisted) || f.raw === 0) continue;
        const key = f.table + '.' + f.def.id;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  for (const [k, n] of [...counts.entries()].sort()) t.diagnostic(`${k}: ${n}`);
});

/*
 * Opcode 10H addresses a parameter by func/page/pot (and sound, send or
 * channel), so two fields that are active together must not share them.
 * Config 4's overdrive rows clash with each other and with the EQ; the spec
 * can't tell which is right (see tools/gen_params.py ERRATA).
 */
const KNOWN_10H_CONFLICTS = new Set([
  'effect.config4 6/0/0/0: lowEqFrequency send1OverdriveMix send1OverdriveType',
  'effect.config4 6/0/2/0: hiEqFrequency send1OverdriveThreshold',
]);

test('opcode 10H coordinates are unique among active fields', () => {
  const found = new Set();
  for (const kind of KINDS) {
    for (const { dec } of decodedAll(kind)) {
      const v = dec.values;
      const groups = new Map();
      const put = (scope, func, d) => {
        const k = `${scope} ${func}/${d.page}/${d.pot}/${kind === 'effect' ? d.send || 0 : 0}`;
        if (!groups.has(k)) groups.set(k, new Set());
        groups.get(k).add(d.id);
      };
      for (const f of dec.fields) {
        const d = f.def;
        // Every drum shares its coordinates; drumNumber picks which one is edited.
        if (d.spare || d.unlisted || d.func === null || d.page === null || d.pot === null || f.drum > 0) continue;
        if (kind === 'effect') put('effect.config' + v.effectConfiguration, d.func, d);
        else if (kind === 'newMix') put(f.channel === undefined ? 'newMix' : 'newMix.ch' + (f.channel + 1), d.func, d);
        else if (kind === 'global') put('global', d.func, d);
        else if (f.sound !== undefined) put('program.s' + (f.sound + 1), d.func, d);
        else {
          // Program-wide fields (the name) are edited through each sound, with
          // func 7 instead of 8 when that sound is a drum (spec line 594).
          for (let s = 1; s <= 4; s++) {
            const drum = v[`s${s}.keyboardDrumMode`] === 1;
            put('program.s' + s, drum && d.drumFunc !== undefined ? d.drumFunc : d.func, d);
          }
        }
      }
      for (const [k, ids] of groups) if (ids.size > 1) found.add(`${k}: ${[...ids].sort().join(' ')}`);
    }
  }
  assert.deepStrictEqual([...found].filter((c) => !KNOWN_10H_CONFLICTS.has(c)), []);
  assert.deepStrictEqual([...KNOWN_10H_CONFLICTS].filter((c) => !found.has(c)), [], 'known conflicts still show up');
});

/* ---------------- known values ---------------- */

test('factory Preset 1 #0 TrueStereo', () => {
  const bank = QS.parseBank(new Uint8Array(fs.readFileSync(FACTORY_P1)));
  const dec = QS.decodeParams('program', bank.programs[0]);
  const v = dec.values;
  const name = Array.from({ length: 10 }, (_, k) => QS.charFromCode(v['programNameDigit' + k])).join('');
  assert.strictEqual(name, 'TrueStereo');
  for (let s = 1; s <= 4; s++) {
    assert.strictEqual(v[`s${s}.keyboardDrumMode`], 0, `sound ${s} is a keyboard sound`);
    assert.strictEqual(v[`s${s}.enable`], 1, `sound ${s} is on`);
  }
  // Left/right pairs split at F6/F#6.
  assert.deepStrictEqual([1, 2, 3, 4].map((s) => v[`s${s}.pan`]), [0, 6, 0, 6]);
  const field = (key) => dec.fields.find((f) => f.key === key);
  const note = (key) => QS.formatParam(field(key).def, field(key).raw);
  assert.deepStrictEqual([note('s1.lowNoteLimit'), note('s1.highNoteLimit')], ['C-1', 'F6']);
  assert.deepStrictEqual([note('s2.lowNoteLimit'), note('s2.highNoteLimit')], ['C-1', 'F6']);
  assert.deepStrictEqual([note('s3.lowNoteLimit'), note('s3.highNoteLimit')], ['F#6', 'G9']);
  assert.deepStrictEqual([note('s4.lowNoteLimit'), note('s4.highNoteLimit')], ['F#6', 'G9']);
  assert.strictEqual(v.romIdentifier, QS.romId(bank.programs[0]));
});

test('name digits agree with the hand-written name codec', () => {
  for (const [kind, prefix, read] of [['program', 'programNameDigit', QS.programName], ['newMix', 'mixNameDigit', QS.mixName]]) {
    DUMPS[kind].forEach(({ data, where }, i) => {
      const v = decodedAll(kind)[i].dec.values;
      const name = Array.from({ length: 10 }, (_, k) => QS.charFromCode(v[prefix + k])).join('');
      assert.strictEqual(name, read(data), where);
    });
  }
});

test('drum kits decode as drum sounds', () => {
  const bank = QS.parseBank(new Uint8Array(fs.readFileSync(path.join(ARCHIVE, 'BANKS', 'EXPANDO', 'Q678XDRM.syx'))));
  const dec = QS.decodeParams('program', bank.programs[0]);
  const drums = dec.fields.filter((f) => f.table === 'drumSound.drum' && f.def.id === 'noteNumber');
  assert.ok(drums.length >= 10 && drums.length % 10 === 0);
  const s = drums[0].sound;
  const notes = drums.filter((f) => f.sound === s).map((f) => f.raw);
  assert.strictEqual(new Set(notes).size, 10, 'ten different drum notes in one kit');
  assert.ok(dec.fields.some((f) => f.key === `s${s + 1}.drum10.sampleGroup`));
});

test('factory global dump', () => {
  const g = QS.splitSysex(new Uint8Array(fs.readFileSync(FACTORY_P1))).map(QS.parseMessage).find((p) => p && p.op === 0x0A);
  const v = QS.decodeParams('global', g.data).values;
  assert.deepStrictEqual([v.controllerANumber, v.controllerBNumber, v.controllerCNumber, v.controllerDNumber], [12, 13, 91, 93]);
  assert.deepStrictEqual([v.pitchTranspose, v.pitchFineTune, v.keyboardTranspose], [0, 0, 0]);
});

test('effect layouts follow the configuration and type fields', () => {
  const seen = new Set();
  for (const { dec } of decodedAll('effect')) {
    const cfg = dec.values.effectConfiguration;
    if (cfg > 4) continue;
    seen.add(cfg);
    const keys = new Set(dec.fields.map((f) => f.key));
    if (cfg === 0) {
      const t = dec.values.send1PitchType;
      assert.strictEqual(keys.has('send1PitchSpeed'), t <= 3);
      assert.strictEqual(keys.has('send1PitchDetune'), t === 4);
      assert.strictEqual(keys.has('send1ResonatorTuning'), t === 5);
      assert.strictEqual(keys.has('send1RightDelay10ms'), dec.values.send1DelayType === 1);
    }
    if (cfg === 3) assert.ok(keys.has('lowEqGain') && !keys.has('send3PitchType'));
  }
  assert.deepStrictEqual([...seen].sort(), [0, 1, 2, 3, 4]);
});

test('values, formatting and opcode 10H', () => {
  const bank = QS.parseBank(new Uint8Array(fs.readFileSync(FACTORY_P1)));
  const dec = QS.decodeParams('program', bank.programs[0]);
  const f = dec.fields.find((x) => x.key === 's3.pitchLfoMod');
  assert.deepStrictEqual([f.def.func, f.def.page, f.def.pot], [3, 1, 2]);
  // Same message as the QS.build.paramEdit test: program mode, func 3, sound 3, page 1, pot 2, value -5.
  assert.deepStrictEqual([...QS.paramEditFor('program', f, -5)],
    [0xF0, 0, 0, 0x0E, 0x0E, 0x10, 0x43, 0x41, 0x05, 0x7B, 0xF7]);
  // Offset binary and two's complement.
  const detune = DEFS.keyboardSound.params.find((d) => d.id === 'pitchDetune');
  assert.deepStrictEqual([QS.paramValue(detune, 0), QS.paramValue(detune, 99), QS.paramRaw(detune, -5)], [-99, 0, 94]);
  const horn = DEFS.effect.configs[2].params.find((d) => d.id === 'send1LezlieHorn');
  assert.deepStrictEqual([QS.paramValue(horn, 6), QS.paramValue(horn, 127), QS.paramValue(horn, 122), QS.paramRaw(horn, -1)], [6, -1, -6, 127]);
  const transpose = DEFS.global.params.find((d) => d.id === 'pitchTranspose');
  assert.deepStrictEqual([QS.paramValue(transpose, 0xF4), QS.formatParam(transpose, 0xF4)], [-12, '-12']);
  const type = DEFS.effect.configs[0].params.find((d) => d.id === 'send1PitchType');
  assert.deepStrictEqual([QS.formatParam(type, 2), QS.formatParam(type, 5)], ['Chorus and flange (2)', 'Resonator']);
  // Effect sends come from the definition; global and mix edits set their mode.
  const fx = QS.decodeParams('effect', bank.effects[0]);
  const cfgField = fx.fields.find((x) => x.key === 'effectConfiguration');
  assert.strictEqual(QS.paramEditFor('effect', cfgField, 0)[6] >> 5, 3);
  const mix = QS.splitSysex(new Uint8Array(fs.readFileSync(FACTORY_P1))).map(QS.parseMessage).find((p) => p && p.op === 0x0E);
  const vol = QS.decodeParams('newMix', mix.data).fields.find((x) => x.key === 'ch5.volume');
  const msg = QS.paramEditFor('newMix', vol, 80, { channel: vol.channel });
  assert.deepStrictEqual([msg[6] >> 5, msg[6] & 31, msg[8] >> 3, msg[9]], [1, 1, 4, 80]);
});

test('inspector summaries still decode', () => {
  const bank = QS.parseBank(new Uint8Array(fs.readFileSync(FACTORY_P1)));
  const p = QS.decodeProgram(bank.programs[0]);
  assert.strictEqual(p.name, 'TrueStereo');
  assert.deepStrictEqual(p.sounds.map((s) => [s.type, s.pan, s.lowNote, s.highNote]),
    [['keyboard', 0, 0, 89], ['keyboard', 6, 0, 89], ['keyboard', 0, 90, 127], ['keyboard', 6, 90, 127]]);
  const fx = QS.decodeEffect(bank.effects[0]);
  assert.ok(fx.config >= 0 && fx.config <= 4);
  assert.strictEqual(fx.configName, QS.EFFECT_CONFIGS[fx.config]);
});

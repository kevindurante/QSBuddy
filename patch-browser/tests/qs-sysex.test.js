// Run with: node --test patch-browser/tests
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const QS = require('../js/qs-params.js');

const REPO = path.resolve(__dirname, '..', '..');
const APP = path.resolve(__dirname, '..');

function loadIndex() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(APP, 'library', 'index.js'), 'utf8'), ctx);
  return ctx.window.QSLIB_INDEX;
}

function loadBankFile(id) {
  let captured = null;
  const ctx = { QSLIB: { addBank: (bankId, p, e, hasFx) => { captured = { bankId, p, e, hasFx }; } } };
  vm.runInNewContext(fs.readFileSync(path.join(APP, 'library', 'banks', id + '.js'), 'utf8'), ctx);
  return captured;
}

const FACTORY = path.join(REPO, 'BANKS', 'FACTORY', 'Q678PST1.SYX');

test('unpack/pack round-trips every QS dump in the factory bank', () => {
  const bytes = new Uint8Array(fs.readFileSync(FACTORY));
  const msgs = QS.splitSysex(bytes);
  assert.strictEqual(msgs.length, 128 + 128 + 100 + 1);
  for (const m of msgs) {
    const body = m.slice(7, m.length - 1);
    assert.deepStrictEqual(QS.pack(QS.unpack(body)), body);
  }
});

test('dump sizes match the spec', () => {
  const msgs = QS.splitSysex(new Uint8Array(fs.readFileSync(FACTORY)));
  const sizes = {};
  for (const m of msgs) {
    const p = QS.parseMessage(m);
    sizes[p.op] = [m.length, p.data.length];
  }
  assert.deepStrictEqual(sizes[0x00], [408, 350]); // program
  assert.deepStrictEqual(sizes[0x06], [83, 65]); // effect
  assert.deepStrictEqual(sizes[0x0E], [166, 138]); // new mix
  assert.deepStrictEqual(sizes[0x0A], [31, 20]); // global
});

test('parseBank reads the factory Preset 1 names', () => {
  const bank = QS.parseBank(new Uint8Array(fs.readFileSync(FACTORY)));
  assert.strictEqual(bank.programCount, 128);
  assert.strictEqual(bank.names[0], 'TrueStereo');
  assert.strictEqual(bank.names[127], 'Orch Hits ');
  assert.ok(bank.effects.every(Boolean));
  assert.strictEqual(bank.mixNames.length, 100);
});

test('program name write/read round-trips', () => {
  const data = new Uint8Array(350);
  QS.setProgramName(data, 'Hello QS7!');
  assert.strictEqual(QS.programName(data), 'Hello QS7!');
});

test('bit fields follow the spec addressing', () => {
  const data = new Uint8Array(4);
  QS.setBits(data, '2:5-1:7', 0x7F); // spans two bytes
  assert.strictEqual(QS.getBits(data, '2:5-1:7'), 0x7F);
  assert.strictEqual(data[1], 0x80);
  assert.strictEqual(data[2], 0x3F);
});

test('message builders', () => {
  assert.deepStrictEqual([...QS.build.bankSelect(0, 3)], [0xB0, 0x00, 3]);
  assert.deepStrictEqual([...QS.build.programChange(15, 127)], [0xCF, 127]);
  assert.deepStrictEqual([...QS.build.editProgramRequest(0)], [0xF0, 0, 0, 0x0E, 0x0E, 0x03, 0, 0xF7]);
  assert.deepStrictEqual([...QS.build.modeSelect(false)], [0xF0, 0, 0, 0x0E, 0x0E, 0x0D, 0, 0xF7]);
  const data = new Uint8Array(350).fill(0x55);
  const dump = QS.build.editProgramDump(0, data);
  assert.strictEqual(dump.length, 408);
  assert.deepStrictEqual(QS.parseMessage(dump).data, data);
  // opcode 10H: program mode, func 3, sound 2, page 1, ch 0, pot 2, value -5
  assert.deepStrictEqual([...QS.build.paramEdit(2, 3, 2, 1, 0, 2, -5)],
    [0xF0, 0, 0, 0x0E, 0x0E, 0x10, 0x43, 0x41, 0x05, 0x7B, 0xF7]);
});

test('device inquiry reply decodes a QS7', () => {
  const reply = Uint8Array.from([0xF0, 0x7E, 0x00, 0x06, 0x02, 0x00, 0x00, 0x0E, 0x0E, 0x00, 0x05, 0x00,
    0x30, 0x32, 0x30, 0x30, 0xF7]);
  const id = QS.parseMessage(reply);
  assert.strictEqual(id.model, 'QS7');
  assert.strictEqual(id.version, '2.00');
});

test('program decoder reads sound layout', () => {
  const bank = QS.parseBank(new Uint8Array(fs.readFileSync(path.join(REPO, 'BANKS', 'EXPANDO', 'Q678XDRM.syx'))));
  const kit = QS.decodeProgram(bank.programs[0]);
  assert.ok(kit.sounds.some((s) => s.type === 'drum'), 'a drum bank program has drum sounds');
  const keys = QS.decodeProgram(QS.parseBank(new Uint8Array(fs.readFileSync(FACTORY))).programs[0]);
  const s1 = keys.sounds[0];
  assert.strictEqual(s1.type, 'keyboard');
  assert.ok(s1.lowNote <= s1.highNote);
  assert.ok(s1.volume >= 0 && s1.volume <= 99);
});

test('generated library matches the source banks', () => {
  const index = loadIndex();
  const banks = index.collections.flatMap((c) => c.banks);
  assert.ok(banks.length >= 60);
  for (const b of banks) {
    const file = loadBankFile(b.id);
    assert.strictEqual(file.bankId, b.id);
    const progs = Buffer.from(file.p, 'base64');
    assert.strictEqual(progs.length, 128 * 350);
    b.names.forEach((name, i) => {
      if (name === null) return;
      const data = new Uint8Array(progs.subarray(i * 350, (i + 1) * 350));
      assert.strictEqual(QS.programName(data).trimEnd(), name, `${b.id} #${i}`);
    });
  }
  const user = banks.find((b) => b.id === 'factory-user');
  assert.strictEqual(user.names[0], 'PureStereo');
  const z1 = index.cards.find((c) => c.id === 'z1');
  assert.strictEqual(z1.names[0], 'SchoolYard');
  assert.strictEqual(z1.names[127], 'Hard Organ');
  const r8 = index.cards.find((c) => c.id === 'r8');
  assert.strictEqual(r8.names[0], 'ClubQuadra');
  assert.strictEqual(r8.names[1], 'AmberTranz');
});

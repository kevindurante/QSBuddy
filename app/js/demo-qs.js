/*
 * demo-qs.js — a pretend QS7 for trying the browser without hardware.
 * Loaded only when the page is opened with ?demo. It answers the device
 * inquiry, program/effect dump requests and remembers what it's sent, using
 * the factory banks from the library as its memory. Parameter edits (10H)
 * change its edit buffers through QS.applyParamEdit, as the editor expects
 * of a real QS.
 */
(function () {
  'use strict';

  var QS = window.QS;
  var BANK_BY_CC = { 0: 'factory-user', 1: 'factory-p1', 2: 'factory-p2', 3: 'factory-p3', 4: 'factory-gm' };

  function createAccess() {
    var input = { id: 'demo-in', name: 'QS7 (demo)', manufacturer: 'QSBuddy', state: 'connected', onmidimessage: null };
    var output = { id: 'demo-out', name: 'QS7 (demo)', manufacturer: 'QSBuddy', state: 'connected' };
    var synth = { bank: 1, program: 0, user: {}, userFx: {}, edit: null, editFx: null };
    // Messages are handled one at a time, so edits and requests land in order
    // even while a bank file is still loading.
    var queue = Promise.resolve();
    // ?demo&progsel=off acts like a QS with MIDI Program Select turned off.
    var ignoreProgramChanges = /[?&]progsel=off\b/.test(location.search);
    // ?demo&sysex=off acts like a MIDI chain that only forwards channel messages.
    var dropSysex = /[?&]sysex=off\b/.test(location.search);

    function reply(bytes) {
      setTimeout(function () {
        if (input.onmidimessage) input.onmidimessage({ data: Uint8Array.from(bytes) });
      }, 12);
    }

    // Card bank 1 pretends to hold the Z1 Hip Hop card: factory data renamed.
    function programFor(cc, n) {
      if (cc === 0 && synth.user[n]) return Promise.resolve(synth.user[n]);
      if (BANK_BY_CC[cc]) return window.QSLIB.load(BANK_BY_CC[cc]).then(function (b) { return b.programs[n].slice(); });
      return window.QSLIB.load('factory-p1').then(function (b) {
        var d = b.programs[n].slice();
        var card = (window.QSLIB_INDEX.cards || [])[0];
        QS.setProgramName(d, card && cc === 5 ? card.names[n] : 'Card ' + cc + '-' + n);
        return d;
      });
    }

    function effectFor(cc, n) {
      if (cc === 0 && synth.userFx[n]) return Promise.resolve(synth.userFx[n]);
      return window.QSLIB.load(BANK_BY_CC[cc] || 'factory-p1').then(function (b) {
        return b.effects[n] ? b.effects[n].slice() : new Uint8Array(QS.SIZE.effect);
      });
    }

    // The edit buffers, loaded from the current program the first time they're needed.
    function editProgram() {
      if (synth.edit) return Promise.resolve(synth.edit);
      return programFor(synth.bank, synth.program).then(function (d) { return (synth.edit = d); });
    }

    function editEffect() {
      if (synth.editFx) return Promise.resolve(synth.editFx);
      return effectFor(synth.bank, synth.program).then(function (d) { return (synth.editFx = d); });
    }

    output.send = function (bytes) {
      bytes = Uint8Array.from(bytes);
      if (dropSysex && bytes[0] === 0xF0) return;
      queue = queue.then(function () { return handle(bytes); }).catch(function (err) {
        console.error('Demo QS:', err);
      });
    };

    function handle(bytes) {
      var status = bytes[0] & 0xF0;
      if (ignoreProgramChanges && (status === 0xC0 || (status === 0xB0 && bytes[1] === 0))) return;
      if (status === 0xB0 && bytes[1] === 0) { synth.bank = bytes[2]; return; }
      if (status === 0xC0) {
        synth.program = bytes[1];
        synth.edit = null;
        synth.editFx = null;
        return;
      }
      if (bytes[0] !== 0xF0) return;
      if (bytes[1] === 0x7E && bytes[3] === 0x06 && bytes[4] === 0x01) {
        reply([0xF0, 0x7E, 0x00, 0x06, 0x02, 0x00, 0x00, 0x0E, 0x0E, 0x00, 0x05, 0x00, 0x30, 0x32, 0x30, 0x30, 0xF7]);
        return;
      }
      var msg = QS.parseMessage(bytes);
      if (!msg || msg.kind !== 'qs') return;
      switch (msg.op) {
        case QS.OP.USER_PROGRAM_REQ:
          return programFor(0, msg.num).then(function (d) { reply(QS.build.userProgramDump(msg.num, d)); });
        case QS.OP.USER_EFFECT_REQ:
          return effectFor(0, msg.num).then(function (d) { reply(QS.build.userEffectDump(msg.num, d)); });
        case QS.OP.EDIT_PROGRAM_REQ:
          return editProgram().then(function (d) { reply(QS.build.editProgramDump(0, d)); });
        case QS.OP.EDIT_EFFECT_REQ:
          return editEffect().then(function (d) { reply(QS.build.editEffectDump(0, d)); });
        case QS.OP.EDIT_PROGRAM:
          synth.edit = msg.data.slice(0, QS.SIZE.program);
          return;
        case QS.OP.EDIT_EFFECT:
          synth.editFx = msg.data.slice(0, QS.SIZE.effect);
          return;
        case QS.OP.USER_PROGRAM:
          synth.user[msg.num] = msg.data.slice(0, QS.SIZE.program);
          return;
        case QS.OP.USER_EFFECT:
          synth.userFx[msg.num] = msg.data.slice(0, QS.SIZE.effect);
          return;
        case QS.OP.PARAM_EDIT: {
          // Mode 2 edits the program buffer, mode 3 the effect; anything the
          // spec doesn't map (or global and mix edits) is ignored, as on the QS.
          var e = QS.parseParamEdit(bytes);
          if (!e) return;
          if (e.mode === 2) return editProgram().then(function (d) { QS.applyParamEdit('program', d, bytes); });
          if (e.mode === 3) return editEffect().then(function (d) { QS.applyParamEdit('effect', d, bytes); });
          return;
        }
      }
    }

    // Pretend someone picked a program on the QS front panel (for trying "follow").
    window.QSDemo.frontPanel = function (bank, program, channel) {
      var ch = (channel || 1) - 1;
      synth.bank = bank;
      synth.program = program;
      synth.edit = null;
      synth.editFx = null;
      reply([0xB0 | ch, 0x00, bank]);
      reply([0xC0 | ch, program]);
    };

    return Promise.resolve({
      inputs: new Map([[input.id, input]]),
      outputs: new Map([[output.id, output]]),
      onstatechange: null
    });
  }

  window.QSDemo = { createAccess: createAccess };
})();

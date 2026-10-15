/*
 * library.js — lazy loader for the generated bank files in library/banks/.
 * Each bank file calls QSLIB.addBank(...). Plain <script> injection keeps
 * this working from file:// as well as from a web server.
 */
(function () {
  'use strict';

  var PROGRAM_SIZE = 350;
  var EFFECT_SIZE = 65;

  var banks = {};
  var waiting = {};

  function fromBase64(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function addBank(id, programs64, effects64, hasFx) {
    var p = fromBase64(programs64);
    var e = fromBase64(effects64);
    var bank = { id: id, programs: [], effects: [] };
    for (var n = 0; n < 128; n++) {
      bank.programs.push(p.subarray(n * PROGRAM_SIZE, (n + 1) * PROGRAM_SIZE));
      bank.effects.push(hasFx[n] ? e.subarray(n * EFFECT_SIZE, (n + 1) * EFFECT_SIZE) : null);
    }
    banks[id] = bank;
    (waiting[id] || []).forEach(function (w) { w.resolve(bank); });
    delete waiting[id];
  }

  function load(id) {
    if (banks[id]) return Promise.resolve(banks[id]);
    return new Promise(function (resolve, reject) {
      if (waiting[id]) { waiting[id].push({ resolve: resolve, reject: reject }); return; }
      waiting[id] = [{ resolve: resolve, reject: reject }];
      var s = document.createElement('script');
      s.src = 'library/banks/' + encodeURIComponent(id) + '.js';
      s.async = true;
      s.onerror = function () {
        (waiting[id] || []).forEach(function (w) { w.reject(new Error('Could not load bank ' + id)); });
        delete waiting[id];
        s.remove();
      };
      document.head.appendChild(s);
    });
  }

  window.QSLIB = { addBank: addBank, load: load, fromBase64: fromBase64 };
})();

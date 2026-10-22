/*
 * midi.js — thin Web MIDI wrapper: port selection, logging, and
 * request/response helpers for QS SysEx dumps.
 */
(function () {
  'use strict';

  var LOG_LIMIT = 60;

  function QSMidi() {
    this.access = null;
    this.sysex = false;
    this.out = null;
    this.in = null;
    this.handlers = [];
    this.portHandlers = [];
    this.waiters = [];
    this.log = [];
    this.logHandlers = [];
    this._onMidi = this._onMidi.bind(this);
  }

  /*
   * Ask for MIDI access. Tries with SysEx first (needed for auditioning
   * library patches and reading names), then falls back to plain MIDI so
   * bank/program changes still work if the user declines SysEx.
   */
  QSMidi.prototype.init = async function (accessFactory) {
    var self = this;
    if (accessFactory) {
      this.access = await accessFactory();
      this.sysex = true;
    } else {
      if (!navigator.requestMIDIAccess) {
        var e = new Error('This browser has no Web MIDI. Use Chrome or Edge.');
        e.code = 'unsupported';
        throw e;
      }
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: true });
        this.sysex = true;
      } catch (err) {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        this.sysex = false;
      }
    }
    this.access.onstatechange = function () {
      // Re-attach if our selected input came back after a replug.
      if (self.in && self.in.state === 'disconnected') self.in = null;
      self.portHandlers.forEach(function (fn) { fn(); });
    };
    return this;
  };

  QSMidi.prototype.outputs = function () {
    return this.access ? Array.from(this.access.outputs.values()) : [];
  };

  QSMidi.prototype.inputs = function () {
    return this.access ? Array.from(this.access.inputs.values()) : [];
  };

  QSMidi.prototype.setOutput = function (id) {
    this.out = id ? (this.access.outputs.get(id) || null) : null;
    return this.out;
  };

  QSMidi.prototype.setInput = function (id) {
    if (this.in) this.in.onmidimessage = null;
    this.in = id ? (this.access.inputs.get(id) || null) : null;
    if (this.in) this.in.onmidimessage = this._onMidi;
    return this.in;
  };

  QSMidi.prototype.send = function (bytes) {
    if (!this.out) return false;
    if (bytes[0] === 0xF0 && !this.sysex) return false;
    try {
      this.out.send(bytes);
    } catch (err) {
      return false; // port unplugged or closed by another app
    }
    this._log('out', bytes);
    return true;
  };

  QSMidi.prototype.onMessage = function (fn) { this.handlers.push(fn); };
  QSMidi.prototype.onPortsChanged = function (fn) { this.portHandlers.push(fn); };
  QSMidi.prototype.onLog = function (fn) { this.logHandlers.push(fn); };

  /*
   * Send a message and wait for a matching reply.
   * match(bytes, parsed) returns true for the reply we want.
   */
  QSMidi.prototype.request = function (bytes, match, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self.in) { reject(new Error('No MIDI input selected')); return; }
      var waiter = { match: match, resolve: resolve };
      waiter.timer = setTimeout(function () {
        self.waiters = self.waiters.filter(function (w) { return w !== waiter; });
        var e = new Error('No reply from the QS');
        e.code = 'timeout';
        reject(e);
      }, timeoutMs || 1500);
      self.waiters.push(waiter);
      if (!self.send(bytes)) {
        clearTimeout(waiter.timer);
        self.waiters = self.waiters.filter(function (w) { return w !== waiter; });
        reject(new Error(self.sysex ? 'No MIDI output selected' : 'SysEx permission was not granted'));
      }
    });
  };

  QSMidi.prototype._onMidi = function (ev) {
    var bytes = ev.data;
    if (bytes[0] === 0xFE || bytes[0] === 0xF8) return; // active sensing, clock
    this._log('in', bytes);
    var parsed = bytes[0] === 0xF0 ? window.QS.parseMessage(bytes) : null;
    for (var i = 0; i < this.waiters.length; i++) {
      var w = this.waiters[i];
      if (w.match(bytes, parsed)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(parsed || bytes);
        return;
      }
    }
    this.handlers.forEach(function (fn) { fn(bytes, parsed); });
  };

  QSMidi.prototype._log = function (dir, bytes) {
    var entry = { dir: dir, bytes: bytes, time: new Date() };
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.logHandlers.forEach(function (fn) { fn(entry); });
  };

  window.QSMidi = QSMidi;
})();

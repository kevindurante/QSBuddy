/*
 * qs-params.js — program parameter map (read side).
 *
 * Addresses, limits and offsets are copied verbatim from the PROGRAM DATA
 * FORMAT tables in synthzoneftp-dump/QS8/Alesis-QS678R.txt so they can be
 * checked line-by-line against the spec. func/page/pot are the opcode 10H
 * coordinates a future editor needs to send live edits.
 *
 * Only the parameters the browser's inspector shows are listed for now;
 * extend these tables to grow the editor.
 */
(function (QS) {
  'use strict';

  // name, address, offset (add to raw value for display), limit (raw max), func, page, pot
  function P(name, addr, offset, limit, func, page, pot) {
    return { name: name, addr: addr, offset: offset, limit: limit, func: func, page: page, pot: pot };
  }

  var KEYBOARD_SOUND = {
    mode:        P('Keyboard / drum mode', '0:0', 0, 1, 16, 0, 0),
    sampleGroup: P('Sample group', '0:6-0:1', 0, 47, 0, 0, 0),
    sampleNum:   P('Sample number', '1:5-0:7', 0, 127, 0, 0, 2),
    volume:      P('Sound volume', '2:4-1:6', 0, 99, 1, 0, 0),
    pan:         P('Sound pan', '2:7-2:5', 0, 6, 1, 0, 1),
    output:      P('Sound output', '3:1-3:0', 0, 2, 1, 0, 2),
    fxLevel:     P('Sound effect level', '4:0-3:2', 0, 99, 2, 0, 0),
    fxBus:       P('Sound effect bus', '4:2-4:1', 0, 3, 2, 0, 1),
    semitone:    P('Sound pitch semitone', '5:0-4:3', -24, 49, 3, 0, 0),
    detune:      P('Sound pitch detune', '6:0-5:1', -99, 199, 3, 0, 2),
    filterFreq:  P('Sound filter frequency', '11:7-11:1', 0, 99, 4, 0, 0),
    lowNote:     P('Sound low note limit', '20:3-19:5', 0, 127, 6, 0, 0),
    highNote:    P('Sound high note limit', '21:2-20:4', 0, 127, 6, 0, 1),
    ampAttack:   P('Sound amp env attack', '68:2-67:4', 0, 99, 14, 0, 0),
    ampDecay:    P('Sound amp env decay', '69:1-68:3', 0, 99, 14, 0, 1),
    ampSustain:  P('Sound amp env sustain', '70:0-69:2', 0, 99, 14, 0, 2),
    ampRelease:  P('Sound amp env release', '70:7-70:1', 0, 99, 14, 0, 3),
    enable:      P('Sound enable', '84:3', 0, 1, 16, 0, 3)
  };

  var DRUM_SOUND = {
    mode:   P('Keyboard / drum mode', '0:0', 0, 1, 9, 0, 0),
    enable: P('Sound enable', '81:0', 0, 1, 9, 0, 3)
  };

  // Drum n (0-9) parameters repeat every 8 bytes starting at 1:0.
  var DRUM = {
    sampleGroup: P('Drum sample group', '1:3-1:0', 0, 15, 0, 0, 0),
    sampleNum:   P('Drum sample number', '2:2-1:4', 0, 127, 0, 0, 2),
    volume:      P('Drum volume', '2:7-2:3', 0, 31, 1, 0, 0),
    note:        P('Drum note number', '7:3-6:5', 0, 127, 6, 0, 0)
  };

  var EFFECT_CONFIGS = [
    '4 sends, 1 reverb',
    '4 sends, 2 reverb',
    '4 sends, 1 Leslie',
    '2 sends with EQ',
    'Overdrive, chorus, delay, reverb, Leslie'
  ];

  function read(data, param, base) {
    return QS.getBits(data, param.addr, base) + param.offset;
  }

  function decodeSound(data, index) {
    var base = QS.SOUND_OFFSETS[index];
    var isDrum = QS.getBits(data, '0:0', base) === 1;
    if (isDrum) {
      var drums = [];
      for (var d = 0; d < 10; d++) {
        var db = base + d * 8; // each drum is 8 bytes (64 bits) further on
        drums.push({
          sampleGroup: read(data, DRUM.sampleGroup, db),
          sampleNum: read(data, DRUM.sampleNum, db),
          volume: read(data, DRUM.volume, db),
          note: read(data, DRUM.note, db)
        });
      }
      return { index: index, type: 'drum', enabled: read(data, DRUM_SOUND.enable, base) === 1, drums: drums };
    }
    var s = { index: index, type: 'keyboard' };
    Object.keys(KEYBOARD_SOUND).forEach(function (k) { s[k] = read(data, KEYBOARD_SOUND[k], base); });
    s.enabled = s.enable === 1;
    return s;
  }

  function decodeProgram(data) {
    return {
      name: QS.programName(data),
      romId: QS.romId(data),
      sounds: [0, 1, 2, 3].map(function (i) { return decodeSound(data, i); })
    };
  }

  function decodeEffect(data) {
    var config = QS.getBits(data, '9:1-8:6');
    return { config: config, configName: EFFECT_CONFIGS[config] || ('Config ' + config) };
  }

  QS.params = {
    KEYBOARD_SOUND: KEYBOARD_SOUND,
    DRUM_SOUND: DRUM_SOUND,
    DRUM: DRUM,
    EFFECT_CONFIGS: EFFECT_CONFIGS
  };
  QS.decodeProgram = decodeProgram;
  QS.decodeEffect = decodeEffect;
})(typeof module !== 'undefined' && module.exports
  ? (module.exports = require('./qs-sysex.js'))
  : (window.QS = window.QS || {}));

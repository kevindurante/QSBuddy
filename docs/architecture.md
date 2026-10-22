# Architecture

QSBuddy is a static web app in `app/`: plain HTML, CSS and classic `<script>` files, no build step and no dependencies. It opens straight from disk (`file://`) or from any static server, and talks to the synth with Web MIDI.

## Why a web app

- **SysEx is the whole game on the QS.** Auditioning, reading names, editing and librarian work all need SysEx out *and* in. VST3 plugins can't send SysEx in most hosts, and MIDI output from plugins is patchy (Ableton Live has none for VST3), so a plugin could at best send program changes.
- **Web MIDI does SysEx both ways** in Chrome and Edge, with no install, drivers or build step. The same files can be hosted on GitHub Pages.
- **HTML/CSS suits an editor**: pages of knobs, envelopes and a mod matrix are easier here than in a native GUI toolkit, and there's nothing to install on each machine.
- To use it alongside a DAW, give it its own MIDI port or route through a virtual MIDI cable such as loopMIDI.

## Layout

| Path | What it is |
| --- | --- |
| `app/index.html` | The page: top bar, sidebar, grid, inspector and dialogs. |
| `app/js/qs-sysex.js` | SysEx codec from the spec: 7-in-8 packing, bit fields in spec notation (`"2:5-1:7"`), names, bank parsing, message builders (including opcode `10H` live parameter edits, `QS.build.paramEdit`). Pure functions, no DOM, so it also runs in Node. |
| `app/js/qs-paramdefs.js` | Every parameter in the spec as data on `QS.PARAMDEFS`: Global, New Mix, Program, Keyboard and Drum sounds, Effects with all five configurations. **Generated** by `tools/gen_params.py`; don't edit by hand. See [Parameter model](#parameter-model). |
| `app/js/qs-params.js` | Decodes and encodes whole dumps field by field with those definitions (`QS.decodeParams` / `QS.encodeParams`), value conversion, display formatting and `10H` messages for a field. Also the inspector's `decodeProgram` / `decodeEffect`. |
| `app/js/midi.js` | Web MIDI wrapper: ports, logging, `request()` with reply matching and timeouts. |
| `app/js/library.js` | Lazy loader for generated bank files (`<script>` injection, so it works on `file://`). |
| `app/js/app.js` | The UI: bank model, sending, search, inspector, scans, store, connection test. |
| `app/js/demo-qs.js` | Pretend QS7 for `?demo`, with `&progsel=off` and `&sysex=off` failure modes. |
| `app/library/` | Generated from `archive/` by `tools/build_library.py`. Committed so the app works after a clone. |
| `tools/build_library.py` | Builds `app/library/` (bank data plus Q-Card program names). Python standard library only. |
| `tools/gen_params.py` | Builds `app/js/qs-paramdefs.js` from the spec text, with the spec's errata as explicit overrides. `--check` fails if the checked-in file is stale (the tests run it). Python standard library only. |
| `tools/serve.py` | Serves `app/` on `http://localhost:8765` for browsers that won't give MIDI to `file://` pages. |
| `tests/` | Node tests (`node:test`, no dependencies) that run the codec and the parameter model against the real bank files. |
| `docs/spec/QS678R-sysex-spec.txt` | QS6/7/8/R MIDI SysEx Specification (Alesis, Feb 1997). The source of truth for every address and opcode. |
| `archive/` | The original QS archive this repo was forked from. Read-only source material. |

`app/js/*.js` are classic scripts that hang everything off `window.QS` (or `module.exports` in Node). ES modules would break `file://` loading in Chrome, so don't switch without adding a build step or dropping `file://` support on purpose.

## How patches get to the QS

| Source | Messages | Notes |
| --- | --- | --- |
| Synth bank (User, Presets, GenMIDI, cards) | Bank Select CC 0 = bank, then Program Change | Channel messages only, so they also work through chains that drop SysEx. An early version sent Mode Select (`0D`) first; it was removed while fixing patch changes on a real QS7 (where the channel setting also turned out to matter), so it's unproven either way. Re-test on hardware before adding SysEx here. |
| Library or opened file | Edit program dump `02` #0, then edit effect dump `08` #0 | The effect buffer is independent of the program buffer, so both are sent. Debounced 140 ms while arrow-keying. |
| Store to User | User program dump `00` #n, user effect dump `06` #n | Overwrites the slot. Confirm first. |
| Read names | User bank: request `01` #n per slot. Other banks: bank/program change, then request `03` #0 | ~20–25 s per bank; each step waits for its reply. |
| Connection test | Device inquiry, `03` read-back after a program change and after a `02` dump | Tells "QS setting" apart from "SysEx not arriving". |

Bank Select values (QS7 Reference Manual): 0 User, 1–3 Preset 1–3, 4 GenMIDI, 5–15 card banks numbered in the order the QS finds them.

## Data formats worth knowing

- **Packing:** 7 data bytes travel as 8 MIDI bytes, as one little-endian bit stream cut into 7-bit words. A trailing group of r bytes travels as r + 1 bytes. Program = 350 bytes (400 on the wire), effect = 65 (75), new mix = 138 (158), global = 20 (23).
- **Bit addresses:** the spec writes fields MSB first as `hiByte:hiBit-loByte:loBit`; the absolute bit is `byte * 8 + bit`. `QS.getBits` / `QS.setBits` take those strings as written, plus an optional byte base (sound offsets 10, 95, 180, 265).
- **Signed values** are stored offset-binary; add the spec's Offset column for display. Opcode `10H` wants 8-bit two's complement instead.
- **Names** are 10 × 7-bit indexes into ASCII from space (index 95 shows as →).
- **ROM identifier** (program `9:7-9:6`): 0 means QuadraSynth / S4 Plus; the QS remaps those on receipt. Factory QS banks read 2, which doesn't match the spec's "1 = QS".
- **Effect pairing:** in an All Dump, user effect *n* belongs to user program *n*. QE 1.1 `.PAT` files instead follow each program with its effect under another number; `parseBank` pairs those by order.
- **Q-Card images:** Z-series cards start with `A5 C3 5A A5` and store program bytes 1–349 at a 349-byte stride from offset 4. R-series QuadraCards start with `5A A5 A5 C3` and store full 350-byte programs from offset 4.

## Parameter model

`tools/gen_params.py` reads the tab-separated tables in `docs/spec/QS678R-sysex-spec.txt` and writes `app/js/qs-paramdefs.js`. Regenerate with `npm run build:params` after changing the generator; `npm test` fails if the checked-in file is stale.

### Tables

`QS.PARAMDEFS` has one entry per dump layout. Addresses are the spec's own strings; where a table repeats, the definitions are the spec's first instance and the layout gives the step.

| Table | Contents | Base to add when reading |
| --- | --- | --- |
| `global` | 20 parameters, one per byte (`10H` mode 0) | none |
| `newMix` | 13 common parameters, then `channel`: 20 parameters for channel 1, `count: 16`, `stride: 8` (mode 1) | `channel × 8` |
| `program` | 13 common parameters (name, ROM identifier), `soundOffsets: [10, 95, 180, 265]` (mode 2) | none |
| `keyboardSound` | Parameters 0–121 of a keyboard sound | the sound's offset |
| `drumSound` | Mode, enable, drum number and spares, then `drum`: the 16 drum-1 parameters, `count: 10`, `stride: 8` | sound offset `+ drum × 8` |
| `effect` | 11 common parameters (`effectConfiguration` at `9:1-8:6`), then `configs[0..4]` (mode 3) | none |

Each definition has `id`, `num` (the spec's `#`), `name`, `addr`, `bits`, `offset`, `limit`, `func`, `page`, `pot`, effects also `send` (null where the spec writes `x`), `display`, and `line`, the spec line it came from. Optional keys: `options` for enumerations, `when` for conditional effect parameters, `twos`/`min`/`max` for two's complement fields, `drumFunc`, `funcs`, `models`, `ignoredInDump`, `spare`, `group` (the effect table's heading), `note`, and `spec` (the original values an erratum replaced).

- **Values.** Most signed fields are offset binary: value = raw + `offset`, raw runs 0…`limit`. Global signed fields and the Lezlie horn are two's complement (`twos: true`, range `min`…`max`). `QS.paramValue` / `QS.paramRaw` convert; opcode `10H` takes the value.
- **Display.** `number`, `signed`, `note` (note number, `QS.noteName`), `onoff`, `char` (name digit) or `enum` with `options`. Options exist only where the spec names the values: sound mode, ROM identifier, effect configuration, and the pitch and delay types (from the effects' "If 11 = …" conditions). Sample, mod source/destination, LFO waveform and reverb names aren't in the spec; they wait for the Reference Manual.
- **Conditional effect parameters.** Configurations 0, 3 and 4 change some parameters with the pitch or delay type. Those definitions carry `when: { id: 'send1PitchType', in: [4] }`; only the ones whose condition matches are active. Configurations 2 and 3 copy ranges of configuration 0 ("identical to configuration 0"); `copies` lists them and the copied entries keep configuration 0's line numbers.
- **Opcode 10H.** Program fields go to the sound they belong to; name digits use `drumFunc` (7) instead of 8 when the sound is a drum. Drum parameters edit the drum chosen with `drumNumber` (func 0–6 or 8, page 0, pot 3), so select the drum first. Effects send `send` as the sound bits. `QS.paramEditFor(kind, field, value, {channel, drum})` builds the message.

### Decoding and encoding

`QS.decodeParams(kind, data)` (kind `program`, `effect`, `newMix` or `global`) returns `{ fields, values }`. Each field has a `key` unique within the dump (`programNameDigit0`, `s2.pan`, `s1.drum3.noteNumber`, `ch5.volume`, `send1PitchType`), its `def`, `base`, `table`, `sound` / `drum` / `channel`, `raw` and `value`. The layout follows the data: each sound's keyboard/drum bit, and the effect configuration and type fields. Bits that no definition covers become `unlisted@<addr>` fields, so `QS.encodeParams(kind, fields)` rebuilds the dump byte for byte from the fields alone. The tests check that for every unique program, effect, new mix and global dump in `archive/`.

Gaps the spec leaves: the unused high bits of each Global byte, effect byte 64 (the spec describes 64 bytes; dumps carry 65), and in configuration 4 several stretches between 32:0 and 58:5 that hold leftovers from other configurations.

### Spec errata

`ERRATA` in `tools/gen_params.py` lists every correction with the spec line, the text it expects there and the reason; the generated entry keeps the old values in `spec`. Anything else that doesn't add up (column count, bit width against the address, limit against the width, duplicate numbers, overlapping fields, repeated-block numbering and addresses) stops the generator.

| Spec line | Problem | Fix |
| --- | --- | --- |
| 732 | Keyboard sound #121 columns shifted; "(cannot edit)" under Page | No func/page/pot |
| 765 | Drum sound #163 says 6 bits for `81:7-81:1` | 7 bits |
| 483 | Channel 16 numbered "240-332" | 313–332 |
| 842, 1164 | Stereo "right delay 1ms" at `16:8-16:5` (no bit 8) | `17:0-16:5`, as the mono spare row |
| 882 | Send 2 pitch detune has Send 0 | Send 1 |
| 995, 1019, 1012–1014 | Configuration 1: two rows named "Reverb type"; send 3's pitch rows named "Send 2" | Named by send |
| 1059 | Configuration 2 Send 1 delay input: offset 0, limit 99 | −99 / 198, as configuration 0; dumps use up to 198 |
| 1196–1199 | Overdrive rows numbered 50, 52, 63, 64, 65 (63 and 64 clash with the EQ) | Renumbered 50–54 |
| 789–798 | Send column "x" run into the name | Split |

Name typos ("inut", "treshold", "alfo", "Send3") are fixed through `NAME_FIXES`.

**Unresolved, needs the hardware:** in configuration 4, Send 1 overdrive mix has the same address as Send 1 lezlie mix (`31:7-31:1`) and the same func/page/pot as overdrive type and low EQ frequency (6/0/0); overdrive threshold shares 6/0/2 with high EQ frequency. The archive can't settle it. To check on a QS: pick configuration 4, change overdrive mix, request the edit effect buffer (`09`) and see which bits moved.

### Limits seen in real dumps

The limits test lists every live field (in an enabled sound or channel) above its spec limit. `KNOWN_OUTLIERS` in `tests/qs-params.test.js` explains each; a new one fails the test. The ones that look like spec mistakes, because Alesis banks use the same out-of-range value many times:

- Keyboard sound key mode is 3 in 570+ sounds (limit 2).
- Pitch envelope release is 100 in 230+ sounds (limit 99).
- LFO waveforms are 7 in about 220 sounds (limit 6).
- Amp velocity curve is 13–15 in 110+ sounds (limit 12).
- Tracking input is 30 or 24 in 210+ sounds (limit 22); tracking points 3–7 repeat the same values above 100.
- New Mix channel program type is 0–15 in 1,000+ enabled channels (limit 1). It's 4 bits, and values 0–4 match the Bank Select numbers, so it looks like the bank.

Disabled sounds and mix channels often hold leftover values out of range; the test counts those separately and ignores them.

## Hardware lessons so far

- A plain notes-only path proves nothing about SysEx. Many sequencers, grooveboxes and cheap USB-MIDI cables pass channel messages but drop or mangle SysEx. The connection test exists for this.
- Windows lets one app open a MIDI port at a time unless Windows MIDI Services is installed.
- Opcode `10H` puts the QS into Edit mode and is ignored while it's in Compare. Expect the editor to need its own handling of that.

## Conventions

- Every parameter address, limit and opcode comes from `docs/spec/QS678R-sysex-spec.txt`. Copy the spec's notation verbatim so lines can be checked against it. Parameter definitions come from `tools/gen_params.py`; correct the spec there through `ERRATA`, never by editing the generated file.
- Codec changes need a test against real bank files in `archive/` (round-trips must stay byte-identical).
- Keep `app/` working from `file://` and without a build step.
- Don't write anything to the synth's memory without a confirm step that shows what will be overwritten.

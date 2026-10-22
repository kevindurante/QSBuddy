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
| `app/js/qs-params.js` | Parameter tables copied from the spec, with offsets, limits and the func/page/pot coordinates opcode `10H` needs. Currently a program subset; this grows into the full map. |
| `app/js/midi.js` | Web MIDI wrapper: ports, logging, `request()` with reply matching and timeouts. |
| `app/js/library.js` | Lazy loader for generated bank files (`<script>` injection, so it works on `file://`). |
| `app/js/app.js` | The UI: bank model, sending, search, inspector, scans, store, connection test. |
| `app/js/demo-qs.js` | Pretend QS7 for `?demo`, with `&progsel=off` and `&sysex=off` failure modes. |
| `app/library/` | Generated from `archive/` by `tools/build_library.py`. Committed so the app works after a clone. |
| `tools/build_library.py` | Builds `app/library/` (bank data plus Q-Card program names). Python standard library only. |
| `tools/serve.py` | Serves `app/` on `http://localhost:8765` for browsers that won't give MIDI to `file://` pages. |
| `tests/` | Node tests (`node:test`, no dependencies) that run the codec against the real bank files. |
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

## Hardware lessons so far

- A plain notes-only path proves nothing about SysEx. Many sequencers, grooveboxes and cheap USB-MIDI cables pass channel messages but drop or mangle SysEx. The connection test exists for this.
- Windows lets one app open a MIDI port at a time unless Windows MIDI Services is installed.
- Opcode `10H` puts the QS into Edit mode and is ignored while it's in Compare. Expect the editor to need its own handling of that.

## Conventions

- Every parameter address, limit and opcode comes from `docs/spec/QS678R-sysex-spec.txt`. Copy the spec's notation verbatim so lines can be checked against it.
- Codec changes need a test against real bank files in `archive/` (round-trips must stay byte-identical).
- Keep `app/` working from `file://` and without a build step.
- Don't write anything to the synth's memory without a confirm step that shows what will be overwritten.

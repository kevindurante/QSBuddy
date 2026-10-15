# QSBuddy Patch Browser

A patch browser and program changer for the Alesis QS6 / QS7 / QS8 / QSR, built from the archive in this repo. It runs in Chrome or Edge with nothing to install and talks to the synth over Web MIDI.

- **Browse the QS itself.** User, Preset 1–3, GenMIDI and both card banks, with real names. Click a program (or move with the arrow keys) and the QS switches to it.
- **Audition the whole archive.** 68 banks / 8,600+ programs from this repo (Factory, Expando, Q-Card extra banks, category banks, QEssence, Koltsov, Sam's…). A click loads the program and its effect into the QS **edit buffer**, so your User bank isn't touched.
- **Search everything at once**, keep favorites, open or drop any `.syx` file, store a program into a User slot, and save single programs as `.syx`.
- **Read names from the QS** to see what's really in your User bank or an inserted card. Card names for Z1–Z9, R1, R2 and R8 come from the card images in this repo.
- **See what's inside a program**: the four sounds (keys or drums, sample, key range, level, pan, tuning, filter, amp envelope, FX send) and the effect configuration.

## Quick start

1. Connect your MIDI interface **Out → QS MIDI In**. For reading names, also connect **QS MIDI Out → interface In**.
2. On the QS, press **PROGRAM**, then **GLOBAL**, go to the MIDI page and set **MIDI Program Select** (PrgSl) to **On**, and **General MIDI** to **Off**. With Program Select off the QS ignores program changes; in General MIDI mode it ignores bank changes.
3. Open `patch-browser/index.html` in **Chrome or Edge** and allow MIDI (including SysEx) when asked.
   If the browser doesn't ask, or blocks MIDI for files opened from disk, run the local server instead:
   ```bash
   python patch-browser/tools/serve.py
   ```
4. Pick the **Out**, **In** and **Ch** (the QS Program mode channel, normally 1). The status pill turns green and shows the model and OS version once the QS answers.

Close your DAW (or any app holding the MIDI ports) first. On Windows only one program can use a MIDI port at a time.

No synth handy? Open `index.html?demo` (or `http://localhost:8765/?demo`) to drive a pretend QS7. Add `&progsel=off` to make it ignore program changes, the way a QS does with Program Select off.

### Patches not changing?

Open **Settings (⚙) → Test the connection**. With the QS MIDI Out connected, it checks each link in turn and reads back what the QS actually did:

- **No answer from the QS:** the cable from the QS MIDI Out, or the In port picked here.
- **The QS ignored the program change:** the QS isn't in Program mode, MIDI Program Select is off or set to another channel, or General MIDI is on. Fix it on the QS (step 2 above), or set **Ch** here to match.
- **No answer to a SysEx query, or the QS didn't take a SysEx dump:** something on the way to the QS is dropping SysEx. Program changes still work, but auditions, reading names and Store to User need SysEx to arrive intact.

#### Going through a sequencer or MIDI chain

Bank Select and Program Change are ordinary channel messages, so they get through almost any chain. SysEx only gets through boxes that pass it untouched:

- Plain hardware thru splitters pass it.
- Sequencers and grooveboxes (for example an Elektron Digitone in front of the QS) often forward only channel messages, or only on their THRU jack. Check the box's MIDI port settings.
- If the chain won't pass SysEx, either plug the interface straight into the QS MIDI In while you audition or store patches, or add a MIDI merger that passes SysEx in front of the QS: one input from the chain, one direct from a spare interface output. Then pick that direct output here.

If the **Test** button plays notes but patches don't change and you have no MIDI In, the QS setting in step 2 is the usual cause.

## Using it

| Key | Does |
| --- | --- |
| ← → ↑ ↓ | Move through the grid and send each patch (turn this off in Settings) |
| Enter / Space | Send the selected patch again |
| Page Up / Page Down | Previous / next bank |
| / | Search every bank. ↑ ↓ move through results, Esc goes back |
| F | Add or remove a favorite |
| T (hold) | Play middle C on the selected channel |

**Banks on the QS** send Bank Select (CC 0) plus Program Change. Bank numbers come from the QS7 Reference Manual: 0 User, 1–3 Preset 1–3, 4 GenMIDI, 5–15 card banks.

- **User** shows the factory default names until you click **Read names from QS** (it requests each User program, which takes about 20 s and changes nothing).
- **Card bank 1 / 2**: pick which Q-Card is inserted to see its names, or read them from the QS. Card banks are numbered in the order the QS finds them, so with two single-bank Q-Cards, bank select 5 is the first and 6 the second. Reading names steps through the bank on the QS, then re-sends the patch you last picked in the browser.
- With **Follow** on (Settings), picking a program on the QS front panel moves the browser there too.

**Library and opened files** go to the edit buffer with SysEx (program dump `02` plus effect dump `08`), the same way the old editors auditioned patches.

- Press **STORE** on the QS to keep one, or use **Store to User…**, which writes the program and its effect into a User slot you choose. That overwrites the slot and can't be undone, so the dialog shows what's there now.
- **Q-Card Extra Banks** play samples from their card, so insert the matching card first.
- **Koltsov** and the other QuadraSynth banks are QuadraSynth / S4 Plus programs. The QS remaps their samples on receipt, so some will sound different from the original.
- Opened files last until you reload the page. Favorites, card choices and names read from the QS are kept in the browser.

## Why a web page (and not a VST or a Python app)

- **SysEx is the whole game on the QS.** Auditioning patches, reading names and, later, live editing all need SysEx out *and* in. VST3 plugins can't send SysEx in most hosts, and MIDI output from plugins is patchy (Ableton Live has none for VST3), so a plugin could at best send program changes.
- **Web MIDI does SysEx both ways** in Chrome and Edge, with no install, drivers or build step. The page also works offline from this folder, and could be hosted on GitHub Pages later.
- **The UI is plain HTML/CSS**, which suits a browser now and an editor with sliders later. A Python version would need `mido`, `python-rtmidi` and a GUI toolkit on every machine.
- If you want it inside a DAW, run the browser next to it on its own MIDI port, or route through a virtual MIDI cable such as loopMIDI.

## Growing it into an editor

The pieces are already split so an editor can build on them:

| File | What it is |
| --- | --- |
| `js/qs-sysex.js` | The SysEx codec from the spec: 7-in-8 packing, bit fields in spec notation (`"2:5-1:7"`), names, bank parsing and message builders, including opcode `10H` live parameter edits (`QS.build.paramEdit`). No DOM, so it also runs in Node. |
| `js/qs-params.js` | Program parameter tables copied from the spec, with their func/page/pot edit coordinates. Add rows here to expose more parameters. |
| `js/midi.js` | Web MIDI ports, logging and request/reply with timeouts. |
| `js/app.js` | The browser UI. |
| `js/demo-qs.js` | The pretend QS7 used by `?demo`. |
| `tools/build_library.py` | Builds `library/` from the banks and card images in this repo. |
| `tests/qs-sysex.test.js` | Codec tests against the real bank files. |

The spec these follow is `synthzoneftp-dump/QS8/Alesis-QS678R.txt` (QS6/7/8/R MIDI SysEx Specification, 1997). A natural next step is a Mix browser: mix dumps (`0E`) and their names are already parsed.

## Rebuilding the library

`library/` is generated and committed, so the page works straight after a clone. To add a bank, add a line to `COLLECTIONS` in `tools/build_library.py`, then run:

```bash
python patch-browser/tools/build_library.py
```

```bash
node --test patch-browser/tests/qs-sysex.test.js
```

## Known limits

- Effect configurations are named from the spec's list. Program-level effect details (reverb type and so on) aren't shown yet.
- The QSR has no keyboard, so use the Test button or your controller.
- Firefox supports Web MIDI only with a site permission add-on and over HTTPS. Use Chrome or Edge.

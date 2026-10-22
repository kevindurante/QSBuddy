# QSBuddy user guide

QSBuddy runs in Chrome or Edge and talks to an Alesis QS6 / QS7 / QS8 / QSR over Web MIDI. Today it's a patch browser and librarian; the program, effects and mix editors are on the [roadmap](roadmap.md).

- **Browse the QS itself.** User, Preset 1–3, GenMIDI and both card banks, with real names. Click a program (or move with the arrow keys) and the QS switches to it.
- **Audition the whole archive.** 68 banks / 8,600+ programs from this repo (Factory, Expando, Q-Card extra banks, category banks, QEssence, Koltsov, Sam's…). A click loads the program and its effect into the QS **edit buffer**, so your User bank isn't touched.
- **Search everything at once**, keep favorites, open or drop any `.syx` file, store a program into a User slot, and save single programs as `.syx`.
- **Read names from the QS** to see what's really in your User bank or an inserted card. Card names for Z1–Z9, R1, R2 and R8 come from the card images in `archive/`.
- **See what's inside a program**: the four sounds (keys or drums, sample, key range, level, pan, tuning, filter, amp envelope, FX send) and the effect configuration.

## Quick start

1. Connect your MIDI interface **Out → QS MIDI In**. For reading names, also connect **QS MIDI Out → interface In**.
2. On the QS, press **PROGRAM**, then **GLOBAL**, go to the MIDI page and set **MIDI Program Select** (PrgSl) to **On**, and **General MIDI** to **Off**. With Program Select off the QS ignores program changes; in General MIDI mode it ignores bank changes.
3. Open `app/index.html` in **Chrome or Edge** and allow MIDI (including SysEx) when asked.
   If the browser doesn't ask, or blocks MIDI for files opened from disk, run the local server instead:
   ```bash
   python tools/serve.py
   ```
4. Pick the **Out**, **In** and **Ch** (the QS Program mode channel, normally 1). The status pill turns green and shows the model and OS version once the QS answers.

Close your DAW (or any app holding the MIDI ports) first. On Windows only one program can use a MIDI port at a time.

No synth handy? Open `app/index.html?demo` (or `http://localhost:8765/?demo`) to drive a pretend QS7. Add `&progsel=off` to make it ignore program changes the way a QS does with Program Select off, or `&sysex=off` to make it act like a MIDI chain that drops SysEx.

## Patches not changing?

Open **Settings (⚙) → Test the connection**. With the QS MIDI Out connected, it checks each link in turn and reads back what the QS actually did:

- **No answer to a SysEx query:** either the cable from the QS MIDI Out (or the In port picked here), or something on the way to the QS is dropping SysEx.
- **The QS ignored the program change:** the QS isn't in Program mode, MIDI Program Select is off or set to another channel, or General MIDI is on. Fix it on the QS (step 2 above), or set **Ch** here to match.
- **The QS didn't take a SysEx dump:** something on the way to the QS is dropping or cutting long SysEx messages. Program changes still work, but auditions, reading names and Store to User need SysEx to arrive intact.

If the **Test** button plays notes but patches don't change and you have no MIDI In, the QS setting in step 2 is the usual cause.

### Going through a sequencer or MIDI chain

Bank Select and Program Change are ordinary channel messages, so they get through almost any chain. SysEx only gets through boxes that pass it untouched:

- Plain hardware thru splitters and mergers (MIDI Solutions Thru and Merger, for example) pass it.
- Sequencers and grooveboxes often send only their own data. An Elektron Digitone's OUT jack carries only the Digitone's own MIDI, so computer MIDI doesn't get through it to synths chained after it.
- Synths with USB, like a Korg minilogue or Moog Grandmother, don't work as USB-to-DIN interfaces for other gear.
- The dependable setup is a MIDI port of its own for the QS: a spare interface port, a known-brand USB-MIDI cable, or a MIDI merger that passes SysEx in front of the QS (one input from the chain, one direct from the computer).

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
- To recall patches from a hardware sequencer, use the bank number from the sidebar and the program number on each cell. Elektron boxes count programs from 1, so add 1 there.

**Library and opened files** go to the edit buffer with SysEx (program dump `02` plus effect dump `08`), the same way the old editors auditioned patches.

- Press **STORE** on the QS to keep one, or use **Store to User…**, which writes the program and its effect into a User slot you choose. That overwrites the slot and can't be undone, so the dialog shows what's there now.
- **Q-Card Extra Banks** play samples from their card, so insert the matching card first.
- **Koltsov** and the other QuadraSynth banks are QuadraSynth / S4 Plus programs. The QS remaps their samples on receipt, so some will sound different from the original.
- Opened files last until you reload the page. Favorites, card choices and names read from the QS are kept in the browser.

## Known limits

- Effect configurations are named from the spec's list. Program-level effect details (reverb type and so on) aren't shown yet.
- Mixes aren't browsable yet.
- The QSR has no keyboard, so use the Test button or your controller.
- Firefox supports Web MIDI only with a site permission add-on and over HTTPS. Use Chrome or Edge.

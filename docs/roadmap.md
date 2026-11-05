# Roadmap

Goal: a complete software editor and librarian for the Alesis QS family (QS6, QS6.1, QS7, QS7.1, QS8, QS8.1, QSR), and ideally the older QuadraSynth / S4 Plus, running in the browser.

## Done: patch browser

- Browse the synth's banks by name and switch with Bank Select + Program Change.
- Audition 68 bundled banks (8,600+ programs) through the edit buffer, search everything, favorites, open `.syx` files.
- Read names from the QS, store a program to a User slot, save single programs as `.syx`.
- Read-only inspector for the four sounds and the effect configuration.
- Connection test that tells a QS setting problem apart from SysEx not arriving.

## 1. Complete parameter model

The foundation for every editor page. Mostly done; see [Parameter model](architecture.md#parameter-model).

- Done: every table in the spec as generated definitions (`tools/gen_params.py` → `app/js/qs-paramdefs.js`), each traced to its spec line, with the spec's errata as explicit overrides.
- Done: decode/encode of whole dumps; every unique program, effect, new mix and global dump in `archive/` round-trips byte-identically. Fields above their spec limit are listed and explained in the tests.
- Left: enumerations the spec doesn't spell out (sample group and sample names, mod sources and destinations, LFO waveforms, reverb types, mix program types). The QS7/QS8 Reference Manual has these lists; it isn't in the archive yet, so add it under `docs/` first.
- Left: check on hardware the limits that look wrong in the spec, and configuration 4's overdrive rows, which clash with the Lezlie mix and the EQ.

## 2. Program editor

First version done; see [Program editor](architecture.md#program-editor).

- Done: Edit in the inspector reads the QS edit buffer and edit effect (`03` / `09`), or falls back to this browser's copy with a warning. Each change goes live with `10H`, at most every 30 ms per parameter, always ending on the final value. Resync sends the full dumps.
- Done: pages per sound that follow the QS's functions (Sample, Level, Pitch, Filter, Amp, Range, Mod matrix, three LFOs, three envelopes, Tracking), a drum page for the 10 drums, and a program page with the name and each sound's mode and enable.
- Done: Compare, Revert, rename, store to a chosen User slot (with its confirm dialog), save as `.syx`, a modified marker and a warning before leaving with unsaved changes.
- Done: the demo QS applies `10H` edits and answers `09`, so `?demo` runs the whole loop.
- Left: try it on the QS7 with a direct MIDI connection: live edits, the drum select, the name through func 7 on a drum sound, and what the QS does to a sound's data when its mode changes (the editor shows what it reads back).
- Left: names for samples, mod sources and destinations, LFO waveforms and the like, which show as numbers until the Reference Manual's lists are added (phase 1).
- Left: an envelope or tracking-curve drawing next to the numbers would help.

## 3. Effects editor

Mostly done inside the program editor's Effects page.

- Done: all five configurations, showing only the parameters the current configuration and types use, edited live with `10H` (mode 3). Configuration and type changes read the QS back. Store keeps the effect with its program.
- Left: settle configuration 4's overdrive rows on hardware (see [Parameter model](architecture.md#parameter-model)); the page warns about them meanwhile.
- Left: reverb type names, from the Reference Manual.

## 4. Mixes and global settings

- Mix browser for User and Preset mixes, plus mix names from bundled banks (already parsed).
- Mix editor for the 16 channels: program, volume, pan, output, effect send, transpose, key range, MIDI filters.
- Global page: transpose, tuning, controller assignments, Program Select, General MIDI, and so on.

## 5. Librarian

- Read the whole synth with the All Dump request (`0C`, about 27 s) and save a dated backup.
- Build a User bank from any mix of library programs, reorder it, check what it overwrites, then write it with paced dumps.
- Export banks and single programs as `.syx`.
- Mixes that reference programs by number should follow them when programs move.

## 6. Nice to have

- Flash card writing (`11`–`15`) for users with PCMCIA flash cards.
- QuadraSynth / S4 Plus program conversion notes, or a warning list of samples that remap.
- A patch randomizer and morph between two programs.
- GitHub Pages hosting so the app needs no download.

## Open questions

- Card bank numbering with more than one bank per card, and with only slot B filled.
- Dump pacing on real interfaces. The spec says the QS needs no delay between dumps when receiving a complete dump, but cheap interfaces and long chains may still need gaps.
- What the ROM identifier values really mean (factory QS banks read 2).

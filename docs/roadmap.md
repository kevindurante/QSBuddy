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

- Fetch the edit buffer (`03`), edit it locally, send each change live with opcode `10H` (debounced), and send a full dump (`02`) to resync.
- Pages per sound that follow the QS's own functions: Sample, Level, Pitch, Filter, Amp, Range, Mod matrix (6 slots), three LFOs, three envelopes, Tracking generator.
- Drum sounds: per-drum sample, level, pan, pitch, decay, note, mute group.
- Compare against the stored version, revert, rename, store to a chosen User slot.
- Expect `10H` to put the QS into Edit mode and to be ignored while it's in Compare.

## 3. Effects editor

- All five configurations (4 sends + reverb, 4 sends + 2 reverbs, 4 sends + Leslie, 2 sends + EQ, overdrive/chorus/delay/reverb/Leslie), showing only the parameters the selected types use.
- Edit live with `10H` (mode 3) and keep the effect with its program when storing.

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

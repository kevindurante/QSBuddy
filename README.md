# QSBuddy

A browser-based editor and librarian for the Alesis QS synths (QS6, QS7, QS8, QSR and the .1 models), talking to the synth over Web MIDI. Nothing to install: open it in Chrome or Edge.

**Today** it's a patch browser and librarian:

- Browse the QS's own banks by name and switch programs.
- Audition 8,600+ programs from 68 archived banks through the edit buffer.
- Search everything, keep favorites, open `.syx` files.
- Read names from the synth, store programs to User slots.

**Next** is a full program, effects and mix editor; see the [roadmap](docs/roadmap.md).

## Quick start

1. Connect your MIDI interface Out → QS MIDI In, and QS MIDI Out → interface In.
2. On the QS: press **PROGRAM**, then **GLOBAL** → MIDI page → **MIDI Program Select** On, **General MIDI** Off.
3. Open [`app/index.html`](app/index.html) in Chrome or Edge, allow MIDI with SysEx, and pick your ports and channel.

If the browser won't give MIDI to a page opened from disk, run the local server instead:

```bash
python tools/serve.py
```

No synth? Open `app/index.html?demo` for a simulated QS7. The [user guide](docs/user-guide.md) covers everything else, including MIDI chains that drop SysEx.

## Repository layout

| Path | What's there |
| --- | --- |
| [`app/`](app) | The web app: HTML, CSS and plain scripts, no build step. |
| [`docs/`](docs) | [User guide](docs/user-guide.md), [architecture](docs/architecture.md), [roadmap](docs/roadmap.md) and the [QS SysEx spec](docs/spec/QS678R-sysex-spec.txt). |
| [`tools/`](tools) | Library builder and local server (Python standard library). |
| [`tests/`](tests) | Codec tests against the real bank files (Node, no dependencies). |
| [`archive/`](archive) | The original QS archive: banks, Q-Card images, manuals, schematics and vintage software. |

## Development

Needs Node 22+ for tests and Python 3 for the tools. No packages to install.

```bash
npm test
```

```bash
npm run build:library
```

```bash
npm run serve
```

Read [docs/architecture.md](docs/architecture.md) before changing the codec or the MIDI path.

## The archive

This repo started as a fork of an archive of everything that survives for the QS line: SysEx banks, Expando and Q-Card extra banks, Q-Card images, service manual and schematics, and old editors and utilities. All of it now lives in [`archive/`](archive), untouched, with the original README at [`archive/README.md`](archive/README.md). Thanks to its collector for saving it.

QSBuddy's bundled library is generated from those files by `tools/build_library.py`, and the SysEx spec copied into `docs/spec/` comes from `archive/synthzoneftp-dump/QS8/`.

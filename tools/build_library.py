#!/usr/bin/env python3
"""
Build the app's bundled library from the banks kept in archive/.

    python tools/build_library.py

Writes:
  app/library/index.js        names for every bank and Q-Card (loaded at startup)
  app/library/banks/<id>.js   program + effect data per bank (loaded on demand)

The browser loads these as plain <script> files so it works straight from
file:// with no server. Standard library only. Zip archives are read in
memory; nothing is extracted to disk.

To add a bank: append an entry to COLLECTIONS (paths are relative to
archive/) and re-run.
"""
import base64
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ARCHIVE = os.path.join(REPO, 'archive')
APP = os.path.join(REPO, 'app')
OUT = os.path.join(APP, 'library')

PROGRAM_SIZE = 350
EFFECT_SIZE = 65

QC = 'QCards + Extra Banks'
OB = QC + '/OTHER-BANKS'
ZIPS = 'synthzoneftp-dump/QSYNTH'

# (bank id, title, source path, optional "member" inside a zip)
COLLECTIONS = [
    {
        'id': 'factory',
        'title': 'Factory',
        'note': 'Alesis factory banks. Presets 1-3 and GenMIDI are in the QS ROM; '
                'User is the factory default User bank.',
        'banks': [
            ('factory-user', 'User (factory default)', 'BANKS/FACTORY/Q678USER.SYX'),
            ('factory-p1', 'Preset 1', 'BANKS/FACTORY/Q678PST1.SYX'),
            ('factory-p2', 'Preset 2', 'BANKS/FACTORY/Q678PST2.SYX'),
            ('factory-p3', 'Preset 3', 'BANKS/FACTORY/Q678PST3.SYX'),
            ('factory-gm', 'GenMIDI', 'BANKS/FACTORY/Q678PST4.SYX'),
        ],
    },
    {
        'id': 'expando',
        'title': 'Alesis Expando',
        'note': 'Free Alesis banks built from the internal ROM. No card needed.',
        'banks': [
            ('expando-atm', 'Atmospheres', 'BANKS/EXPANDO/Q678XATM.syx'),
            ('expando-drm', 'Drums', 'BANKS/EXPANDO/Q678XDRM.syx'),
            ('expando-gtr', 'Guitars & Basses', 'BANKS/EXPANDO/Q678XGTR.syx'),
            ('expando-key', 'Keyboards', 'BANKS/EXPANDO/Q678XKEY.syx'),
            ('expando-orc', 'Orchestral', 'BANKS/EXPANDO/Q678XORC.syx'),
            ('expando-rhy', 'Rhythm Splits', 'BANKS/EXPANDO/Q678XRHY.syx'),
            ('expando-syn', 'Synths', 'BANKS/EXPANDO/Q678XSYN.syx'),
            ('expando-tek', 'Techno', 'BANKS/EXPANDO/Q678XTEK.syx'),
        ],
    },
    {
        'id': 'qcard-extras',
        'title': 'Q-Card Extra Banks',
        'note': 'Companion banks for the Alesis Q-Cards. They play the card\'s samples, '
                'so insert the matching card first.',
        'banks': [
            ('z1-extra1', 'Z1 Hip Hop · Extra 1', QC + '/Z1-Hip Hop/Z1EXTRA1.syx'),
            ('z1-extra2', 'Z1 Hip Hop · Extra 2', QC + '/Z1-Hip Hop/Z1EXTRA2.syx'),
            ('z2-extra1', 'Z2 Eurodance · Extra 1', QC + '/Z2-Eurodance/Z2EXTRA1.syx'),
            ('z2-extra2', 'Z2 Eurodance · Extra 2', QC + '/Z2-Eurodance/Z2EXTRA2.syx'),
            ('z3-extra1', 'Z3 Sanctuary · Extra 1', QC + '/Z3-Sanctuary/Z3EXTRA1.syx'),
            ('z3-extra2', 'Z3 Sanctuary · Extra 2', QC + '/Z3-Sanctuary/Z3EXTRA2.syx'),
            ('z4-extra1', 'Z4 Vintage Keys · Extra 1', QC + '/Z4-Vintage Keyboards/Z4EXTRA1.syx'),
            ('z4-extra2', 'Z4 Vintage Keys · Extra 2', QC + '/Z4-Vintage Keyboards/Z4EXTRA2.syx'),
            ('z5-extra1', 'Z5 Vintage Synths · Extra 1', QC + '/Z5-Vintage Synthesizers/Z5EXTRA1.syx'),
            ('z5-extra2', 'Z5 Vintage Synths · Extra 2', QC + '/Z5-Vintage Synthesizers/Z5EXTRA2.syx'),
            ('z6-extra1', 'Z6 Piano Plus · Extra 1', QC + '/Z6-Piano Plus/Z6EXTRA1.syx'),
            ('z6-extra2', 'Z6 Piano Plus · Extra 2', QC + '/Z6-Piano Plus/Z6EXTRA2.syx'),
            ('z7-extra', 'Z7 Latin · Extra', QC + '/Z7-Latin/Z7_extra.syx'),
            ('z8-extra1', 'Z8 Classical · Extra 1', QC + '/Z8-Classical/Z8EXTRA1.syx'),
            ('z8-extra2', 'Z8 Classical · Extra 2', QC + '/Z8-Classical/Z8EXTRA2.syx'),
            ('r8-extra1', 'R8 Rap Techno Dance · Extra 1', QC + '/R8-Rap Techno Dance/R8-Extra1.SYX'),
            ('r8-extra2', 'R8 Rap Techno Dance · Extra 2', QC + '/R8-Rap Techno Dance/R8-Extra2.SYX'),
        ],
    },
    {
        'id': 'category',
        'title': 'Category Banks',
        'note': 'User-made banks sorted by instrument type (128 programs each, no mixes).',
        'banks': [
            ('cat-bass-syn', 'Synth Basses', OB + '/22BANKS/bass_syn.syx'),
            ('cat-bsacchps', 'Basses, Accordions, Harpsichords', OB + '/22BANKS/bsacchps.syx'),
            ('cat-brssxhrp', 'Brass, Sax & Harps', OB + '/22BANKS/brssxhrp.syx'),
            ('cat-chrhrmpi', 'Chromatic, Harmonica & Pipes', OB + '/22BANKS/chrhrmpi.syx'),
            ('cat-chrom-fx', 'Chromatic FX & Hits', OB + '/22BANKS/chrom_fx.syx'),
            ('cat-g-pd-eth', 'Guitars, Guitar Pads & Ethnic', OB + '/22BANKS/g_pd_eth.syx'),
            ('cat-guitelfx', 'Electric Guitars & Guitar FX', OB + '/22BANKS/guitelfx.syx'),
            ('cat-orgn-ham', 'Organs', OB + '/22BANKS/orgn_ham.syx'),
            ('cat-pacelsyn', 'Acoustic & Electric Pianos', OB + '/22BANKS/pacelsyn.syx'),
            ('cat-pad', 'Pads', OB + '/22BANKS/pad.syx'),
            ('cat-pad-spad', 'More Pads & Synth Pads', OB + '/22BANKS/pad_spad.syx'),
            ('cat-psnpadcr', 'Piano Pads & Synth Pianos', OB + '/22BANKS/psnpadcr.syx'),
            ('cat-spad-vin', 'Synth & Vintage Pads', OB + '/22BANKS/spad_vin.syx'),
            ('cat-stings-1', 'Strings', OB + '/22BANKS/stings_1.syx'),
            ('cat-synattvn', 'Synths: Attack & Vintage', OB + '/22BANKS/synattvn.syx'),
            ('cat-synth-fx', 'Synth FX', OB + '/22BANKS/synth_fx.syx'),
            ('cat-vintage', 'Vintage Synths & Leads', OB + '/22BANKS/vintage.syx'),
            ('cat-wood-sax', 'Woodwinds & Sax', OB + '/22BANKS/wood_sax.syx'),
            ('cat-drum1', 'Drum Kits 1', OB + '/22BANKS/drum1.syx'),
            ('cat-drum2', 'Drum Kits 2', OB + '/22BANKS/drum2.syx'),
            ('cat-rythm1', 'Rhythm 1', OB + '/22BANKS/rythm1.syx'),
            ('cat-rythm2', 'Rhythm 2', OB + '/22BANKS/rythm2.syx'),
        ],
    },
    {
        'id': 'qessence',
        'title': 'QEssence',
        'note': 'QEssence banks 1-3, originally written for the QS6.',
        'banks': [
            ('qessence-1', 'QEssence 1', OB + '/QESSENCE-BANKS/QESENCE1.SYX'),
            ('qessence-2', 'QEssence 2', OB + '/QESSENCE-BANKS/QESENCE2.SYX'),
            ('qessence-3', 'QEssence 3', OB + '/QESSENCE-BANKS/QESENCE3.SYX'),
        ],
    },
    {
        'id': 'sams',
        'title': "Sam's Banks",
        'note': 'By Samuel G. Streeper (1997-98). Free to use, modify and share.',
        'banks': [
            ('sams-23', 'Sams 23', OB + '/SAMS-BANKS/sams_23.syx'),
            ('sams-24', 'Sams 24', OB + '/SAMS-BANKS/sams_24.syx'),
        ],
    },
    {
        'id': 'koltsov',
        'title': 'Koltsov (QuadraSynth)',
        'note': 'Philipp Koltsov\'s QuadraSynth / S4 Plus banks. The QS remaps their '
                'ROM samples when it receives them; some sounds may differ.',
        'banks': [
            ('koltsov-qcard1', 'QCARD1', OB + '/KOLSTOV-BANKS/QCARD1.SYX'),
            ('koltsov-qcard2', 'QCARD2', OB + '/KOLSTOV-BANKS/QCARD2.SYX'),
            ('koltsov-qcard3', 'QCARD3', OB + '/KOLSTOV-BANKS/QCARD3.SYX'),
            ('koltsov-qs100', 'QS100', OB + '/KOLSTOV-BANKS/QS100.SYX'),
            ('koltsov-quad104', 'QUAD104', OB + '/KOLSTOV-BANKS/QUAD104.SYX'),
            ('koltsov-quad106', 'QUAD106', OB + '/KOLSTOV-BANKS/QUAD106.SYX'),
            ('koltsov-quad107', 'QUAD107', OB + '/KOLSTOV-BANKS/QUAD107.SYX'),
            ('koltsov-gm', 'QGENMID (General MIDI)', OB + '/KOLSTOV-BANKS/QGENMID.SYX'),
        ],
    },
    {
        'id': 'quadra-misc',
        'title': 'More QuadraSynth Banks',
        'note': 'QuadraSynth-era banks from the synthzone archive. The QS remaps their '
                'ROM samples; some sounds may differ, and the Plus Piano banks expect its piano ROM.',
        'banks': [
            ('plus-piano-aw', 'Plus Piano: aw_bank', ZIPS + '/PLUSPIANO/aw_bank.zip', 'aw_bank.syx'),
            ('plus-piano-aw2', 'Plus Piano: aw2_bank', ZIPS + '/PLUSPIANO/aw2_bank.zip', 'aw2_bank.syx'),
            ('swennenhuis', 'Paul Swennenhuis: Designed', ZIPS + '/qs_ps.zip', 'DESIGNED.PAT'),
        ],
    },
]

# Q-Card images: only the program names are read (for the synth's card banks).
CARDS = [
    ('z1', 'Z1 Hip Hop', QC + '/Z1-Hip Hop/Z1 - Hip Hop.img'),
    ('z2', 'Z2 Eurodance', QC + '/Z2-Eurodance/Z2 - Euro Dance.img'),
    ('z3', 'Z3 Sanctuary', QC + '/Z3-Sanctuary/Z3 - Sanctuary.img'),
    ('z4', 'Z4 Vintage Keyboards', QC + '/Z4-Vintage Keyboards/Z4 - Vintage Keyboards.img'),
    ('z5', 'Z5 Vintage Synthesizers', QC + '/Z5-Vintage Synthesizers/Z5 - Vintage Synthesizers.img'),
    ('z6', 'Z6 Grand Piano Plus', QC + '/Z6-Piano Plus/Alesis Qcard Z6 GrandPianoPlus.img'),
    ('z7', 'Z7 Latin', QC + '/Z7-Latin/Z7 - Latin.img'),
    ('z8', 'Z8 Classical', QC + '/Z8-Classical/Z8 - Classical.img'),
    ('z9', 'Z9 Stereo Jazz Piano', QC + '/Z9-Jazz Piano/Z9 - Stereo Jazz Piano.img'),
    ('r1', 'R1 Pop & Rock', QC + '/R1-Pop and Rock/PopRock.img'),
    ('r2', 'R2 World & Ethnic', QC + '/R2-World and Ethnic Instruments/Alesis Quadracard WorldEthnic.img'),
    ('r8', 'R8 Rap Techno Dance', QC + '/R8-Rap Techno Dance/R8 - RapTechnoDance.img'),
]


def read_source(path, member=None):
    full = os.path.join(ARCHIVE, path)
    if member:
        with zipfile.ZipFile(full) as zf:
            return zf.read(member)
    with open(full, 'rb') as f:
        return f.read()


def split_sysex(data):
    out, start = [], -1
    for i, b in enumerate(data):
        if b == 0xF0:
            start = i
        elif b == 0xF7 and start >= 0:
            out.append(data[start:i + 1])
            start = -1
    return out


def unpack(midi):
    """8 MIDI bytes -> 7 data bytes, LSB-first bit stream (spec opcode 00)."""
    out = bytearray()
    for i in range(0, len(midi), 8):
        chunk = midi[i:i + 8]
        acc = 0
        for j, b in enumerate(chunk):
            acc |= (b & 0x7F) << (7 * j)
        out += (acc).to_bytes(8, 'little')[:len(chunk) * 7 // 8]
    return bytes(out)


def program_name(p, offset=0):
    """10 x 7-bit name digits starting at program bit 8 (address 1:0)."""
    acc = int.from_bytes(p[offset + 1:offset + 10], 'little')
    chars = []
    for k in range(10):
        v = (acc >> (7 * k)) & 0x7F
        chars.append(chr(32 + v) if v < 95 else '→')
    return ''.join(chars).rstrip()


def parse_bank(data):
    """Same rules as QS.parseBank in js/qs-sysex.js."""
    programs = [None] * 128
    effects = [None] * 128
    seq = []
    for m in split_sysex(data):
        if m[1:5] != b'\x00\x00\x0e\x0e' or len(m) < 8:
            continue
        op, num, body = m[5], m[6] & 0x7F, m[7:-1]
        if op == 0x00:
            programs[num] = unpack(body)[:PROGRAM_SIZE]
            seq.append(('p', num, None))
        elif op == 0x06:
            seq.append(('e', num, unpack(body)[:EFFECT_SIZE]))
    interleaved = len(seq) > 1 and all(
        i + 1 < len(seq) and seq[i + 1][0] == 'e' for i, s in enumerate(seq) if s[0] == 'p')
    for i, (kind, num, payload) in enumerate(seq):
        if kind != 'e':
            continue
        if interleaved:
            if i > 0 and seq[i - 1][0] == 'p':
                effects[seq[i - 1][1]] = payload
        else:
            effects[num] = payload
    return programs, effects


def card_names(img):
    # Q-Card (Z series): magic A5 C3 5A A5, then 128 programs stored as
    # program bytes 1-349 (the unused first byte is dropped).
    if img[:4] == b'\xa5\xc3\x5a\xa5':
        return [program_name(img, 3 + k * 349) for k in range(128)]
    # QuadraCard (R series): magic 5A A5 A5 C3, then 128 full 350-byte programs.
    if img[:4] == b'\x5a\xa5\xa5\xc3':
        return [program_name(img, 4 + k * 350) for k in range(128)]
    raise ValueError('unknown card image format')


def js_string(s):
    return json.dumps(s, ensure_ascii=False)


def main():
    os.makedirs(os.path.join(OUT, 'banks'), exist_ok=True)
    index = {'collections': [], 'cards': []}
    written = set()
    total_programs = 0

    for col in COLLECTIONS:
        entry = {'id': col['id'], 'title': col['title'], 'note': col['note'], 'banks': []}
        for spec in col['banks']:
            bank_id, title, path = spec[0], spec[1], spec[2]
            member = spec[3] if len(spec) > 3 else None
            programs, effects = parse_bank(read_source(path, member))
            names = [program_name(p) if p else None for p in programs]
            count = sum(1 for p in programs if p)
            if count == 0:
                sys.exit('no programs found in %s' % path)
            rom_ids = sorted({(p[9] >> 6) & 3 for p in programs if p})
            prog_blob = b''.join(p or bytes(PROGRAM_SIZE) for p in programs)
            fx_blob = b''.join(e or bytes(EFFECT_SIZE) for e in effects)
            has_fx = [1 if e else 0 for e in effects]
            body = 'QSLIB.addBank(%s, %s, %s, %s);\n' % (
                js_string(bank_id),
                js_string(base64.b64encode(prog_blob).decode('ascii')),
                js_string(base64.b64encode(fx_blob).decode('ascii')),
                json.dumps(has_fx, separators=(',', ':')),
            )
            with open(os.path.join(OUT, 'banks', bank_id + '.js'), 'w', encoding='utf-8', newline='\n') as f:
                f.write('/* Generated by tools/build_library.py from archive/%s */\n' % (path + ('::' + member if member else '')))
                f.write(body)
            written.add(bank_id + '.js')
            entry['banks'].append({
                'id': bank_id,
                'title': title,
                'source': 'archive/' + path + ('::' + member if member else ''),
                'quadraPlus': rom_ids == [0],
                'names': names,
            })
            total_programs += count
            print('%-18s %3d programs  %s' % (bank_id, count, title))
        index['collections'].append(entry)

    for card_id, title, path in CARDS:
        names = card_names(read_source(path))
        index['cards'].append({'id': card_id, 'title': title, 'source': 'archive/' + path, 'names': names})
        print('%-18s card names  %s' % ('card-' + card_id, title))

    # Remove bank files that are no longer in COLLECTIONS.
    for fname in os.listdir(os.path.join(OUT, 'banks')):
        if fname.endswith('.js') and fname not in written:
            os.remove(os.path.join(OUT, 'banks', fname))

    with open(os.path.join(OUT, 'index.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('/* Generated by tools/build_library.py. Do not edit by hand. */\n')
        f.write('window.QSLIB_INDEX = ')
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print('\n%d banks, %d programs, %d card name lists -> %s' % (
        len(written), total_programs, len(CARDS), os.path.relpath(OUT, REPO)))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Generate app/js/qs-paramdefs.js from the Alesis SysEx spec.

    python tools/gen_params.py           write app/js/qs-paramdefs.js
    python tools/gen_params.py --check   exit 1 if the checked-in file is out of date

Reads the tab-separated parameter tables in docs/spec/QS678R-sysex-spec.txt
(Global, New Mix, Program common, Keyboard sound, Drum sound, Effects common
and the five effect configurations) and writes them as plain data on
QS.PARAMDEFS. Every entry keeps the spec's bit address string as written and
the spec line it came from, so it can be checked against the text.

The spec has mistakes. They are corrected only through ERRATA below: each
entry names a spec line, text that must appear on it (so a wrong line number
fails loudly) and what it changes; the original values are kept in the
entry's "spec" field and the reason in its "note". Anything else that doesn't
parse or doesn't add up (bit widths, limits, numbering, overlapping fields)
stops the build.

Standard library only.
"""
import itertools
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SPEC = os.path.join(REPO, 'docs', 'spec', 'QS678R-sysex-spec.txt')
OUT = os.path.join(REPO, 'app', 'js', 'qs-paramdefs.js')
SPEC_REL = 'docs/spec/QS678R-sysex-spec.txt'

SOUND_OFFSETS = [10, 95, 180, 265]

COLUMNS = {
    'plain': ('num', 'name', 'func', 'page', 'pot', 'offset', 'limit', 'bits', 'addr'),
    # The global table has LoLim/HiLim columns and stores signed values as two's complement.
    'global': ('num', 'name', 'func', 'page', 'pot', 'lo', 'hi', 'bits', 'addr'),
    'effect': ('num', 'name', 'send', 'func', 'page', 'pot', 'offset', 'limit', 'bits', 'addr'),
}

# ---------------------------------------------------------------------------
# Spec errata. (line, text expected on that line, changes, reason)
#   'cols'  replaces the row's tab-separated columns before parsing
#   other keys replace the parsed value; the original goes to the entry's "spec"
# ---------------------------------------------------------------------------
ERRATA = [
    # Keyboard sound #121: the columns are shifted one to the left, so
    # "(cannot edit)" sits under Page. It has no func/page/pot.
    (732, '(cannot edit)', {'cols': ['121.', 'Drum number', '', '', '', '0', '9', '4', '84:7-84:4']},
     'Not editable with 10H ("cannot edit" in the spec).'),
    # Drum sound #163: 81:7-81:1 is 7 bits, between Sound enable (81:0) and Drum number (82:3-82:0).
    (765, '0\t0\t6\t81:7-81:1', {'bits': 7}, 'Spec gives 6 bits; the address 81:7-81:1 is 7.'),
    # New Mix: channel 16's parameters are numbered "240-332"; 313-332 follows on from channel 15.
    (483, '240-332.', {'num': '313-332'}, 'Spec numbers these 240-332; channel 15 ends at 312.'),
    # Config 0, Send 2 pitch detune: the Send column says 0 (send 1).
    (882, 'Send 2 pitch detune\t0', {'send': 1}, 'Spec gives Send 0; every other Send 2 row uses 1.'),
    # Config 0 and 4, stereo delay "right delay 1ms": there is no bit 8. The
    # mono and ping-pong rows give the same bits as the spare 17:0-16:5.
    (842, '16:8-16:5', {'addr': '17:0-16:5'}, 'Spec writes 16:8-16:5; there is no bit 8. The mono-delay spare at line 834 is 17:0-16:5.'),
    (1164, '16:8-16:5', {'addr': '17:0-16:5'}, 'Spec writes 16:8-16:5; there is no bit 8. The mono-delay spare at line 1156 is 17:0-16:5.'),
    # Config 1: the pitch send under "PITCH SEND 3" (Send column 2) is named "Send 2".
    (1012, 'Send 2 pitch speed\t2', {'name': 'Send 3 pitch speed'}, 'Spec says "Send 2"; the heading and Send column say send 3.'),
    (1013, 'Send 2 pitch shape\t2', {'name': 'Send 3 pitch shape'}, 'Spec says "Send 2"; the heading and Send column say send 3.'),
    (1014, 'Send 2 pitch depth\t2', {'name': 'Send 3 pitch depth'}, 'Spec says "Send 2"; the heading and Send column say send 3.'),
    # Config 1 has two reverbs, both called "Reverb type". Name them by send.
    (995, '21.\tReverb type\t0', {'name': 'Send 1 reverb type'}, 'Spec says "Reverb type"; config 1 has one on send 1 and one on send 3.'),
    (1019, '37.\tReverb type\t2', {'name': 'Send 3 reverb type'}, 'Spec says "Reverb type"; config 1 has one on send 1 and one on send 3.'),
    # Config 2, Send 1 delay input: offset 0 / limit 99, where config 0's row
    # for the same 8 bits (line 829) is -99 / 198. Archive dumps in config 2
    # use raw values up to 198 (55 of them above 99).
    (1059, 'Send 1 delay input\t0\t4\t0\t0\t0\t99\t8', {'offset': -99, 'limit': 198},
     'Spec gives offset 0, limit 99; config 0 has -99/198 for the same bits and archive dumps use raw values up to 198.'),
    # Config 4 overdrive rows are numbered 50, 52, 63, 64, 65; 63 and 64 clash
    # with the EQ rows that follow. Renumber them 50-54.
    (1196, '52.\tSend 1 overdrive balance', {'num': '51'}, 'Overdrive rows are numbered 50, 52, 63, 64, 65 in the spec; renumbered 50-54.'),
    (1197, '63.\tSend 1 overdrive treshold', {'num': '52'}, 'Overdrive rows are numbered 50, 52, 63, 64, 65 in the spec; renumbered 50-54.'),
    (1198, '64.\tSend 1 overdrive brightness', {'num': '53'}, 'Overdrive rows are numbered 50, 52, 63, 64, 65 in the spec; renumbered 50-54.'),
    (1199, '65.\tSend 1 overdrive mix', {'num': '54'}, 'Overdrive rows are numbered 50, 52, 63, 64, 65 in the spec; renumbered 50-54. '
     'Its address 31:7-31:1 is the same as Send 1 lezlie mix and its func/page/pot the same as Send 1 overdrive type; '
     'one of each pair is wrong. Unverified: check on hardware.'),
]

# Effects common #0-9: the Send column "x" is run into the name with no tab.
for _line in range(789, 799):
    ERRATA.append((_line, '(deleted parameter)x\t', {'split_x': True}, None))

# Spelling slips in parameter names, fixed everywhere they occur. The
# original name is kept in "spec".
NAME_FIXES = [
    ('inut premix', 'input premix'),
    ('treshold', 'threshold'),
    ('amp alfo mod', 'amp lfo mod'),
    ('Send3 ', 'Send 3 '),
]

# Fields that may share bits in one layout. Each pair is one of the errata
# above that couldn't be settled from the spec or the archive dumps.
ALLOWED_OVERLAPS = {
    ('effect', 4, 'send1LezlieMix', 'send1OverdriveMix'),
}


class Spec:
    def __init__(self, path):
        with open(path, encoding='ascii') as f:
            self.lines = [l.rstrip('\r\n') for l in f]
        self.errata = {}
        for line, expect, changes, why in ERRATA:
            if expect not in self.lines[line - 1]:
                self.fail(line, 'erratum expects %r here' % expect)
            self.errata[line] = (changes, why)
        self.used = set()

    def fail(self, line, msg):
        sys.exit('%s:%d: %s\n    %s' % (SPEC_REL, line, msg, self.lines[line - 1] if line else ''))

    def find(self, text, start=0, prefix=False):
        for i in range(start, len(self.lines)):
            s = self.lines[i].strip()
            if s == text or (prefix and s.startswith(text)):
                return i + 1
        sys.exit('%s: heading %r not found' % (SPEC_REL, text))


# ---------------------------------------------------------------------------
# Row parsing
# ---------------------------------------------------------------------------
NUM_RE = re.compile(r'^\d+\.$')
RANGE_RE = re.compile(r'^(\d+)-(\d+)\.\s+(Channel|Drum) (\d+) parameters\t+\(see above\)\t+(\S+)$')
HEADING_RE = re.compile(r'^[A-Z][A-Z0-9 ]*:$')
COND_RE = re.compile(r'^If (\d+)\s*=\s*(.+?)\s*\(([^)]*)\):$')
SAME_RE = re.compile(r'^Parameters (\d+) through (\d+) are identical to configuration (\d+)\.$')
ADDR_RE = re.compile(r'^(\d+):(\d+)(?:-(\d+):(\d+))?$')


def parse_addr(addr):
    """'hiByte:hiBit-loByte:loBit' -> (hi, lo) absolute bits, or None."""
    m = ADDR_RE.match(addr)
    if not m:
        return None
    hb, hbit = int(m.group(1)), int(m.group(2))
    lb, lbit = (int(m.group(3)), int(m.group(4))) if m.group(3) else (hb, hbit)
    if hbit > 7 or lbit > 7 or hb * 8 + hbit < lb * 8 + lbit:
        return None
    return hb * 8 + hbit, lb * 8 + lbit


def fmt_addr(hi, lo):
    a = '%d:%d' % divmod(hi, 8)
    return a if hi == lo else a + '-' + '%d:%d' % divmod(lo, 8)


def parse_values(text):
    """'0 thru 3' / '0 or 1' / '4' -> list of ints."""
    m = re.fullmatch(r'(\d+) thru (\d+)', text)
    if m:
        return list(range(int(m.group(1)), int(m.group(2)) + 1))
    return [int(v) for v in re.split(r'\s+or\s+', text)]


def to_int(cell):
    return None if cell in ('', '--') else int(cell)


def parse_rows(spec, start, end, layout):
    """Rows, range rows, headings, conditions and 'identical to' lines between two spec lines."""
    cols_names = COLUMNS[layout]
    items = []
    for line in range(start, end):
        text = spec.lines[line - 1]
        s = text.strip()
        if not s:
            continue
        changes, why = spec.errata.get(line, ({}, None))
        if line in spec.errata:
            spec.used.add(line)
        m = RANGE_RE.match(text)
        if m:
            row = {'line': line, 'kind': 'range', 'num': '%s-%s' % (m.group(1), m.group(2)),
                   'what': m.group(3), 'n': int(m.group(4)), 'addr': m.group(5), 'spec': {}, 'notes': []}
            apply_changes(row, changes, why)
            items.append(row)
            continue
        if HEADING_RE.match(s):
            items.append({'line': line, 'kind': 'heading', 'text': s[:-1]})
            continue
        m = COND_RE.match(s)
        if m:
            items.append({'line': line, 'kind': 'cond', 'ref': m.group(1), 'values': parse_values(m.group(2)),
                          'label': m.group(3)})
            continue
        m = SAME_RE.match(s)
        if m:
            items.append({'line': line, 'kind': 'same', 'from': int(m.group(1)), 'to': int(m.group(2)),
                          'config': int(m.group(3))})
            continue
        cols = changes.get('cols') or text.split('\t')
        if not NUM_RE.match(cols[0].strip()):
            continue
        cols = [c.strip() for c in cols]
        while cols and not cols[-1]:
            cols.pop()
        if changes.get('split_x'):
            cols = [cols[0], cols[1][:-1].strip(), 'x'] + cols[2:]
        if len(cols) == 2 and cols[1] == 'unused':
            continue  # config 0 #56: a number with nothing behind it
        if len(cols) == len(cols_names) - 1 and cols[-1] == '0':
            continue  # zero-width spare with no address (config 0 #13, #43)
        if len(cols) != len(cols_names):
            spec.fail(line, 'expected %d columns, found %d' % (len(cols_names), len(cols)))
        raw = dict(zip(cols_names, cols))
        row = {'line': line, 'kind': 'row', 'num': raw['num'][:-1], 'name': raw['name'], 'addr': raw['addr'],
               'spec': {}, 'notes': [], 'extra': {}}
        row['bits'] = to_int(raw['bits'])
        func = raw['func']
        if re.fullmatch(r'\d+\*', func):
            # Program name digits: "*If the current sound is a drum, this
            # function number for program name must be 7." (line 594)
            row['func'] = int(func[:-1])
            row['extra']['drumFunc'] = 7
        elif re.fullmatch(r'\d+-\d+,\d+', func):
            # Drum sound #164 "Drum number": shown on functions 0-6 and 8.
            a, b, c = map(int, re.split(r'[-,]', func))
            row['func'] = a
            row['extra']['funcs'] = list(range(a, b + 1)) + [c]
        else:
            row['func'] = to_int(func)
        row['page'] = to_int(raw['page'])
        row['pot'] = to_int(raw['pot'])
        if layout == 'effect':
            row['send'] = None if raw['send'] in ('', 'x') else int(raw['send'])
        if layout == 'global':
            lo, hi = to_int(raw['lo']), to_int(raw['hi'])
            row['offset'], row['limit'] = (0, hi) if hi is not None else (None, None)
            if lo is not None and lo < 0:
                row['twos'], row['min'], row['max'] = True, lo, hi
        else:
            row['offset'] = to_int(raw['offset'])
            limit = raw['limit']
            if re.fullmatch(r'\d+\*', limit):
                # Lezlie horn: "stored as 7 bit 2's complement, with 0 to 6
                # representing the positive values, and 127 to 122
                # representing -1 to -6" (lines 1070, 1216).
                row['limit'] = int(limit[:-1])
                row['twos'], row['min'], row['max'] = True, -row['limit'], row['limit']
            else:
                row['limit'] = to_int(limit)
        apply_changes(row, changes, why)
        items.append(row)
    return items


def apply_changes(row, changes, why):
    for k, v in changes.items():
        if k in ('cols', 'split_x'):
            continue
        row['spec'][k] = row.get(k)
        row[k] = v
    if why:
        row['notes'].append(why)


# ---------------------------------------------------------------------------
# Turning rows into parameter definitions
# ---------------------------------------------------------------------------
MODELS_RE = re.compile(r'\s*\*?\((QS[0-9R,]+) only\)')


def models_list(text):
    parts = text[2:].split(',')
    return ['QS' + p for p in parts]


def camel(words):
    words = [w for w in words if w]
    return words[0].lower() + ''.join(w[0].upper() + w[1:].lower() for w in words[1:])


def make_id(name):
    return camel(re.split(r'[^A-Za-z0-9]+', name.replace('A-D', 'AD')))


def is_spare(name):
    return re.search(r'\bspare\b', name, re.I) is not None


def build_param(spec, row, table, strip=None, footnotes=None):
    name = row['name']
    p = {'id': None, 'num': row['num'], 'name': None, 'addr': row['addr']}
    extra = dict(row['extra'])
    m = MODELS_RE.search(name)
    if m:
        extra['models'] = models_list(m.group(1))
        name = MODELS_RE.sub('', name)
    marks = re.search(r'\s*(\*+)\s*$', name)
    if marks:
        name = name[:marks.start()]
        extra.update((footnotes or {}).get(marks.group(1), {}))
    elif m and '*' in m.group(0):
        extra.update((footnotes or {}).get('*', {}))  # "Clock  *(QS7,8,R only)": the star sits before the model note
    name = re.sub(r'\s*\(=\d\)$', '', name).strip()
    for wrong, right in NAME_FIXES:
        if wrong in name:
            row['spec'].setdefault('name', row['name'])
            name = name.replace(wrong, right)
    # Template rows ("Drum 1 ...", "Channel 1 ...") drop the instance number;
    # their id is the rest of the name.
    templ = strip and re.match(strip, name)
    if templ:
        id_src = name[templ.end():]
        name = templ.group(1) + ' ' + id_src
    elif table in ('keyboardSound', 'drumSound'):
        id_src = re.sub(r'^Sound ', '', name)
    else:
        id_src = name
    span = parse_addr(row['addr'])
    if span is None:
        spec.fail(row['line'], 'bad bit address %r' % row['addr'])
    width = span[0] - span[1] + 1
    spare = is_spare(name)
    if row['bits'] is not None and row['bits'] != width:
        spec.fail(row['line'], 'bits column says %d, address %s is %d bits' % (row['bits'], row['addr'], width))
    p['bits'] = width
    p['offset'] = row.get('offset') if row.get('offset') is not None else 0
    p['limit'] = row.get('limit')
    if p['limit'] is not None and not row.get('twos') and p['limit'] > (1 << width) - 1:
        spec.fail(row['line'], 'limit %d does not fit in %d bits' % (p['limit'], width))
    if row.get('twos'):
        if not (-(1 << (width - 1)) <= row['min'] and row['max'] <= (1 << (width - 1)) - 1):
            spec.fail(row['line'], 'range %d..%d does not fit %d-bit two\'s complement' % (row['min'], row['max'], width))
        p['min'], p['max'] = row['min'], row['max']
        extra['twos'] = True
    p['func'], p['page'], p['pot'] = row['func'], row['page'], row['pot']
    if 'send' in row:
        p['send'] = row['send']
    p['name'] = name
    p['id'] = 'spare@' + row['addr'] if spare else make_id(id_src)
    if spare:
        extra['spare'] = True
    p['display'] = None
    p['extra'] = extra
    p['line'] = row['line']
    p['spec'] = row['spec']
    p['notes'] = list(row['notes'])
    return p


def set_display(p):
    ex = p['extra']
    name = p['name'].lower()
    if 'options' in ex:
        d = 'enum'
    elif ex.get('spare'):
        d = 'number'
    elif 'name digit' in name:
        d = 'char'
    elif ex.get('twos') or p['offset'] < 0:
        d = 'signed'
    elif re.search(r'note limit|low note|high note|note number', name):
        d = 'note'
    elif p['bits'] == 1 and p['limit'] == 1 and re.search(
            r'on/off|enable|gate|track|sustain pedal|general midi|reset|program change', name):
        d = 'onoff'
    else:
        d = 'number'
    p['display'] = d


def split_wide_spare(p):
    """A spare wider than 24 bits becomes byte-sized pieces so each fits a 32-bit read."""
    hi, lo = parse_addr(p['addr'])
    if not p['extra'].get('spare') or hi - lo + 1 <= 24:
        return [p]
    out = []
    b = lo
    while b <= hi:
        top = min(hi, b // 8 * 8 + 7)
        q = dict(p, extra=dict(p['extra']), spec=dict(p['spec'], addr=p['addr']), notes=list(p['notes']))
        q['addr'] = fmt_addr(top, b)
        q['id'] = 'spare@' + q['addr']
        q['bits'] = top - b + 1
        q['notes'].append('Piece of the spec\'s spare %s, split so each piece fits a 32-bit read.' % p['addr'])
        out.append(q)
        b = top + 1
    return out


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------
def rows_only(spec, items):
    out = []
    for it in items:
        if it['kind'] == 'row':
            out.append(it)
        elif it['kind'] != 'range':
            spec.fail(it['line'], 'unexpected %s in this table' % it['kind'])
    return out


def repeated(spec, items, what, template, first_num, per, stride, count, first_byte):
    """Check the 'Drum n parameters' / 'Channel n parameters' rows against the template."""
    instances = []
    t_spans = [parse_addr(p['addr']) for p in template]
    t_hi = max(s[0] for s in t_spans)
    t_lo = min(s[1] for s in t_spans)
    ranges = [it for it in items if it['kind'] == 'range' and it['what'] == what]
    if [r['n'] for r in ranges] != list(range(2, count + 1)):
        spec.fail(ranges[0]['line'] if ranges else 0, '%s rows are not numbered 2..%d' % (what, count))
    for r in ranges:
        k = r['n'] - 1
        want_num = '%d-%d' % (first_num + per * k, first_num + per * k + per - 1)
        if r['num'] != want_num:
            spec.fail(r['line'], 'numbered %s, expected %s' % (r['num'], want_num))
        want_addr = fmt_addr(t_hi + stride * 8 * k, t_lo + stride * 8 * k)
        if r['addr'] != want_addr:
            spec.fail(r['line'], 'address %s, expected %s' % (r['addr'], want_addr))
        inst = {'n': r['n'], 'num': r['num'], 'addr': r['addr'], 'line': r['line']}
        if r['spec']:
            inst['spec'] = r['spec']
            inst['note'] = ' '.join(r['notes'])
        instances.append(inst)
    if t_hi - t_lo + 1 != stride * 8 or t_lo != first_byte * 8:
        spec.fail(template[0]['line'], '%s template is not %d bytes from byte %d' % (what, stride, first_byte))
    return instances


def parse_global(spec):
    start = spec.find('GLOBAL DATA FORMAT')
    end = spec.find('NEW MIX DATA FORMAT')
    rows = rows_only(spec, parse_rows(spec, start, end, 'global'))
    # "* These parameters are transmitted, but are ignored when received as
    # part of a Global data dump (opcode 0A)." (line 415)
    foot = {'*': {'ignoredInDump': True}}
    return [build_param(spec, r, 'global', footnotes=foot) for r in rows]


def parse_new_mix(spec):
    start = spec.find('NEW MIX DATA FORMAT')
    end = spec.find('OLD MIX DATA FORMAT')
    items = parse_rows(spec, start, end, 'plain')
    rows = rows_only(spec, items)
    # "** NOTE: For the QSR, this parameter is MIDI Group on/off." (line 485)
    foot = {'**': {'note': 'On the QSR this is MIDI Group on/off.'}}
    params = [build_param(spec, r, 'newMix', strip=r'^(Channel) 1 ', footnotes=foot) for r in rows]
    common = [p for p in params if not p['name'].startswith('Channel ')]
    chan = [p for p in params if p['name'].startswith('Channel ')]
    for r, p in zip(rows, params):
        if p in chan and not r['name'].startswith('Channel 1 '):
            spec.fail(r['line'], 'channel row that is not channel 1')
    insts = repeated(spec, items, 'Channel', chan, 13, 20, 8, 16, 10)
    return common, chan, insts


def parse_program(spec):
    start = spec.find('PROGRAM DATA FORMAT')
    end = spec.find('Keyboard Sound:')
    rows = rows_only(spec, parse_rows(spec, start, end, 'plain'))
    # ROM identifier values, from the footnote under the table.
    opts_line = spec.find('possible values:', start)
    options = []
    for line in range(opts_line + 1, end):
        m = re.match(r'^\s*(\d+) = (.+)$', spec.lines[line - 1])
        if not m:
            break
        if int(m.group(1)) != len(options):
            spec.fail(line, 'ROM identifier values out of order')
        options.append(m.group(2).strip())
    foot = {'**': {'options': options}}
    return [build_param(spec, r, 'program', footnotes=foot) for r in rows]


# "The least significant bit of the first byte of each sound determines if it
# is a keyboard sound or a drum sound." (lines 555-557); the rows say (=0) and (=1).
SOUND_MODE_OPTIONS = ['Keyboard', 'Drum']


def parse_keyboard(spec):
    start = spec.find('Keyboard Sound:')
    end = spec.find('Drum Sound:')
    rows = rows_only(spec, parse_rows(spec, start, end, 'plain'))
    params = [build_param(spec, r, 'keyboardSound') for r in rows]
    params[0]['extra']['options'] = SOUND_MODE_OPTIONS
    if [int(p['num']) for p in params] != list(range(len(params))) or len(params) != 122:
        spec.fail(start, 'keyboard sound rows are not numbered 0-121')
    return params


def parse_drum(spec):
    start = spec.find('Drum Sound:')
    end = spec.find('EFFECT DATA FORMAT')
    items = parse_rows(spec, start, end, 'plain')
    rows = rows_only(spec, items)
    params = [build_param(spec, r, 'drumSound', strip=r'^(Drum) 1 ') for r in rows]
    params[0]['extra']['options'] = SOUND_MODE_OPTIONS
    template = [p for r, p in zip(rows, params) if r['name'].startswith('Drum 1 ')]
    common = [p for r, p in zip(rows, params) if not r['name'].startswith('Drum 1 ')]
    insts = repeated(spec, items, 'Drum', template, 2, 16, 8, 10, 1)
    return common, template, insts


def parse_effects(spec):
    start = spec.find('EFFECT DATA FORMAT')
    c0 = spec.find('Configuration 0 (', start, prefix=True)
    rows = rows_only(spec, parse_rows(spec, start, c0, 'effect'))
    common = [build_param(spec, r, 'effect') for r in rows]
    configs = []
    heads = []
    i = start  # find() searches from the line after this one
    for n in range(5):
        line = spec.find('Configuration %d (' % n, i, prefix=True)
        heads.append(line)
        i = line + 1
    heads.append(len(spec.lines) + 1)
    for n in range(5):
        head = spec.lines[heads[n] - 1].strip()
        title = re.match(r'^Configuration \d+ \((.*)\):$', head).group(1)
        items = parse_rows(spec, heads[n] + 1, heads[n + 1], 'effect')
        params = []
        copies = []
        group, cond = None, None
        for it in items:
            if it['kind'] == 'heading':
                group, cond = it['text'], None
            elif it['kind'] == 'cond':
                cond = it
            elif it['kind'] == 'same':
                if it['config'] >= n:
                    spec.fail(it['line'], 'refers forward to configuration %d' % it['config'])
                copied = [p for p in configs[it['config']]['rows'] if it['from'] <= p['_num'] <= it['to']]
                if not copied:
                    spec.fail(it['line'], 'nothing to copy')
                params.extend(dict(p) for p in copied)
                copies.append({'from': it['from'], 'to': it['to'], 'config': it['config'], 'line': it['line']})
            elif it['kind'] == 'row':
                p = build_param(spec, it, 'effect')
                p['group'] = group.capitalize() if group else None
                p['_num'] = int(it['num'])
                if cond:
                    p['_cond'] = cond
                params.append(p)
            else:
                spec.fail(it['line'], 'unexpected %s' % it['kind'])
        configs.append({'index': n, 'name': title, 'line': heads[n], 'copies': copies, 'rows': params})
    for cfg in configs:
        resolve_conditions(spec, cfg)
    return common, configs


def resolve_conditions(spec, cfg):
    plain = [p for p in cfg['rows'] if '_cond' not in p and not p['extra'].get('spare')]
    seen = {}
    for p in plain:
        if p['num'] in seen:
            spec.fail(p['line'], 'configuration %d has two #%s (also line %d)' % (cfg['index'], p['num'], seen[p['num']]))
        seen[p['num']] = p['line']
    by_num = {p['num']: p for p in plain}
    for p in cfg['rows']:
        c = p.get('_cond')
        if not c:
            continue
        ref = by_num.get(c['ref'])
        if ref is None:
            spec.fail(c['line'], 'condition refers to #%s, not found in configuration %d' % (c['ref'], cfg['index']))
        p['when'] = {'id': ref['id'], 'in': c['values']}
        # The condition labels are the only names the spec gives for these
        # type values, so they become the type's options.
        opts = ref['extra'].setdefault('options', [None] * (ref['limit'] + 1))
        for v in c['values']:
            if v >= len(opts):
                spec.fail(c['line'], 'value %d is above the limit of #%s' % (v, c['ref']))
            label = c['label'][0].upper() + c['label'][1:]
            if opts[v] not in (None, label):
                spec.fail(c['line'], 'value %d already labelled %r' % (v, opts[v]))
            opts[v] = label


# ---------------------------------------------------------------------------
# Layout checks: every field fits, and no two fields share a bit (except the
# allowed errata). Gaps are reported; the runtime decoder keeps them as
# "unlisted" fields so round-trips stay byte-identical.
# ---------------------------------------------------------------------------
OVERLAPS_SEEN = set()


def check_layout(spec, label, fields, size, allowed=()):
    owner = [None] * (size * 8)
    for f, base in fields:
        hi, lo = parse_addr(f['addr'])
        for b in range(lo + base * 8, hi + base * 8 + 1):
            if b >= size * 8:
                spec.fail(f['line'], '%s: %s runs past byte %d' % (label, f['addr'], size - 1))
            if owner[b] is not None:
                o = owner[b]
                pair = tuple(sorted((o['id'], f['id'])))
                if pair not in allowed:
                    spec.fail(f['line'], '%s: %s overlaps %s (line %d) at bit %s' % (
                        label, f['id'], o['id'], o['line'], fmt_addr(b, b)))
                OVERLAPS_SEEN.add(pair)
            owner[b] = f
    gaps = []
    b = 0
    while b < size * 8:
        if owner[b] is None:
            e = b
            while e + 1 < size * 8 and owner[e + 1] is None:
                e += 1
            gaps.append(fmt_addr(e, b))
            b = e + 1
        else:
            b += 1
    return gaps


def effect_combos(cfg):
    """Each combination of conditional variants a configuration can take."""
    keys = []
    for p in cfg['rows']:
        if 'when' in p and p['when']['id'] not in keys:
            keys.append(p['when']['id'])
    choices = []
    for k in keys:
        vals = sorted({v for p in cfg['rows'] if p.get('when', {}).get('id') == k for v in p['when']['in']})
        # One representative value per distinct variant.
        reps, seen = [], set()
        for v in vals:
            sig = tuple(p['line'] for p in cfg['rows'] if p.get('when', {}).get('id') == k and v in p['when']['in'])
            if sig not in seen:
                seen.add(sig)
                reps.append(v)
        choices.append(reps)
    for combo in itertools.product(*choices):
        state = dict(zip(keys, combo))
        yield state, [p for p in cfg['rows'] if 'when' not in p or state[p['when']['id']] in p['when']['in']]


def check_all(spec, tables):
    report = []
    g = tables['global']
    report.append(('Global', check_layout(spec, 'global', [(p, 0) for p in g], 20)))
    common, chan, _ = tables['newMix']
    fields = [(p, 0) for p in common] + [(p, c * 8) for c in range(16) for p in chan]
    report.append(('New Mix', check_layout(spec, 'new mix', fields, 138)))
    prog = tables['program']
    report.append(('Program common', check_layout(spec, 'program', [(p, 0) for p in prog], 10)))
    report.append(('Keyboard sound', check_layout(spec, 'keyboard sound', [(p, 0) for p in tables['keyboardSound']], 85)))
    dcommon, dtemplate, _ = tables['drumSound']
    fields = [(p, 0) for p in dcommon] + [(p, d * 8) for d in range(10) for p in dtemplate]
    report.append(('Drum sound', check_layout(spec, 'drum sound', fields, 85)))
    ecommon, configs = tables['effect']
    for cfg in configs:
        allowed = {(a, b) for kind, n, a, b in ALLOWED_OVERLAPS if kind == 'effect' and n == cfg['index']}
        allowed = {tuple(sorted(x)) for x in allowed}
        gapsets = set()
        for state, active in effect_combos(cfg):
            ids = {}
            for p in active:
                if p['id'] in ids and ids[p['id']]['addr'] != p['addr']:
                    spec.fail(p['line'], 'configuration %d: id %s used twice (line %d)' % (cfg['index'], p['id'], ids[p['id']]['line']))
                ids[p['id']] = p
            label = 'effect config %d %s' % (cfg['index'], state or '')
            gapsets.add(tuple(check_layout(spec, label, [(p, 0) for p in ecommon + active], 65, allowed)))
        for gs in sorted(gapsets):
            report.append(('Effect config %d' % cfg['index'], list(gs)))
    stale = {tuple(sorted((a, b))) for _, _, a, b in ALLOWED_OVERLAPS} - OVERLAPS_SEEN
    if stale:
        sys.exit('ALLOWED_OVERLAPS entries no longer overlap: %s' % sorted(stale))
    return report


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
KEY_ORDER = ['id', 'num', 'name', 'addr', 'bits', 'offset', 'limit', 'min', 'max', 'func', 'page', 'pot', 'send',
             'display', 'options', 'when', 'group', 'spare', 'twos', 'drumFunc', 'funcs', 'ignoredInDump', 'models',
             'note', 'spec', 'line']


def finish(p):
    set_display(p)
    out = {}
    merged = dict(p)
    merged.update(p['extra'])
    notes = list(p['notes'])
    if merged.get('note'):
        notes.insert(0, merged['note'])
    merged['note'] = ' '.join(notes) if notes else None
    if not merged.get('spec'):
        merged['spec'] = None
    for k in KEY_ORDER:
        if k not in merged:
            continue
        v = merged[k]
        if k in ('func', 'page', 'pot', 'send', 'limit', 'offset', 'bits'):
            out[k] = v
        elif v is not None and v is not False:
            out[k] = v
    return out


def dump_params(params, indent):
    pad = ' ' * indent
    rows = []
    for p in params:
        for q in split_wide_spare(p):
            rows.append(pad + json.dumps(finish(q), ensure_ascii=False, separators=(', ', ': ')))
    return '[\n' + ',\n'.join(rows) + '\n' + ' ' * (indent - 2) + ']'


def render(tables, report):
    gcommon = tables['global']
    mcommon, mchan, minst = tables['newMix']
    prog = tables['program']
    kbd = tables['keyboardSound']
    dcommon, dtemplate, dinst = tables['drumSound']
    ecommon, configs = tables['effect']
    J = lambda v: json.dumps(v, ensure_ascii=False, separators=(', ', ': '))
    o = []
    o.append('/*')
    o.append(' * qs-paramdefs.js: QS6/7/8/R parameter definitions.')
    o.append(' *')
    o.append(' * GENERATED by tools/gen_params.py from %s. Do not edit by hand;' % SPEC_REL)
    o.append(' * fix the generator (or its ERRATA list) and run: npm run build:params')
    o.append(' *')
    o.append(' * Each parameter:')
    o.append(' *   id        key, unique within a layout (spares are "spare@<addr>")')
    o.append(' *   num       the spec\'s "#" column; name: the spec\'s name (instance numbers dropped in templates)')
    o.append(' *   addr      bit address exactly as the spec writes it, "hiByte:hiBit-loByte:loBit"; add the')
    o.append(' *             layout base (sound offset, channel or drum stride) when reading')
    o.append(' *   bits      field width; offset, limit: the spec\'s columns (value = raw + offset, raw 0..limit)')
    o.append(' *   min, max  value range for two\'s complement fields (twos: true), which ignore offset')
    o.append(' *   func, page, pot, send   opcode 10H coordinates (null where the spec gives none)')
    o.append(' *   display   number | signed | note | onoff | char | enum (with options)')
    o.append(' *   when      {id, in}: only present when that field\'s raw value is in the list')
    o.append(' *   spec      original values where an erratum in tools/gen_params.py changed them; note says why')
    o.append(' *   line      the spec line the entry comes from')
    o.append(' *')
    o.append(' * Bits no entry covers (reported by the generator):')
    for label, gaps in report:
        if gaps:
            o.append(' *   %-16s %s' % (label, ', '.join(gaps)))
    o.append(' */')
    o.append('(function (QS) {')
    o.append("  'use strict';")
    o.append('')
    o.append('  QS.PARAMDEFS = {')
    o.append("    spec: %s," % J(SPEC_REL))
    o.append('    global: {')
    o.append('      mode: 0, size: 20,')
    o.append('      params: %s' % dump_params(gcommon, 8))
    o.append('    },')
    o.append('    newMix: {')
    o.append('      mode: 1, size: 138,')
    o.append('      params: %s,' % dump_params(mcommon, 8))
    o.append('      channel: {')
    o.append('        count: 16, stride: 8,')
    o.append('        instances: %s,' % J(minst))
    o.append('        params: %s' % dump_params(mchan, 10))
    o.append('      }')
    o.append('    },')
    o.append('    program: {')
    o.append('      mode: 2, size: 350, soundOffsets: %s, soundSize: 85,' % J(SOUND_OFFSETS))
    o.append('      params: %s' % dump_params(prog, 8))
    o.append('    },')
    o.append('    keyboardSound: {')
    o.append('      params: %s' % dump_params(kbd, 8))
    o.append('    },')
    o.append('    drumSound: {')
    o.append('      params: %s,' % dump_params(dcommon, 8))
    o.append('      drum: {')
    o.append('        count: 10, stride: 8,')
    o.append('        instances: %s,' % J(dinst))
    o.append('        params: %s' % dump_params(dtemplate, 10))
    o.append('      }')
    o.append('    },')
    o.append('    effect: {')
    o.append('      mode: 3, size: 65,')
    o.append('      params: %s,' % dump_params(ecommon, 8))
    o.append('      configs: [')
    cfg_out = []
    for cfg in configs:
        # copies: "Parameters a through b are identical to configuration n";
        # the copied entries keep their configuration 0 line numbers.
        cfg_out.append('        {\n          index: %d, name: %s, line: %d,%s\n          params: %s\n        }' % (
            cfg['index'], J(cfg['name']), cfg['line'],
            '\n          copies: %s,' % J(cfg['copies']) if cfg['copies'] else '',
            dump_params(cfg['rows'], 12)))
    o.append(',\n'.join(cfg_out))
    o.append('      ]')
    o.append('    }')
    o.append('  };')
    o.append("})(typeof module !== 'undefined' && module.exports")
    o.append("  ? (module.exports = require('./qs-sysex.js'))")
    o.append('  : (window.QS = window.QS || {}));')
    return '\n'.join(o) + '\n'


def main():
    check = '--check' in sys.argv[1:]
    spec = Spec(SPEC)
    tables = {
        'global': parse_global(spec),
        'newMix': parse_new_mix(spec),
        'program': parse_program(spec),
        'keyboardSound': parse_keyboard(spec),
        'drumSound': parse_drum(spec),
        'effect': parse_effects(spec),
    }
    # Effect configuration: the configuration headings name the values.
    ecommon, configs = tables['effect']
    cfg_param = next(p for p in ecommon if p['id'] == 'effectConfiguration')
    if cfg_param['limit'] != len(configs) - 1:
        spec.fail(cfg_param['line'], 'limit does not match the %d configurations' % len(configs))
    cfg_param['extra']['options'] = [c['name'] for c in configs]
    unused = sorted(set(spec.errata) - spec.used)
    if unused:
        sys.exit('errata not applied (line moved?): %s' % unused)
    report = check_all(spec, tables)
    text = render(tables, report)
    if check:
        with open(OUT, encoding='utf-8') as f:
            if f.read() != text:
                sys.exit('%s is out of date; run: python tools/gen_params.py' % os.path.relpath(OUT, REPO))
        print('up to date')
        return
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    counts = {
        'global': len(tables['global']),
        'new mix': '%d + 16 x %d' % (len(tables['newMix'][0]), len(tables['newMix'][1])),
        'program': len(tables['program']),
        'keyboard sound': len(tables['keyboardSound']),
        'drum sound': '%d + 10 x %d' % (len(tables['drumSound'][0]), len(tables['drumSound'][1])),
        'effect': '%d + configs %s' % (len(ecommon), [len(c['rows']) for c in configs]),
    }
    for k, v in counts.items():
        print('%-15s %s' % (k, v))
    for label, gaps in report:
        if gaps:
            print('gaps %-16s %s' % (label, ', '.join(gaps)))
    print('-> %s' % os.path.relpath(OUT, REPO))


if __name__ == '__main__':
    main()

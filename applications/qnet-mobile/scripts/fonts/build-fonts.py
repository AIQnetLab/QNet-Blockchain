"""Builds the app's six static faces (assets/native/fonts) from the variable fonts of Archivo and Martian Mono.

Tooling, not app code. Inputs are variable files of the two families carrying the wght and wdth axes (.ttf or .woff2,
one file or several unicode-range pieces of one family, such as the site's self-hosted files). Each face is pinned at
its weight and width, its pieces merged, cut to the glyph set the app writes, and named so that its PostScript name
equals its file name. Both families are under the SIL Open Font License 1.1: the copyright and licence records stay in
every face, and the build stops if a Reserved Font Name is declared in the licence text given.

  python scripts/fonts/build-fonts.py --ofl-archivo OFL-Archivo.txt --ofl-martian OFL-MartianMono.txt <inputs...>
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys
import types

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'native', 'fonts'))

LICENSE_TEXT = ('This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available '
                'with a FAQ at: https://openfontlicense.org')
LICENSE_URL = 'https://openfontlicense.org'


def ranges(*spans):
    out = set()
    for span in spans:
        lo, hi = span if isinstance(span, tuple) else (span, span)
        out.update(range(lo, hi + 1))
    return out


LATIN = ranges((0x20, 0x7E), (0xA0, 0x17F), 0x192, 0x2C6, 0x2DA, 0x2DC, (0x2010, 0x2027), 0x2030, (0x2039, 0x203A),
               0x20AC, 0x2122, 0x2212)
CYRILLIC = ranges((0x400, 0x45F), (0x490, 0x491), 0x2116)

# File = PostScript name: (family prefix in the inputs, wght, wdth, glyph set, family name written into the face).
FACES = {
    'Archivo-Regular': ('Archivo', 400, 100, LATIN, 'Archivo'),
    'Archivo-SemiBold': ('Archivo', 600, 100, LATIN, 'Archivo SemiBold'),
    'Archivo-Title': ('Archivo', 760, 110, LATIN, 'Archivo Title'),
    'MartianMono-Data': ('Martian Mono', 400, 80, LATIN | CYRILLIC, 'Martian Mono Data'),
    'MartianMono-Label': ('Martian Mono', 400, 87.5, LATIN | CYRILLIC, 'Martian Mono Label'),
    'MartianMono-Figure': ('Martian Mono', 300, 75, LATIN, 'Martian Mono Figure'),
}


def node_brotli():
    """fontTools reads .woff2 through the brotli module; without it, Node's built-in brotli does the unpacking."""
    try:
        import brotli  # noqa: F401
        return
    except ImportError:
        pass

    def decompress(data):
        script = "process.stdout.write(require('zlib').brotliDecompressSync(require('fs').readFileSync(0)))"
        return subprocess.run(['node', '-e', script], input=data, capture_output=True, check=True).stdout

    sys.modules['brotli'] = types.SimpleNamespace(decompress=decompress)


def check_ofl(path, family):
    text = open(path, encoding='utf-8').read()
    if 'SIL OPEN FONT LICENSE' not in text.upper() or 'Version 1.1' not in text:
        sys.exit(f'{path}: not the SIL Open Font License 1.1 text')
    header = text.split('PREAMBLE')[0]
    if re.search(r'Reserved\s+Font\s+Name', header, re.I):
        sys.exit(f'{path}: a Reserved Font Name is declared for {family}; the faces may not keep its name')
    return text


def family_of(font):
    name = font['name'].getDebugName(1) or ''
    for prefix in ('Martian Mono', 'Archivo'):
        if name.startswith(prefix):
            return prefix
    return None


def pin(path, wght, wdth):
    font = TTFont(path)
    font.flavor = None  # written as plain TrueType, the one format both platforms load
    axes = {a.axisTag: a for a in font['fvar'].axes}
    for tag, value in (('wght', wght), ('wdth', wdth)):
        if tag not in axes or not axes[tag].minValue <= value <= axes[tag].maxValue:
            sys.exit(f'{path}: axis {tag} does not reach {value}')
    return instancer.instantiateVariableFont(font, {'wght': wght, 'wdth': wdth}, updateFontNames=False)


def cut(font, unicodes):
    options = subset.Options()
    options.layout_features = ['*']
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_languages = [0x409]
    options.hinting = False
    options.notdef_outline = True
    options.glyph_names = False
    sub = subset.Subsetter(options)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    return font


def name_face(font, ps_name, family):
    table = font['name']
    copyright_line = table.getDebugName(0)
    version = table.getDebugName(5) or 'Version 1.000'
    if not copyright_line:
        sys.exit(f'{ps_name}: the copyright record is missing from the input')
    for rec in list(table.names):
        if rec.nameID not in (0, 5):
            table.removeNames(nameID=rec.nameID)
    full = family if family.endswith(('Regular', 'SemiBold', 'Title', 'Data', 'Label', 'Figure')) else f'{family} Regular'
    for name_id, value in ((1, family), (2, 'Regular'), (3, f'{version};{ps_name}'), (4, full), (6, ps_name),
                           (13, LICENSE_TEXT), (14, LICENSE_URL)):
        table.setName(value, name_id, 3, 1, 0x409)
        table.setName(value, name_id, 1, 0, 0)
    table.setName(copyright_line, 0, 1, 0, 0)
    table.setName(version, 5, 1, 0, 0)
    os2 = font['OS/2']
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | 0b1000000  # REGULAR only: no italic, no bold
    font['head'].macStyle = 0
    if 'STAT' in font:
        del font['STAT']


def build(inputs, out_dir):
    by_family = {}
    for path in inputs:
        font = TTFont(path)
        family = family_of(font)
        if not family or 'fvar' not in font:
            sys.exit(f'{path}: not a variable file of Archivo or Martian Mono')
        by_family.setdefault(family, []).append((path, set(font.getBestCmap())))
    os.makedirs(out_dir, exist_ok=True)
    report = []
    for ps_name, (family, wght, wdth, unicodes, family_name) in FACES.items():
        pieces = [p for p, cmap in by_family.get(family, []) if cmap & unicodes]
        if not pieces:
            sys.exit(f'{ps_name}: no input of {family}')
        statics = []
        for i, path in enumerate(pieces):
            static = cut(pin(path, wght, wdth), unicodes)
            tmp = os.path.join(out_dir, f'.{ps_name}.{i}.ttf')
            static.save(tmp)
            statics.append(tmp)
        merged = Merger().merge(statics) if len(statics) > 1 else TTFont(statics[0])
        for tmp in statics:
            os.remove(tmp)
        name_face(merged, ps_name, family_name)
        merged = cut(merged, unicodes)
        target = os.path.join(out_dir, f'{ps_name}.ttf')
        merged.save(target)
        check = TTFont(target)
        assert check['name'].getDebugName(6) == ps_name
        assert all(check['name'].getDebugName(i) for i in (0, 13, 14))
        missing = sorted(c for c in unicodes if c not in check.getBestCmap())
        report.append((ps_name, os.path.getsize(target), len(check.getBestCmap()), len(missing)))
    for ps_name, size, mapped, missing in report:
        print(f'{ps_name}.ttf {size} bytes, {mapped} characters, {missing} of the set not in the face')
    for path in inputs:
        print('input', os.path.basename(path), hashlib.sha256(open(path, 'rb').read()).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ofl-archivo', required=True)
    parser.add_argument('--ofl-martian', required=True)
    parser.add_argument('--out', default=OUT)
    parser.add_argument('inputs', nargs='+')
    args = parser.parse_args()
    node_brotli()
    for path, family, name in ((args.ofl_archivo, 'Archivo', 'OFL-Archivo.txt'),
                               (args.ofl_martian, 'Martian Mono', 'OFL-MartianMono.txt')):
        text = check_ofl(path, family)
        target = os.path.join(args.out, name)
        if os.path.abspath(path) != os.path.abspath(target):
            os.makedirs(args.out, exist_ok=True)
            with open(target, 'w', encoding='utf-8', newline='\n') as f:
                f.write(text)
    build(args.inputs, args.out)


if __name__ == '__main__':
    main()

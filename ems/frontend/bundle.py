#!/usr/bin/env python3
"""gPlug UI build (spec 002 FR-202/206/215/216) — no npm, no bundler.

- Concatenates src/*.js in a fixed order into a single app.js (deterministic:
  same input -> byte-identical output; the /fs?name=... serving on the device
  cannot resolve relative ES imports, hence one file).
- Merges i18n/<lang>.json over i18n/de.json into lang.json; missing keys fall
  back to German with a build warning (UC-203).
- i18n completeness check: fails when a referenced key is missing from
  de.json, warns for unused keys.
- Size budget check: fails when the shipped UI assets exceed the budget.

Usage:
  python3 bundle.py                          # dev: writes ./app.js + ./lang.json
  python3 bundle.py --out BUILD/app.js --lang en --langout BUILD/lang.json \
                    --budget 153600 --extra BUILD/vendor.js BUILD/style.css ...
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# concatenation order — dependencies first (namespace convention: every file
# is an IIFE assigning into window.App)
ORDER = [
    'i18n.js',
    'format.js',
    'api.js',
    'router.js',
    'components.js',
    'charts.js',
    'table.js',
    'shell.js',
    'lib/aggregate.js',
    'lib/csv.js',
    'pages/uebersicht.js',
    'pages/abrechnung.js',
    #'pages/vzev.js',
    #'pages/vzev_member.js',
    'pages/einstellungen.js',
    #'pages/verlauf.js',
    'main.js',
]

# quoted dotted strings with one of these prefixes count as i18n key references
KEY_PREFIXES = (
    'nav', 'state', 'common', 'error', 'banner', 'table', 'page',
    'placeholder', 'tooltip', 'panel', 'hint', 'billing', 'history',
    'settings', 'vzev', 'demo', 'stat', 'action', 'kpi', 'flow',
    'explain', 'tariff', 'comp', 'modbus',
)
# a real key ends in an alphanumeric/underscore; a trailing dot means the
# literal is a dynamic key *prefix* (e.g. 'settings.tab.' + tab) — not a key.
KEY_RE = re.compile(
    r"['\"]((?:" + '|'.join(KEY_PREFIXES) + r")\.[a-z0-9_.]*[a-z0-9_])['\"]"
)
# keys that exist for machinery rather than a t() call site
UNUSED_OK = {'meta.lang'}
# prefixes resolved dynamically at runtime ('state.' + load.state, glossary
# tooltips referenced by later specs) — exempt from the unused warning
UNUSED_OK_PREFIXES = ('state.', 'tooltip.')


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def build_app(out_path=None):
    """Concatenate the src/ modules in ORDER. Returns the combined text; only
    writes app.js when out_path is given (the Vite build owns the shipped JS
    now — see --lang-only, which reuses this purely for the i18n key scan)."""
    parts = []
    for name in ORDER:
        path = os.path.join(HERE, 'src', name)
        if not os.path.exists(path):
            sys.exit(f'bundle.py: missing source file src/{name}')
        parts.append(f'/* === src/{name} === */\n' + read(path).rstrip('\n') + '\n')
    bundle = '\n'.join(parts)
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(bundle)
    return bundle


def check_i18n(bundle, de, quiet=False):
    used = set(KEY_RE.findall(bundle))
    missing = sorted(k for k in used if k not in de)
    unused = sorted(k for k in de if k not in used and k not in UNUSED_OK
                    and not k.startswith(UNUSED_OK_PREFIXES))
    if missing:
        for k in missing:
            print(f'bundle.py: ERROR missing i18n key in de.json: {k}', file=sys.stderr)
        sys.exit(1)
    # Unused keys are informational (a key may simply be waiting for its page);
    # --quiet hides the list so a `make` log is not buried under ~180 lines.
    # Run `python3 bundle.py --lang-only` by hand to see them.
    if quiet:
        return
    for k in unused:
        print(f'bundle.py: warning: unused i18n key in de.json: {k}')


def build_lang(lang, out_path, de, quiet=False):
    merged = dict(de)
    if lang != 'de':
        path = os.path.join(HERE, 'i18n', f'{lang}.json')
        if not os.path.exists(path):
            sys.exit(f'bundle.py: no translation file i18n/{lang}.json')
        overlay = json.loads(read(path))
        missing = sorted(k for k in de if k not in overlay)
        # An untranslated key is a real gap, not noise — report it even when
        # quiet, but as one summary line instead of one line per key.
        if quiet and missing:
            print(f'bundle.py: {len(missing)} key(s) untranslated in '
                  f'{lang}.json — falling back to de')
            missing = []
        for k in missing:
            print(f'bundle.py: warning: {lang}.json missing key {k} — falling back to de')
        merged.update(overlay)
        merged['meta.lang'] = lang
    # deterministic output: sorted keys, no timestamps
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=0, sort_keys=True)
        f.write('\n')


def check_budget(paths, budget):
    total = 0
    rows = []
    for p in paths:
        if p and os.path.exists(p):
            n = os.path.getsize(p)
            total += n
            rows.append((os.path.basename(p), n))
    for name, n in rows:
        print(f'bundle.py:   {name:14s} {n / 1024:7.1f} KB')
    print(f'bundle.py:   {"total":14s} {total / 1024:7.1f} KB (budget {budget / 1024:.0f} KB)')
    if total > budget:
        sys.exit(f'bundle.py: ERROR size budget exceeded: {total} > {budget} bytes')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(HERE, 'app.js'))
    ap.add_argument('--lang', default='de')
    ap.add_argument('--langout', default=os.path.join(HERE, 'lang.json'))
    ap.add_argument('--budget', type=int, default=153600)
    ap.add_argument('--extra', nargs='*', default=None,
                    help='additional shipped assets counted against the budget')
    ap.add_argument('--lang-only', action='store_true',
                    help='only emit lang.json + run the i18n check (Vite owns '
                         'the JS bundle); skips writing app.js and the budget')
    ap.add_argument('--quiet', '-q', action='store_true',
                    help='suppress the informational unused-key list and the '
                         'OK summary (the Makefile uses this); errors and the '
                         'exit code are unaffected')
    args = ap.parse_args()

    de = json.loads(read(os.path.join(HERE, 'i18n', 'de.json')))

    # Concatenate in memory for the i18n key scan; write app.js only in the
    # legacy full-bundle mode.
    bundle = build_app(None if args.lang_only else args.out)
    check_i18n(bundle, de, args.quiet)
    build_lang(args.lang, args.langout, de, args.quiet)

    if args.lang_only:
        if not args.quiet:
            print(f'bundle.py: OK lang-only (lang={args.lang})')
        return

    extra = args.extra
    if extra is None:
        extra = [os.path.join(HERE, n) for n in ('vendor.js', 'style.css', 'index.html')]
    check_budget([args.out, args.langout] + extra, args.budget)
    print(f'bundle.py: OK (lang={args.lang})')


if __name__ == '__main__':
    main()

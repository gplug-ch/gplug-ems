#!/usr/bin/env python3
"""Minify Berry (.be) source files: strip comments and excess whitespace."""
import sys

def strip_comment(line):
    """Remove trailing # comment, skipping # inside string literals."""
    in_str = None
    for i, c in enumerate(line):
        if in_str is None:
            if c == '#':
                return line[:i]
            if c in ('"', "'"):
                in_str = c
        elif c == in_str:
            in_str = None
    return line

def minify(src):
    out = []
    for raw in src.splitlines():
        line = strip_comment(raw).strip()
        # if line != '':
        out.append(line)
    return '\n'.join(out)

if __name__ == '__main__':
    src_path, dst_path = sys.argv[1], sys.argv[2]
    with open(src_path, 'r') as f:
        src = f.read()
    with open(dst_path, 'w') as f:
        f.write(minify(src))

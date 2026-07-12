#!/usr/bin/env python3
"""Prepare a rendered report for Claude Artifact publishing.

The Artifact tool wraps the file in its own <!doctype html>...<head>...<body>
skeleton, so the report's outer document tags must be stripped first (keeping
meta/title/style/content/script). Writes the stripped copy next to the input
as report.artifact.html and prints its path.

Usage: python .qa/artifact_prep.py runs/<run>/report.html
"""
import sys
from pathlib import Path

OUTER_TAGS = ['<!DOCTYPE html>', '<html lang="en">', '<head>', '</head>',
              '<body>', '</body>', '</html>']

def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src_path = Path(sys.argv[1])
    out = src_path.read_text()
    for tag in OUTER_TAGS:
        out = out.replace(tag, '', 1)
    out = out.strip() + '\n'
    for tag in ('<html', '</html>', '<body', '</body>', '<head>', '</head>'):
        if tag in out:
            sys.exit(f'ERROR: leftover {tag} after strip — template outer tags changed?')
    if '<title>' not in out:
        sys.exit('ERROR: no <title> survived the strip')
    dst = src_path.with_suffix('.artifact.html')
    dst.write_text(out)
    print(dst)

if __name__ == '__main__':
    main()

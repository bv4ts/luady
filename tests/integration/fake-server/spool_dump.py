#!/usr/bin/python3
"""Prints every complete line of ~/.luady/spool/events-*.jsonl, oldest file first; partial tails are skipped."""
import glob
import os
import sys

for path in sorted(glob.glob(os.path.expanduser('~/.luady/spool/events-*.jsonl'))):
    with open(path, encoding='utf-8') as fh:
        data = fh.read()
    for line in data.split('\n')[:-1]:
        if line.strip():
            sys.stdout.write(line + '\n')

#!/bin/sh
# Runs the whole kit suite with line coverage and enforces the 80% bar.
set -eu
cd "$(dirname "$0")"
python3 -m coverage erase
python3 -m coverage run --source=luady_kit -m unittest discover -s tests -t . -v
python3 -m coverage report -m --fail-under=80

#!/usr/bin/env python3
"""Install or uninstall the Luady server kit.

Usage: python3 install.py --host-alias cedar [--uninstall] [--skip-settings] [--home /path]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from luady_kit.install import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())

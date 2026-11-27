"""The kb-put verb (kit 2.1): the hub's copy of the knowledge base into ~/luady-kb.

stdin: {"files": [{"path": "orchard/overview.md", "content": "…"}], "prune": true} → {"written": n, "removed": m}

- Paths: relative, forward slashes, at most two folder levels, every segment [A-Za-z0-9._-]{1,80} and not starting
  with a dot (so no `.`, `..`, hidden files or the kit's own temp names), `.md` only; at most 400 files; stdin at
  most 2 MiB.
- Everything is checked before anything is written. ~/luady-kb, and every folder on the way to a target, must be a
  real folder (not a symlink) that resolves inside ~/luady-kb; otherwise the verb is refused and writes nothing.
- Each file is written to a temp name in its folder and renamed (an existing symlink at a target is replaced, never
  followed). Folders 0700, files 0600: only this user reads the knowledge base. A folder an older kit made 0755 loses
  its group and other bits at the next put.
- prune: every .md file under ~/luady-kb that is not in the set is removed, then the empty folders. Symlinked
  folders inside are never entered.
"""
from __future__ import annotations

import contextlib
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import common
from .common import CtlError

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

KB_DIR = 'luady-kb'
MAX_FILES = 400
MAX_BYTES = 2 * 1024 * 1024
MAX_FOLDERS = 2
SEGMENT_RE = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}', re.ASCII)
FOLDER_MODE = 0o700
FILE_MODE = 0o600


def kb_root(paths: common.KitPaths) -> Path:
    return paths.home / KB_DIR


def check_path(value: Any) -> tuple[str, ...]:
    """The segments of a valid knowledge-base path; CtlError('usage') otherwise."""
    if not isinstance(value, str):
        raise CtlError('usage', 'every file needs a string "path"')
    segments = tuple(value.split('/'))
    if not all(common.matches(SEGMENT_RE, segment) for segment in segments):
        raise CtlError('usage', f'invalid path {value!r}: relative, forward slashes, segments [A-Za-z0-9._-]{{1,80}} '
                                'not starting with a dot')
    if len(segments) > MAX_FOLDERS + 1:
        raise CtlError('usage', f'invalid path {value!r}: at most {MAX_FOLDERS} folder levels')
    if not segments[-1].endswith('.md'):
        raise CtlError('usage', f'invalid path {value!r}: only .md files')
    return segments


def parse_body(body: Any) -> tuple[dict[tuple[str, ...], bytes], bool]:
    if not isinstance(body, dict) or not isinstance(body.get('files'), list):
        raise CtlError('usage', 'expected {"files": [{"path", "content"}], "prune": boolean}')
    prune = body.get('prune', False)
    if not isinstance(prune, bool):
        raise CtlError('usage', '"prune" must be true or false')
    if len(body['files']) > MAX_FILES:
        raise CtlError('usage', f'{len(body["files"])} files, over the {MAX_FILES} file limit')
    files: dict[tuple[str, ...], bytes] = {}
    for item in body['files']:
        if not isinstance(item, dict) or not isinstance(item.get('content'), str):
            raise CtlError('usage', 'every file needs a string "path" and a string "content"')
        segments = check_path(item.get('path'))
        if segments in files:
            raise CtlError('usage', f'duplicate path {"/".join(segments)!r}')
        files[segments] = item['content'].encode('utf-8', 'replace')
    return files, prune


def _inside(path: Path, root_real: str) -> bool:
    real = os.path.realpath(path)
    return real == root_real or real.startswith(root_real + os.sep)


def _check_folder(path: Path, root_real: str) -> None:
    """An existing folder on the way to a target must be a real folder inside the root (a missing one is made)."""
    if path.is_symlink():
        raise CtlError('refused', f'{path} is a symlink; nothing was written')
    if path.exists() and (not path.is_dir() or not _inside(path, root_real)):
        raise CtlError('refused', f'{path} is not a folder inside {KB_DIR}; nothing was written')


def check_targets(root: Path, files: dict[tuple[str, ...], bytes]) -> None:
    if root.is_symlink():
        raise CtlError('refused', f'{root} is a symlink; nothing was written')
    if root.exists() and not root.is_dir():
        raise CtlError('refused', f'{root} is not a folder; nothing was written')
    root_real = os.path.realpath(root)
    for segments in files:
        for depth in range(1, len(segments)):
            _check_folder(root.joinpath(*segments[:depth]), root_real)
        target = root.joinpath(*segments)
        if target.exists() and not target.is_symlink() and not target.is_file():
            raise CtlError('refused', f'{target} exists and is not a file; nothing was written')


def _make_folder(path: Path) -> None:
    if not path.is_dir():
        path.mkdir(mode=FOLDER_MODE)
        os.chmod(path, FOLDER_MODE)  # mkdir's mode is cut by the umask
        return
    common.close_to_others(path)


def write_files(root: Path, files: dict[tuple[str, ...], bytes]) -> int:
    _make_folder(root)
    for segments, data in sorted(files.items()):
        for depth in range(1, len(segments)):
            _make_folder(root.joinpath(*segments[:depth]))
        common.atomic_write_bytes(root.joinpath(*segments), data, FILE_MODE)
    return len(files)


def prune(root: Path, keep: set[tuple[str, ...]]) -> int:
    removed = 0
    for current, dirs, names in os.walk(root, topdown=False, followlinks=False):
        folder = Path(current)
        relative = folder.relative_to(root).parts
        for name in names:
            if name.endswith('.md') and (*relative, name) not in keep:
                (folder / name).unlink(missing_ok=True)
                removed += 1
        if folder != root:
            with contextlib.suppress(OSError):  # not empty: left in place
                folder.rmdir()
    return removed


def cmd_kb_put(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    files, should_prune = parse_body(kit_io.read_json(MAX_BYTES))
    root = kb_root(ctx.paths)
    check_targets(root, files)
    written = write_files(root, files)
    removed = prune(root, set(files)) if should_prune else 0
    return {'written': written, 'removed': removed}

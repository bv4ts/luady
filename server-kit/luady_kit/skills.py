"""The skills verb (kit 2.1): the Claude Code skills installed on this server.

Sources, in this order:
- user: ~/.claude/skills/*/SKILL.md (entries are often symlinks into ~/.agents/skills; followed one level, never
  recursed, so a link loop cannot hang the verb);
- project: <projects root>/<repo>/.claude/skills/*/SKILL.md for the repos the projects verb finds;
- plugin: skills/*/SKILL.md of installed plug-ins below ~/.claude/plugins (marketplace catalogues are skipped: they
  hold plug-ins that are not installed). A plug-in cached in several versions lists each skill once, the newest
  SKILL.md by modification time.

name and description come from the YAML front matter, parsed without a YAML library.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

from . import common
from .projects import find_repos

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

MAX_SKILLS = 300
DESCRIPTION_MAX = 300
NAME_MAX = 120
SKILL_FILE = 'SKILL.md'
SKILL_READ_MAX = 64 * 1024
PLUGIN_SKILLS_MAX_DEPTH = 6  # depth of a `skills` folder below ~/.claude/plugins (cache/<mkt>/<plugin>/<ver>/skills = 5)
PLUGIN_SKIPPED = frozenset({'marketplaces', 'node_modules', '.git'})
PLUGIN_WALK_MAX_DIRS = 20000
BLOCK_INDICATOR = re.compile(r'[>|][+-]?[0-9]?')
KEY_LINE = re.compile(r'([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$')
WHITESPACE = re.compile(r'\s+')


# --- front matter ---------------------------------------------------------------------------------------------

def _front_lines(text: str) -> list[str] | None:
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    if not lines or lines[0].strip() != '---':
        return None
    for index in range(1, len(lines)):
        if lines[index].strip() in ('---', '...'):
            return lines[1:index]
    return None


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == value[-1] == '"':
        inner = value[1:-1]
        try:
            decoded = json.loads(f'"{inner}"')
            return decoded if isinstance(decoded, str) else inner
        except ValueError:
            return inner.replace('\\"', '"')
    return value


def _block(indicator: str, body: list[str]) -> str:
    """A folded (>) or literal (|) block scalar from its indented lines."""
    stripped = [line.strip() for line in body]
    while stripped and not stripped[-1]:
        stripped.pop()
    if indicator.startswith('|'):
        return '\n'.join(stripped)
    out, paragraph = [], []
    for line in stripped:
        if line:
            paragraph.append(line)
        else:
            out.append(' '.join(paragraph))
            paragraph = []
    out.append(' '.join(paragraph))
    return '\n'.join(part for part in out if part)


def parse_front_matter(text: str) -> dict[str, str]:
    """Top-level `key: value` pairs of the front matter: plain, quoted, plain continued on indented lines, or a
    folded/literal block scalar. {} when there is no closed front matter."""
    lines = _front_lines(text)
    if lines is None:
        return {}
    result: dict[str, str] = {}
    index = 0
    while index < len(lines):
        match = KEY_LINE.match(lines[index]) if lines[index][:1] not in ('', ' ', '\t', '#', '-') else None
        index += 1
        if match is None:
            continue
        key, value = match.group(1), (match.group(2) or '').strip()
        body: list[str] = []
        while index < len(lines) and (not lines[index].strip() or lines[index][:1] in (' ', '\t')):
            body.append(lines[index])
            index += 1
        if BLOCK_INDICATOR.fullmatch(value):
            result[key] = _block(value, body)
        else:
            extra = ' '.join(line.strip() for line in body if line.strip())
            result[key] = _unquote(' '.join(part for part in (value, extra) if part))
    return result


# --- reading skills ---------------------------------------------------------------------------------------------

def _one_line(text: str) -> str:
    return WHITESPACE.sub(' ', text).strip()


def read_skill(path: Path, source: str) -> dict[str, Any] | None:
    """One SkillDTO row, or None when SKILL.md cannot be read."""
    try:
        with open(path, 'rb') as handle:
            raw = handle.read(SKILL_READ_MAX)
    except OSError:
        return None
    meta = parse_front_matter(raw.decode('utf-8', 'replace'))
    name = _one_line(meta.get('name', '')) or path.parent.name
    description = _one_line(meta.get('description', ''))
    return {'name': common.truncate_chars(name, NAME_MAX)[0],
            'description': common.truncate_chars(description, DESCRIPTION_MAX)[0] if description else '',
            'source': source, 'path': str(path)}


def _skill_files(folder: Path) -> list[Path]:
    """<folder>/*/SKILL.md, sorted; entries may be symlinks to folders (followed, not recursed)."""
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        return []
    found = []
    for entry in entries:
        candidate = entry / SKILL_FILE
        try:
            if entry.is_dir() and candidate.is_file():
                found.append(candidate)
        except OSError:  # a link loop or an unreadable entry
            continue
    return found


def user_skills(paths: common.KitPaths) -> list[dict[str, Any]]:
    rows = (read_skill(path, 'user') for path in _skill_files(paths.home / '.claude' / 'skills'))
    return [row for row in rows if row is not None]


def project_skills(projects_root: str) -> list[dict[str, Any]]:
    rows = []
    for repo in find_repos(Path(projects_root)):
        rows.extend(read_skill(path, 'project') for path in _skill_files(repo / '.claude' / 'skills'))
    return [row for row in rows if row is not None]


def _plugin_skill_dirs(root: Path) -> Iterator[Path]:
    """Every `skills` folder below root, at most PLUGIN_SKILLS_MAX_DEPTH deep. Symlinked folders are not entered."""
    visited = 0
    for current, dirs, _files in os.walk(root, followlinks=False):
        visited += 1
        if visited > PLUGIN_WALK_MAX_DIRS:
            return
        depth = len(Path(current).relative_to(root).parts)
        keep = depth < PLUGIN_SKILLS_MAX_DEPTH - 1
        dirs[:] = sorted(d for d in dirs if d not in PLUGIN_SKIPPED and d != 'skills') if keep else []
        if (Path(current) / 'skills').is_dir() and depth < PLUGIN_SKILLS_MAX_DEPTH:
            yield Path(current) / 'skills'


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def plugin_skills(paths: common.KitPaths) -> list[dict[str, Any]]:
    """Plug-in skills; the same plug-in (the folder above its version folder) lists a skill name once, newest first."""
    best: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
    for skills_dir in _plugin_skill_dirs(paths.home / '.claude' / 'plugins'):
        plugin_key = str(skills_dir.parent.parent)
        for path in _skill_files(skills_dir):
            row = read_skill(path, 'plugin')
            if row is None:
                continue
            key, moment = (plugin_key, row['name']), _mtime(path)
            if key not in best or moment > best[key][0]:
                best[key] = (moment, row)
    return sorted((row for _moment, row in best.values()), key=lambda row: (row['name'], row['path']))


def cmd_skills(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    rows = [*user_skills(ctx.paths), *project_skills(ctx.projects_root), *plugin_skills(ctx.paths)]
    return {'skills': rows[:MAX_SKILLS]}

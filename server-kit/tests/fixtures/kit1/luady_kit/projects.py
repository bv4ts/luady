"""The projects verb: git repositories under the projects root (depth <= 2), with remote, branch, the last 5
commits and stack markers."""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from . import common

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

STACK_MARKERS: tuple[tuple[str, str], ...] = (
    ('package.json', 'node'), ('next.config.*', 'next'), ('composer.json', 'php'), ('artisan', 'laravel'),
    ('pubspec.yaml', 'flutter'), ('requirements.txt', 'python'), ('pyproject.toml', 'python'),
    ('Dockerfile', 'docker'),
)
GIT_TIMEOUT_SECONDS = 10.0
Runner = Callable[..., common.RunResult]


def _subdirs(directory: Path) -> list[Path]:
    try:
        return sorted(path for path in directory.iterdir() if path.is_dir() and not path.name.startswith('.'))
    except OSError:
        return []


def _is_repo(path: Path) -> bool:
    return (path / '.git').exists()


def find_repos(root: Path) -> list[Path]:
    """Repos at depth 1, plus repos at depth 2 inside folders that are not repos themselves."""
    repos: list[Path] = []
    for first in _subdirs(root):
        repos.extend([first] if _is_repo(first) else [second for second in _subdirs(first) if _is_repo(second)])
    return sorted(repos)


def _git(run: Runner, repo: Path, *args: str) -> str | None:
    result = run(['git', '-C', str(repo), *args], timeout=GIT_TIMEOUT_SECONDS)
    text = result.text.strip()
    return text if result.code == 0 and text else None


def _commits(run: Runner, repo: Path) -> list[dict[str, str]]:
    raw = _git(run, repo, 'log', '-5', '--format=%H%x1f%cI%x1f%s') or ''
    rows = [line.split('\x1f', 2) for line in raw.splitlines()]
    return [{'hash': row[0], 'date': row[1], 'subject': row[2]} for row in rows if len(row) == 3]


def stack_of(repo: Path) -> list[str]:
    found: list[str] = []
    for pattern, tag in STACK_MARKERS:
        if tag not in found and any(repo.glob(pattern)):
            found.append(tag)
    return found


def project_info(repo: Path, run: Runner) -> dict[str, Any]:
    return {'path': str(repo), 'name': repo.name, 'remote': _git(run, repo, 'remote', 'get-url', 'origin'),
            'branch': _git(run, repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'commits': _commits(run, repo),
            'stack': stack_of(repo)}


def cmd_projects(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    return {'projects': [project_info(repo, ctx.run) for repo in find_repos(Path(ctx.projects_root))]}

"""The git-status verb (kit 2.1): branch, local changes, ahead/behind and last commit time of every project.

Offline only: `git status --porcelain=v2 --branch` and `git log -1 --format=%cI`, never a fetch. Remote names and URLs
are never printed. A repo gets at most 5 seconds, the whole verb 25; a repo that fails, times out or is not reached
in time is listed with nulls.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from . import common
from .projects import find_repos

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

REPO_TIMEOUT_SECONDS = 5.0
TOTAL_TIMEOUT_SECONDS = 25.0
MIN_CALL_SECONDS = 0.05
# --no-optional-locks: status never takes index.lock (a session's own git commands are not disturbed). The repo's own
# config never starts a program: no fsmonitor hook for status, no signature program for log.
GIT = (*common.GIT, '--no-optional-locks', '-c', 'core.fsmonitor=false')
Runner = Callable[..., common.RunResult]


def parse_status(text: str) -> dict[str, Any]:
    """branch, dirty (changed + untracked entries), ahead, behind from porcelain v2 output."""
    branch, ahead, behind, dirty = None, None, None, 0
    for line in text.splitlines():
        if line.startswith('# branch.head '):
            head = line[len('# branch.head '):].strip()
            branch = None if head == '(detached)' or not head else head
        elif line.startswith('# branch.ab '):
            parts = line.split()
            if len(parts) == 4 and parts[2][1:].isdigit() and parts[3][1:].isdigit():
                ahead, behind = int(parts[2][1:]), int(parts[3][1:])
        elif line and not line.startswith('#'):
            dirty += 1
    return {'branch': branch, 'dirty': dirty, 'ahead': ahead, 'behind': behind}


def _empty(repo: Path) -> dict[str, Any]:
    return {'path': str(repo), 'name': repo.name, 'branch': None, 'dirty': None, 'ahead': None, 'behind': None,
            'lastCommitAt': None}


def repo_status(repo: Path, run: Runner, monotonic: Callable[[], float], deadline: float) -> dict[str, Any]:
    row = _empty(repo)
    start = monotonic()
    budget_end = min(start + REPO_TIMEOUT_SECONDS, deadline)

    def remaining() -> float:
        return budget_end - monotonic()

    if remaining() < MIN_CALL_SECONDS:
        return row
    status = run([*GIT, '-C', str(repo), 'status', '--porcelain=v2', '--branch'], timeout=remaining())
    if status.code != 0 or status.timed_out:
        return row
    row.update(parse_status(status.text))
    if remaining() < MIN_CALL_SECONDS:
        return row
    log = run([*GIT, '-C', str(repo), 'log', '-1', '--format=%cI'], timeout=remaining())
    stamp = log.text.strip() if log.code == 0 and not log.timed_out else ''
    row['lastCommitAt'] = stamp or None
    return row


def cmd_git_status(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    deadline = ctx.monotonic() + TOTAL_TIMEOUT_SECONDS
    repos = find_repos(Path(ctx.projects_root))
    return {'projects': [repo_status(repo, ctx.run, ctx.monotonic, deadline) for repo in repos]}

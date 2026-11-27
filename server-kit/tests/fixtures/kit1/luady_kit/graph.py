"""graphify verbs of luady-ctl: nightly code maps (no LLM, no tokens) and queries against them."""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .common import CtlError

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

GRAPHIFY_REL = '.local/bin/graphify'
OUT_DIR = 'graphify-out'
REPORT = 'GRAPH_REPORT.md'
MEMORY_MAX = '3G'
QUESTION_MAX = 2000
REPORT_HEAD_MAX = 12000
OUTPUT_TAIL_LINES = 6
QUERY_GRACE_SECONDS = 120
# Summary sections of GRAPH_REPORT.md worth keeping in the brain; the long per-community lists are left out.
REPORT_SECTIONS = ('Corpus Check', 'Summary', 'God Nodes', 'Surprising Connections', 'Import Cycles')


def _graphify(ctx: 'Ctx') -> str:
    path = Path(ctx.paths.home) / GRAPHIFY_REL
    if not path.is_file():
        raise CtlError('not_found', f'graphify is not installed at {path}')
    return str(path)


def _project_dir(ctx: 'Ctx', raw: str) -> str:
    real = os.path.realpath(raw)
    root = os.path.realpath(ctx.projects_root)
    if not real.startswith(root + os.sep):
        raise CtlError('refused', f'{raw} is outside {ctx.projects_root}')
    if not os.path.isdir(real):
        raise CtlError('not_found', f'no such project directory: {raw}')
    return real


def _clean_env(ctx: 'Ctx') -> list[str]:
    """No API keys and no `claude` on PATH, so graphify can never spend tokens."""
    return ['env', '-i', f'HOME={ctx.paths.home}', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8']


def _exclude_output(ctx: 'Ctx', project: str) -> None:
    """Keep graphify-out/ out of `git status` via the repo's own info/exclude (created when the clone lacks it)."""
    found = ctx.run(['git', '-C', project, 'rev-parse', '--git-path', 'info/exclude'], timeout=10)
    if found.code != 0 or not found.text.strip():
        return
    exclude = Path(found.text.strip())
    if not exclude.is_absolute():
        exclude = Path(project) / exclude
    exclude.parent.mkdir(parents=True, exist_ok=True)
    current = exclude.read_text(encoding='utf-8') if exclude.exists() else ''
    if any(line.strip() in (OUT_DIR, OUT_DIR + '/') for line in current.splitlines()):
        return
    with exclude.open('a', encoding='utf-8') as handle:
        handle.write(('' if current.endswith('\n') or not current else '\n') + OUT_DIR + '/\n')


def report_summary(text: str) -> str:
    """Title plus the summary sections of a graphify report, capped at REPORT_HEAD_MAX characters."""
    lines = text.splitlines()
    kept: list[str] = lines[:1]
    keep = False
    for line in lines[1:]:
        if line.startswith('## '):
            keep = any(line[3:].startswith(name) for name in REPORT_SECTIONS)
        if keep:
            kept.append(line)
    summary = '\n'.join(kept).strip() + '\n'
    return summary if len(summary) <= REPORT_HEAD_MAX else summary[:REPORT_HEAD_MAX] + '\n…(cut)\n'


def cmd_graphify_run(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    """`graphify update <project>` under nice/ionice and a 3 GB memory cap; returns the report summary."""
    project = _project_dir(ctx, ns.path)
    graphify = _graphify(ctx)
    _exclude_output(ctx, project)
    argv = [*_clean_env(ctx), 'nice', '-n', '19', 'ionice', '-c3', graphify, 'update', project]
    if shutil.which('systemd-run'):
        argv = ['systemd-run', '--user', '--scope', '--quiet', '-p', f'MemoryMax={MEMORY_MAX}', *argv]
    started = ctx.monotonic()
    result = ctx.run(argv, timeout=ns.timeout, cwd=project)
    seconds = round(ctx.monotonic() - started, 1)
    tail = '\n'.join((result.text + result.stderr.decode('utf-8', 'replace')).strip().splitlines()[-OUTPUT_TAIL_LINES:])
    if result.timed_out:
        raise CtlError('timeout', f'graphify took longer than {ns.timeout}s on {project}')
    if result.code != 0:
        raise CtlError('failed', f'graphify exited with {result.code}: {tail[-500:]}')
    report = Path(project) / OUT_DIR / REPORT
    summary = report_summary(report.read_text(encoding='utf-8', errors='replace')) if report.is_file() else ''
    return {'path': project, 'seconds': seconds, 'report': summary, 'tail': tail}


def cmd_graph_query(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    """`graphify query` over a project's code map; the question travels on stdin."""
    question = kit_io.read_text(QUESTION_MAX * 4).strip()
    if not question:
        raise CtlError('usage', 'question on stdin is empty')
    if len(question) > QUESTION_MAX:
        raise CtlError('usage', f'question is longer than {QUESTION_MAX} characters')
    project = _project_dir(ctx, ns.path)
    graph = Path(project) / OUT_DIR / 'graph.json'
    if not graph.is_file():
        raise CtlError('not_found', f'no code map for {project} yet (graphify runs nightly)')
    argv = [*_clean_env(ctx), _graphify(ctx), 'query', question, '--graph', str(graph), '--budget', str(ns.budget)]
    result = ctx.run(argv, timeout=QUERY_GRACE_SECONDS, cwd=project)
    if result.timed_out:
        raise CtlError('timeout', 'graphify query timed out')
    if result.code != 0:
        raise CtlError('failed', f'graphify query exited with {result.code}: {result.stderr.decode("utf-8", "replace")[-300:]}')
    built = time.strftime('%Y-%m-%d %H:%M', time.gmtime(graph.stat().st_mtime))
    return {'path': project, 'built_at': built, 'text': result.text.strip()}

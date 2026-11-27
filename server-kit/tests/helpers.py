"""Shared test helpers: per-test temporary homes, polling and spool reading."""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Callable

from luady_kit import common


class HomeTestCase(unittest.TestCase):
    """Each test gets a fresh temporary home with the ~/.luady runtime directories."""

    def setUp(self) -> None:
        super().setUp()
        self._home_dir = tempfile.TemporaryDirectory(prefix='luadyhome-', ignore_cleanup_errors=True)
        self.home = Path(self._home_dir.name)
        self.paths = common.KitPaths(self.home)
        common.ensure_runtime_dirs(self.paths)

    def tearDown(self) -> None:
        self._home_dir.cleanup()
        super().tearDown()

    def mark_hub_listening(self, age: float = 0.0) -> None:
        """As tail-events does at every heartbeat: the hooks then wait for a remote answer (unless `age` makes it stale)."""
        common.touch_tail_alive(self.paths, time.time() - age)

    def write_config(self, **values: Any) -> None:
        common.atomic_write_json(self.paths.config_file, {**common.default_config('test'), **values})

    def spool_events(self) -> list[dict[str, Any]]:
        return read_spool(self.paths)


def wait_until(predicate: Callable[[], bool], timeout: float = 10.0, interval: float = 0.05) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(f'condition not met within {timeout} s')


def read_spool(paths: common.KitPaths) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for path in sorted(paths.spool.glob('events-*.jsonl')):
        lines = path.read_text(encoding='utf-8').splitlines()
        events.extend(json.loads(line) for line in lines if line.strip())
    return events

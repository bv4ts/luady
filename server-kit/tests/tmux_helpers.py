"""Isolated tmux servers and the fake claude for kit tests (Docker only)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from tests.helpers import HomeTestCase, wait_until

FAKES = Path(__file__).resolve().parent / 'fakes'
KIT_ROOT = Path(__file__).resolve().parent.parent


def install_kit_hooks(home: Path) -> None:
    """server-kit/hooks/* into ~/.luady/hooks/, and ~/.luady/lib/luady_kit pointing at the source, as install.py lays out."""
    hooks = home / '.luady' / 'hooks'
    hooks.mkdir(parents=True, exist_ok=True)
    for source in sorted((KIT_ROOT / 'hooks').iterdir()):
        target = hooks / source.name
        target.write_bytes(source.read_bytes().replace(b'\r\n', b'\n'))
        target.chmod(0o755)
    lib = home / '.luady' / 'lib'
    lib.mkdir(parents=True, exist_ok=True)
    if not (lib / 'luady_kit').exists():
        (lib / 'luady_kit').symlink_to(KIT_ROOT / 'luady_kit', target_is_directory=True)


def install_fake_claude(home: Path) -> Path:
    bin_dir = home / '.local' / 'bin'
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name in ('claude', 'fake_claude.py'):
        target = bin_dir / name
        target.write_bytes((FAKES / name).read_bytes().replace(b'\r\n', b'\n'))
        target.chmod(0o755)
    return bin_dir / 'claude'


def fake_log(cwd: Path) -> list[dict[str, Any]]:
    path = cwd / '.fake_claude.jsonl'
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def submits(cwd: Path) -> list[str]:
    return [event['text'] for event in fake_log(cwd) if event['type'] == 'submit']


def wait_for_event(cwd: Path, predicate: Callable[[dict[str, Any]], bool], timeout: float = 10.0) -> None:
    wait_until(lambda: any(predicate(event) for event in fake_log(cwd)), timeout)


def tmux(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['tmux', *args], capture_output=True, text=True)


class TmuxTestCase(HomeTestCase):
    """A fresh tmux server per test (own TMUX_TMPDIR) whose panes see HOME=<temp home>, plus the fake claude."""

    def setUp(self) -> None:
        super().setUp()
        self.claude = install_fake_claude(self.home)
        install_kit_hooks(self.home)
        self.projects = self.home / 'projects'
        self.projects.mkdir()
        self._tmux_dir = tempfile.mkdtemp(prefix='luadytmux-')
        self._saved_env = {key: os.environ.get(key) for key in ('TMUX_TMPDIR', 'TMUX')}
        os.environ['TMUX_TMPDIR'] = self._tmux_dir
        os.environ.pop('TMUX', None)
        subprocess.run(['tmux', '-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '-x', '200', '-y', '50'],
                       env={**os.environ, 'HOME': str(self.home)}, check=True)

    def tearDown(self) -> None:
        tmux('kill-server')
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self._tmux_dir, ignore_errors=True)
        super().tearDown()

    def project(self, name: str) -> Path:
        path = self.projects / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def start_claude_pane(self, session: str, cwd: Path, *args: str) -> str:
        subprocess.run(['tmux', 'new-session', '-d', '-s', session, '-c', str(cwd), '--', str(self.claude), *args],
                       check=True)
        wait_for_event(cwd, lambda event: event['type'] == 'ready')
        time.sleep(0.3)
        return f'{session}:0.0'

    def pane_pid(self, target: str) -> int:
        return int(tmux('display-message', '-p', '-t', f'={target}', '#{pane_pid}').stdout.strip())

    def session_exists(self, name: str) -> bool:
        return tmux('has-session', '-t', f'={name}').returncode == 0

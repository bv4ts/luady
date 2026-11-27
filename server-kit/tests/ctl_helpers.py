"""Helpers to run luady-ctl in-process with an injected context."""
from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any, Mapping

from luady_kit import common, ctl


def make_ctx(home: Path, **overrides: Any) -> ctl.Ctx:
    base = {'paths': common.KitPaths(home), 'projects_root': str(home / 'projects')}
    return ctl.Ctx(**{**base, **overrides})


def fast_ctx(home: Path, **overrides: Any) -> ctl.Ctx:
    """A context whose clock runs 20x faster, so 10-20 s grace periods take about a second."""
    timing = {'sleep': lambda seconds: time.sleep(min(seconds, 0.05)), 'monotonic': lambda: time.monotonic() * 20}
    return make_ctx(home, **{**timing, **overrides})


def run_ctl(ctx: ctl.Ctx, *argv: str, stdin: bytes = b'',
            handlers: Mapping[str, Any] | None = None) -> tuple[int, Any]:
    out = io.BytesIO()
    code = ctl.main(list(argv), stdin=io.BytesIO(stdin), stdout=out, ctx=ctx, handlers=handlers)
    lines = [line for line in out.getvalue().decode('utf-8').splitlines() if line.strip()]
    return code, (json.loads(lines[-1]) if lines else None)


def raw_ctl(ctx: ctl.Ctx, *argv: str, stdin: bytes = b'') -> tuple[int, str]:
    out = io.BytesIO()
    code = ctl.main(list(argv), stdin=io.BytesIO(stdin), stdout=out, ctx=ctx)
    return code, out.getvalue().decode('utf-8')

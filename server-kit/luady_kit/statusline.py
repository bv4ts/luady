"""The Claude Code status line of kit 2: show a short line and forward context and plan-limit meters on change.

Claude Code runs it at start and once per turn (also in detached tmux), with the status JSON on stdin. A plan
window can be missing on any plan, and the first call (before any reply) has no `rate_limits` at all.
An owner's own status line is kept: the installer saves it to state/statusline-chain.json and this script runs it
with the same input and prints its output instead of the short line.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from typing import Any, BinaryIO, Mapping

from . import common, hook
from .redact import cut_utf16, redact

FORWARD_SECONDS = 60
CHAIN_TIMEOUT_SECONDS = 2.0
STDIN_MAX_BYTES = 4 * 1024 * 1024
MODEL_MAX = 64
WINDOWS = ('five_hour', 'seven_day')
WINDOW_LABELS = {'five_hour': '5h', 'seven_day': '7d'}
RESETS_AT_MAX = 10 ** 11  # Unix seconds; anything later is not a real reset time


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def _pct(value: Any) -> float | None:
    number = _number(value)
    return None if number is None else min(100, max(0, number))


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _window(raw: Any) -> dict[str, Any] | None:
    window = _mapping(raw)
    used, resets = _pct(window.get('used_percentage')), _number(window.get('resets_at'))
    if used is None or resets is None or not 0 < resets < RESETS_AT_MAX:
        return None
    moment = datetime.fromtimestamp(resets, timezone.utc)
    return {'used_pct': used, 'resets_at': moment.strftime('%Y-%m-%dT%H:%M:%SZ')}


def _model(raw: Any) -> str | None:
    model = raw if isinstance(raw, str) else (_mapping(raw).get('display_name') or _mapping(raw).get('id'))
    if not isinstance(model, str) or not model.strip():
        return None
    return cut_utf16(redact(model.strip()), MODEL_MAX)[0]


def read_meters(payload: Any) -> dict[str, Any]:
    """Exactly the keys of the `meters` event data; a missing or malformed value is None."""
    data = _mapping(payload)
    cost = _number(_mapping(data.get('cost')).get('total_cost_usd'))
    rates = _mapping(data.get('rate_limits'))
    return {'context_pct': _pct(_mapping(data.get('context_window')).get('used_percentage')),
            'model': _model(data.get('model')),
            'cost_usd': None if cost is None else max(0, cost),
            'five_hour': _window(rates.get('five_hour')),
            'seven_day': _window(rates.get('seven_day'))}


def _whole(value: Any) -> int | None:
    number = _number(value)
    return None if number is None else math.floor(number)


def _signature(meters: Mapping[str, Any]) -> tuple[Any, ...]:
    """What makes a change worth sending at once: whole percentages, the model and the reset times."""
    windows = [_mapping(meters.get(name)) if meters.get(name) is not None else None for name in WINDOWS]
    parts: list[Any] = [_whole(meters.get('context_pct')), meters.get('model')]
    for window in windows:
        parts.append(None if window is None else (_whole(window.get('used_pct')), window.get('resets_at')))
    return tuple(parts)


def should_forward(prev: Mapping[str, Any] | None, cur: Mapping[str, Any], now_ts: float) -> bool:
    if not isinstance(prev, Mapping):
        return True
    if _signature(prev) != _signature(cur):
        return True
    sent_at = _number(prev.get('sent_at'))
    changed = any(prev.get(key) != cur.get(key) for key in cur)
    return changed and (sent_at is None or now_ts - sent_at >= FORWARD_SECONDS)


def _percent(value: float) -> str:
    return f'{int(value + 0.5)}%'


def short_line(meters: Mapping[str, Any]) -> str:
    """'Opus · ctx 41% · 5h 12% · 7d 30%': only the parts that are known; 'Claude' when nothing is."""
    parts = [meters.get('model') or 'Claude']
    if _number(meters.get('context_pct')) is not None:
        parts.append(f'ctx {_percent(meters["context_pct"])}')
    for name in WINDOWS:
        window = meters.get(name)
        if isinstance(window, Mapping) and _number(window.get('used_pct')) is not None:
            parts.append(f'{WINDOW_LABELS[name]} {_percent(window["used_pct"])}')
    return ' · '.join(parts)


def chained_output(paths: common.KitPaths, raw: bytes) -> bytes | None:
    """What the owner's own status line prints for this input; None when there is none, or it failed or hung."""
    saved = common.read_json_or_none(paths.statusline_chain)
    command = saved.get('command') if isinstance(saved, dict) else None
    if not isinstance(command, str) or not command.strip():
        return None
    result = common.run_process(['sh', '-c', command], input_bytes=raw, timeout=CHAIN_TIMEOUT_SECONDS)
    if result.timed_out or (result.code != 0 and not result.stdout.strip()):
        return None
    return result.stdout


def forward(env: hook.HookEnv, payload: Mapping[str, Any], meters: dict[str, Any]) -> None:
    sid = payload.get('session_id')
    if not common.matches(common.SID_RE, sid):
        return
    path = env.paths.meters / f'{sid}.json'
    prev = common.read_json_or_none(path)
    now_ts = env.now().timestamp()
    if not should_forward(prev if isinstance(prev, dict) else None, meters, now_ts):
        return
    target = hook.event_target(env, sid)
    hook.append(env, common.load_config(env.paths), 'meters', hook.event_meta(payload, target), meters)
    env.paths.meters.mkdir(mode=0o700, parents=True, exist_ok=True)
    common.atomic_write_json(path, {**meters, 'sent_at': now_ts})


def _parse(raw: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw.decode('utf-8'))
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def main(*, stdin: BinaryIO | None = None, stdout: BinaryIO | None = None, env: hook.HookEnv | None = None) -> int:
    """Status-line entrypoint: print first (a spool problem never blanks the line), then forward. Always 0."""
    hook_env = env if env is not None else hook.default_env()
    out = stdout if stdout is not None else sys.stdout.buffer
    payload: dict[str, Any] = {}
    try:
        raw = (stdin if stdin is not None else sys.stdin.buffer).read(STDIN_MAX_BYTES)
        payload = _parse(raw)
        meters = read_meters(payload)
        text = chained_output(hook_env.paths, raw)
        out.write(text if text is not None else short_line(meters).encode('utf-8'))
        out.flush()
        forward(hook_env, payload, meters)
    except BaseException as exc:  # noqa: BLE001 - the status line must never break the session
        common.log_hook_error(hook_env.paths, f'status line failed: {type(exc).__name__}: {exc}')
    return 0

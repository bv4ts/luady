#!/usr/bin/env python3
"""PreToolUse gate for Luady's brain: prompts are written only after reading the skill for them.

session_start, and a session_send long enough to be new work, are refused (exit 2, the reason goes back to Luady)
until this conversation has a Read of skills/cc-prompt/SKILL.md after its last compaction; image_generate likewise
needs skills/image-prompt/SKILL.md. A skill file that does not exist is not required, and any failure of the gate
itself lets the call through: it must never stop Luady from working.
"""
import json
import os
import sys

SKILL = 'skills/cc-prompt/SKILL.md'
IMAGE_SKILL = 'skills/image-prompt/SKILL.md'
# A session_send this short is a follow-up (an answer, "continue", a correction), not a new task.
FOLLOW_UP_MAX = 600
SESSION_TOOLS = {'mcp__hub__session_start', 'mcp__hub__session_send'}
IMAGE_TOOL = 'mcp__hub__image_generate'
SESSION_REASON = (f'Before writing a new task for a session, Read {SKILL} (once per conversation) and write the prompt by it: '
                  'objective, context, done when, scope, stop-and-ask, verify and report. Then call this tool again.')
IMAGE_REASON = (f'Before making an image, Read {IMAGE_SKILL} (once per conversation) and write the prompt and references '
                'by it. Then call this tool again.')


def brain_dir() -> str:
    return os.environ.get('CLAUDE_PROJECT_DIR') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def is_new_task(tool: str, tool_input: dict) -> bool:
    if tool == 'mcp__hub__session_start':
        return str(tool_input.get('prompt') or '').strip() != ''
    return len(str(tool_input.get('text') or '')) > FOLLOW_UP_MAX


def required_skill(tool: str, tool_input: dict):
    """(skill, reason) this call needs, or None."""
    if tool == IMAGE_TOOL:
        return IMAGE_SKILL, IMAGE_REASON
    if tool in SESSION_TOOLS and is_new_task(tool, tool_input):
        return SKILL, SESSION_REASON
    return None


def read_since_compaction(transcript_path: str, skill: str) -> bool:
    seen = False
    with open(transcript_path, encoding='utf-8') as transcript:
        for line in transcript:
            if 'compact_boundary' not in line and skill not in line:
                continue
            entry = json.loads(line)
            if entry.get('type') == 'system' and entry.get('subtype') == 'compact_boundary':
                seen = False
                continue
            content = (entry.get('message') or {}).get('content') if entry.get('type') == 'assistant' else None
            for block in content if isinstance(content, list) else []:
                if block.get('type') == 'tool_use' and block.get('name') == 'Read' \
                        and str((block.get('input') or {}).get('file_path', '')).endswith(skill):
                    seen = True
    return seen


def main() -> int:
    try:
        event = json.load(sys.stdin)
        needed = required_skill(event.get('tool_name', ''), event.get('tool_input') or {})
        if needed is None:
            return 0
        skill, reason = needed
        if not os.path.isfile(os.path.join(brain_dir(), skill)):
            return 0
        if read_since_compaction(event['transcript_path'], skill):
            return 0
    except Exception:  # noqa: BLE001 - the gate fails open
        return 0
    print(reason, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())

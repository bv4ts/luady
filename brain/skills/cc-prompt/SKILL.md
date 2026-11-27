---
name: cc-prompt
description: How Luady writes every prompt it sends to a Claude Code session on any of the owner's servers (session_start, and new work through session_send). Distilled from prompt-master and prompt-engineering-patterns for Luady's setup.
---

# Writing prompts for Claude Code sessions

The session is Claude Code in the project's folder on its host (`project_info` gives the path; by default `~/projects/<project>`) with `bypassPermissions`: it can change anything on its host. It has never seen your chat with the owner, your memory or other sessions. A prompt is good when a strong engineer who knows only the prompt and the repo gets it right on the first try.

## Before you write
1. Know the outcome the owner wants, not only their words. Requests in another language or by voice: write the prompt in English, keep UI text they want verbatim.
2. Gather what the session can't: the owner's exact words, screenshots (Read them yourself, describe what matters, `file_upload` them and give the path it returns), error text, URLs, earlier attempts and decisions (`memory_search`, `project_info`, `graph_query` for where the code lives).
3. Decide the approach you'd take as tech lead. If the task is large, risky or unclear, ask the session for a plan first and review it before it changes code.

## Shape of a new task
Use these headings for anything bigger than a one-line fix. Drop a section only when it would be empty. Put the objective and hard limits first.

```
## Objective
One sentence: what to build, fix or find out, and why when the reason changes the approach.

## Context
What is true now: the symptom with exact text, page/URL and steps; expected vs actual; files or modules to start from;
attached files (paths); what was already tried and failed; decisions already made.

## Done when
- Binary checks: behavior X works on page Y; tests Z pass; build succeeds; screenshot saved at ~/luady-out/<topic>/.

## Scope
- Work only in: <paths or modules>. Leave <x> untouched.
- Make only the changes asked for: no extra features, refactors, renames or new dependencies.

## Stop and ask (AskUserQuestion) before
Deleting files or data, schema or migration changes, new dependencies or services, production deploys, git push or force-push,
server or config changes, or choosing between two valid approaches that change the design.

## Verify and report
Run <tests/build/lint, if known; else "the project's tests">. Find root causes; don't patch symptoms.
Finish with a short report: DONE or BLOCKED, what changed (files), verification commands and their results,
anything not done or uncertain. Report only what you verified.
```

## Rules that make prompts work
- Specific beats general: exact names, paths, numbers, pages, error lines. Replace vague verbs ("fix the report") with the precise change ("make the Sales Summary total include shipping on /reports/sales").
- Self-contained: restate everything; never "the thing we discussed". The session may be new or compacted.
- Calm, direct language. Explain why a rule matters instead of writing it in capitals; current Claude models follow plain instructions and overreact to shouting.
- Say what to do, not long lists of what not to do. Keep only the "don'ts" that protect something.
- One outcome per prompt. Split unrelated work; stage big work (investigate → plan → build → verify) and review each stage.
- Debugging: ask for the root cause with evidence (failing line, log, reproduction) before the fix, and "if you can't reproduce it, say so".
- Ask for conclusions, evidence and checks. Never ask it to show hidden reasoning or "think step by step".
- Examples beat descriptions when format matters: give 1–3 that match the real case.
- No secrets in prompts (passwords, tokens, keys). Say "credentials are already configured".
- Production deploys, data deletion and server changes go in a prompt only when the owner asked for exactly that.
- A strong model scopes up and delegates readily: keep scope tight and don't ask for subagents or extra review passes on routine work.
- Lead the session: one prompt with the full picture beats many small corrections.

## Follow-ups (`session_send` to a session already on the task)
Short and plain, no headings: the answer it needs, the next step, or the correction with exact evidence ("The total is still 0 on /reports/sales after a hard refresh; screenshot: ~/luady-inbox/sales.png. Find why and fix it."). If its report lacks proof, ask for the test output or a screenshot.

## Check before sending
1. Objective clear in the first lines? 2. Done-when checkable? 3. Scope and stop-and-ask set for anything risky? 4. Everything the session needs is in the prompt? 5. Every sentence needed?

## Example (made-up names and paths)
```
## Objective
On orchard-web, rename the "Orders" report to "Sales Summary" everywhere the owner sees it.

## Context
The owner sent a screenshot of the reports menu (~/luady-inbox/menu.png): the menu item, page title and PDF header say "Orders".
Keep the URL /reports/orders unchanged so bookmarks keep working.

## Done when
- Menu item, page title, PDF header and the `reports.orders` translation key show the new name.
- Existing tests pass; one headless screenshot of the page saved to ~/luady-out/orders-rename/page.png.

## Scope
Only labels and translations. No route, database or permission changes. Don't push or deploy.

## Verify and report
Run the test suite. Reply with: DONE or BLOCKED, files changed, test result, the screenshot path.
```

## Deeper references (read only when needed)
- `skills/prompt-master/SKILL.md`: its "Claude Code" route and "Diagnostic Checklist" for tricky prompts; `references/templates.md` Template M for long agentic tasks; `references/patterns.md` when a session misunderstood you and you need to see what the prompt lacked. When you send to a session, skip its delivery format (no 🎯 line, no "agentic tool" notice, no asking which tool: it is always Claude Code). When the owner asks you to write a prompt for another AI tool, follow prompt-master fully.
- `skills/prompt-engineering-patterns/SKILL.md` and its `references/`: when the task builds or fixes an LLM feature inside the owner's apps (system prompts, few-shot examples, structured JSON output, prompt testing). Put the pattern that fits into the session's prompt.

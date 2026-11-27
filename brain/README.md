# brain/

Templates for the manager's brain folder: `~/.local/share/luady/brain` by default (`brainDir` in `config.json`), the working directory of the manager's own tmux session that the hub starts. The hub copies this folder into it (`packages/hub/src/luady/brain-seed.ts`).

Each entry says what the file is and when the hub copies it:

- `CLAUDE.md`: Luady's operating manual; Claude Code loads it from the working directory. Replaced when the release changes.
- `.manager/settings.json`: the `--settings` file, with permissions and kit hooks. Rendered from this template before every launch.
- `.manager/prompt_gate.py`: a PreToolUse hook. It refuses `session_start` (and long `session_send`) until Luady has Read `skills/cc-prompt/SKILL.md`, and `image_generate` until it has Read `skills/image-prompt/SKILL.md`, in this conversation; it fails open. Copied before every launch.
- `.manager/mcp.json`: the `--mcp-config` file, with the `hub` MCP server from `packages/mcp`. Written before every launch with the install's own paths; the file here is a layout example.
- `skills/cc-prompt/SKILL.md`: how Luady writes prompts for sessions. CLAUDE.md tells Luady to Read it (`--restricted` loads no skills, so these are plain files). Replaced when the release changes.
- `skills/agency/`, `skills/board/`, `skills/image-prompt/`: how Luady works with the office, the board and image prompts. CLAUDE.md points to each. Replaced when the release changes.
- `skills/prompt-master/`, `skills/prompt-engineering-patterns/`: vendored MIT skills, nidhinjs/prompt-master@49b3a72 and wshobson/agents@0874a27 (`plugins/llm-application-dev/skills/prompt-engineering-patterns`). Replaced when the release changes.
- `workspace/README.md`: Luady's own folder for personal things it makes itself (`send_file` with server `hq` sends only from here). Created when missing; the hub never touches Luady's files in it afterwards.
- `memory/USER.md`, `memory/PROJECTS.md`, `memory/DECISIONS.md`, `memory/OPEN.md`, `memory/journal/`: seed memory; Luady edits the live copies. Created when missing, never overwritten.
- `README.md`: developer notes. Not copied.

Notes:

- The paths in the template `.manager/mcp.json` (`/home/luady/…`) are an example layout. On an install the hub writes `<brainDir>/.manager/mcp.json` itself, with the Node.js binary the hub runs on, the install's `packages/mcp/dist/main.js`, `<runDir>/hub.sock` and `<dataDir>/hub-token`.
- A release file the owner changed is kept as `<file>.bak` when the release replaces it.
- The hub writes `memory/PROJECTS.auto.md` and syncs `projects/<server>/<project>/GRAPH_REPORT.md`; neither lives in this repo.
- No credentials belong anywhere in this directory. `npm test -w @luady/mcp` checks these files (`packages/mcp/test/brain-files.test.ts`).

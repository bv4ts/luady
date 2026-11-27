import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { HubConfig } from '../core/contracts.js';
import { hubSocketPath, hubTokenPath, installRoot, managerFilesOf } from '../config/defaults.js';
import { writeFileAtomic } from '../config/files.js';

const { join } = posix;

/** The MCP server's name in the manager's config: its tools are `mcp__hub__*`. */
export const MCP_SERVER_NAME = 'hub';
/** The rendered folder inside the brain (luady/launch.ts reads these files). */
export const MANAGER_DIR = '.manager';
/** File tools that, without a path rule, would reach every file of the hub user. */
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'NotebookEdit'];
/** A path the permission rule may hold as it is: no glob, quote, bracket or space characters. */
const SAFE_RULE_PATH = /^\/[A-Za-z0-9._/-]*$/;

export interface RenderPaths {
  /** The install root holding `brain/.manager/` (the templates) and `packages/mcp/dist/main.js`. */
  readonly root?: string;
  /** The Node binary the MCP server runs on; the hub's own when absent. */
  readonly node?: string;
}

/** `mcp.json`: the one MCP server `hub`, with absolute paths to node, the MCP entry, the socket and the token file. */
export function renderMcpConfig(config: HubConfig, paths: RenderPaths = {}): string {
  const root = paths.root ?? installRoot();
  const server = {
    type: 'stdio',
    command: paths.node ?? process.execPath,
    args: [join(root, 'packages', 'mcp', 'dist', 'main.js')],
    env: { LUADY_HUB_SOCKET: hubSocketPath(config), LUADY_HUB_TOKEN_FILE: hubTokenPath(config) },
  };
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)}\n`;
}

/**
 * The permission rules that keep the manager's file tools in its own folder (as the Claude Code
 * permissions documentation describes them): `//<abs>/**` is an absolute path, and an
 * `Edit` rule covers every tool that writes a file. Glob and Grep inside the working folder (the brain) need no rule;
 * outside it they would need one, which `--permission-mode dontAsk` then refuses.
 */
export function ownFolderRules(brainDir: string): string[] {
  const folder = ruleFolder(brainDir);
  return [`Read(/${folder}/**)`, `Edit(/${folder}/**)`];
}

/**
 * What the manager may never change, in either mode (deny rules come before every allow rule):
 * - the rendered folder (`.manager/`: this settings file, the MCP config, the prompt gate and the seed manifest);
 * - a project config Claude Code could read from the brain (`.claude/**`, `.mcp.json`), should a setting source ever
 *   load them (the launch turns project and local sources off, luady/launch.ts).
 * Without this the manager could rewrite its own hooks or MCP servers and run code as the hub user.
 * The rule syntax is the documented one.
 */
export function managerDirDenyRules(brainDir: string): string[] {
  const folder = ruleFolder(brainDir);
  return [`Edit(/${folder}/${MANAGER_DIR}/**)`, `Edit(/${folder}/.claude/**)`, `Edit(/${folder}/.mcp.json)`];
}

function ruleFolder(brainDir: string): string {
  const folder = brainDir.replace(/\/+$/, '');
  if (!SAFE_RULE_PATH.test(folder) || folder === '') {
    throw new Error('brainDir must be an absolute path of letters, digits, ".", "_", "-" and "/" for the manager\'s file rule');
  }
  return folder;
}

interface ManagerSettings {
  permissions?: { allow?: unknown; deny?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * `settings.json`, from the release template (`brain/.manager/settings.json`): its hooks (the kit under the manager's
 * HOME) and its rules as shipped, except that with `managerFiles: 'own-folder'` every bare file tool in `allow` is
 * replaced by the folder rules above (with `any`, the owner's choice, they stay), and in both modes the rendered folder
 * itself is denied to the file tools.
 */
export function renderSettings(config: HubConfig, template: string): string {
  const parsed = JSON.parse(template) as ManagerSettings;
  const shipped = listOf(parsed.permissions?.allow);
  const allow = managerFilesOf(config) === 'any'
    ? shipped
    : [...shipped.filter((rule) => typeof rule === 'string' && !FILE_TOOLS.includes(rule)), ...ownFolderRules(config.brainDir)];
  const deny = [...listOf(parsed.permissions?.deny), ...managerDirDenyRules(config.brainDir)];
  return `${JSON.stringify({ ...parsed, permissions: { ...parsed.permissions, allow, deny } }, null, 2)}\n`;
}

/** Writes `<brainDir>/.manager/{mcp.json,settings.json,prompt_gate.py}`; returns what changed. */
export function renderManagerFiles(config: HubConfig, paths: RenderPaths = {}): string[] {
  const root = paths.root ?? installRoot();
  const templates = join(root, 'brain', MANAGER_DIR);
  const target = join(config.brainDir, MANAGER_DIR);
  const files: ReadonlyArray<readonly [string, string, number]> = [
    ['mcp.json', renderMcpConfig(config, paths), 0o600],
    ['settings.json', renderSettings(config, readFileSync(join(templates, 'settings.json'), 'utf8')), 0o600],
    ['prompt_gate.py', readFileSync(join(templates, 'prompt_gate.py'), 'utf8'), 0o700],
  ];
  return files.flatMap(([name, text, mode]) => {
    const path = join(target, name);
    if (readOrNull(path) === text) return [];
    writeFileAtomic(path, text, mode);
    return [name];
  });
}

/** `<dataDir>/hub-token` (0600): the internal socket's token the MCP server reads. */
export function writeHubToken(config: HubConfig): boolean {
  const path = hubTokenPath(config);
  if (readOrNull(path)?.trim() === config.hubSocketToken) return false;
  writeFileAtomic(path, `${config.hubSocketToken}\n`, 0o600);
  return true;
}

/**
 * Pre-accepts Claude Code's folder-trust prompt for the brain in `<managerHome>/.claude.json`,
 * keeping every other key the file has (`projects[<abs path>].hasTrustDialogAccepted`, the name the installed CLI
 * writes; it is not in the documentation). Returns whether it wrote.
 */
export function acceptFolderTrust(managerHome: string, brainDir: string): boolean {
  const path = join(managerHome, '.claude.json');
  const text = readOrNull(path);
  let state: Record<string, unknown> = {};
  if (text !== null) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) state = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${path} is not valid JSON; fix or remove it`);
    }
  }
  const projects = typeof state.projects === 'object' && state.projects !== null ? (state.projects as Record<string, unknown>) : {};
  const project = typeof projects[brainDir] === 'object' && projects[brainDir] !== null ? (projects[brainDir] as Record<string, unknown>) : {};
  if (project.hasTrustDialogAccepted === true) return false;
  const next = { ...state, projects: { ...projects, [brainDir]: { ...project, hasTrustDialogAccepted: true } } };
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return true;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

import { posix } from 'node:path';
import type { ProjectDTO, ToolName } from '@luady/shared';
import { oneLine } from '../actions/text.js';
import type { ToolHandler } from '../core/contracts.js';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';
import { referencesDeniedPath } from '../security/risk-paths.js';
import { defineTool, formatActionResult, refuseHubPath, requestAsLuady } from './common.js';

const COMMITS_SHOWN = 5;
const SUBJECT_MAX = 100;
const MEMORY_TEXT_MAX = 300;
/** Tokens of graph context per answer; enough for a call chain, small enough for the brain. */
export const GRAPH_QUERY_BUDGET = 1500;

function formatProject(project: ProjectDTO): string {
  const commits = project.commits
    .slice(0, COMMITS_SHOWN)
    .map((commit) => `  - ${commit.hash.slice(0, 7)} ${commit.date.slice(0, 10)} ${oneLine(commit.subject, SUBJECT_MAX)}`);
  return [
    `${project.name} (${project.server}:${project.path})`,
    `remote: ${project.remote ?? 'none'}`,
    `branch: ${project.branch ?? 'unknown'}`,
    `stack: ${project.stack.length > 0 ? project.stack.join(', ') : 'unknown'}`,
    `updated: ${project.updatedAt}`,
    'recent commits:',
    ...(commits.length > 0 ? commits : ['  - none']),
  ].join('\n');
}

function matchesProject(project: ProjectDTO, wanted: string): boolean {
  const lower = wanted.toLowerCase();
  return (
    project.name.toLowerCase() === lower ||
    project.path.toLowerCase() === lower ||
    posix.basename(project.path).toLowerCase() === lower
  );
}

export const SERVER_TOOLS = {
  server_exec: defineTool('server_exec', async (args, ctx) => {
    const params = { server: args.server, command: args.command, cwd: args.cwd, reason: args.reason };
    return formatActionResult(await requestAsLuady(ctx, 'server.exec', params));
  }),
  file_read: defineTool('file_read', async (args, ctx) => {
    if (!args.path.startsWith('/')) throw new ValidationError('file_read needs an absolute path');
    if (referencesDeniedPath(args.path)) throw new RefusedError(`${args.path} is a protected path`);
    refuseHubPath(ctx.fleet, args.server, args.path);
    const file = await ctx.fleet.client(args.server).fileRead(args.path, args.max_bytes);
    const note = file.truncated ? `, showing the first ${args.max_bytes} bytes` : '';
    return `${args.server}:${file.path} (${file.size} bytes${note})\n${file.content}`;
  }),
  file_write: defineTool('file_write', async (args, ctx) => {
    const params = { server: args.server, path: args.path, content: args.content, reason: args.reason };
    return formatActionResult(await requestAsLuady(ctx, 'server.file_write', params));
  }),
  claude_update: defineTool('claude_update', async (args, ctx) =>
    formatActionResult(await requestAsLuady(ctx, 'server.claude_update', { server: args.server, reason: args.reason })),
  ),
  project_info: defineTool('project_info', async (args, ctx) => {
    const projects = ctx.projects.list(args.server);
    const project = projects.find((candidate) => matchesProject(candidate, args.project));
    if (project === undefined) {
      const known = projects.map((candidate) => candidate.name).join(', ') || 'none';
      throw new NotFoundError(`No project "${args.project}" on ${args.server}. Known projects: ${known}`);
    }
    return formatProject(project);
  }),
  graph_query: defineTool('graph_query', async (args, ctx) => {
    const projects = ctx.projects.list(args.server);
    const project = projects.find((candidate) => matchesProject(candidate, args.project));
    if (project === undefined) {
      const known = projects.map((candidate) => candidate.name).join(', ') || 'none';
      throw new NotFoundError(`No project "${args.project}" on ${args.server}. Known projects: ${known}`);
    }
    const answer = await ctx.fleet.client(args.server).graphQuery(project.path, args.question, GRAPH_QUERY_BUDGET);
    return `${args.server}:${project.path} code map (built ${answer.built_at} UTC)\n${answer.text || 'No matching code found.'}`;
  }),
  memory_search: defineTool('memory_search', async (args, ctx) => {
    const hits = ctx.memory.search(args.query, args.limit);
    if (hits.length === 0) return `No memory matches for "${args.query}".`;
    return hits.map((hit) => `- [${hit.ts}] ${hit.thread} · ${hit.role}: ${oneLine(hit.text, MEMORY_TEXT_MAX)}`).join('\n');
  }),
} satisfies Partial<Record<ToolName, ToolHandler>>;

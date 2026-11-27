import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, posix, relative } from 'node:path';
import { isSelfHost, type ToolName } from '@luady/shared';
import { oneLine } from '../actions/text.js';
import type { OwnerFile } from '../channels/owner-channel.js';
import type { ToolContext, ToolHandler } from '../core/contracts.js';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';
import { FILE_GET_MAX } from '../fleet/ctl-args.js';
import { referencesDeniedPath } from '../security/risk-paths.js';
import { defineTool, refuseHubPath } from './common.js';

const CALL_REASON_MAX = 300;
const TASK_PREVIEW_MAX = 80;
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const OFFICE = 'application/vnd.openxmlformats-officedocument';
const DOCUMENT_MIME: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.html': 'text/html', '.sql': 'application/sql', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.docx': `${OFFICE}.wordprocessingml.document`, '.xlsx': `${OFFICE}.spreadsheetml.sheet`,
  '.pptx': `${OFFICE}.presentationml.presentation`, '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.apk': 'application/vnd.android.package-archive',
};

/** Chats show png/jpg/webp inline; everything else (gif included, it would lose animation) goes as a document. */
export function mediaKind(fileName: string): { kind: 'image' | 'document'; mime: string } {
  const ext = posix.extname(fileName).toLowerCase();
  const image = IMAGE_MIME[ext];
  if (image !== undefined) return { kind: 'image', mime: image };
  return { kind: 'document', mime: DOCUMENT_MIME[ext] ?? 'application/octet-stream' };
}

const kb = (bytes: number): number => Math.max(1, Math.round(bytes / 1024));

export const sentText = (fileName: string, bytes: number): string => `Sent ${fileName} (${kb(bytes)} KB) to the owner's chat.`;
export const keptText = (fileName: string, bytes: number): string =>
  `No chat channel is up, so ${fileName} (${kb(bytes)} KB) waits on the website, where the owner can download it.`;
const NO_CHAT = 'No chat channel is connected; try again later.';

/** A file for the owner: the chat when a channel takes it, else the website's outbox. */
async function deliverFile(file: OwnerFile, bytes: number, ctx: ToolContext): Promise<string> {
  if (ctx.outbound.sendFile !== undefined) {
    const delivery = await ctx.outbound.sendFile(file);
    return delivery.via === 'chat' ? sentText(file.fileName, bytes) : keptText(file.fileName, bytes);
  }
  // A raw channel without the website side: the chat only.
  if (!ctx.outbound.isUp()) throw new RefusedError(NO_CHAT);
  const kind = file.kind === 'image' ? 'image' : 'document';
  if (file.b64 !== undefined && ctx.outbound.sendMedia !== undefined) {
    await ctx.outbound.sendMedia({ kind, mime: file.mime, fileName: file.fileName, caption: file.caption, b64: file.b64 });
  } else if (file.path !== undefined && ctx.outbound.sendMediaPath !== undefined) {
    await ctx.outbound.sendMediaPath({ kind, mime: file.mime, fileName: file.fileName, caption: file.caption, path: file.path });
  } else {
    throw new RefusedError('Sending files is not available.');
  }
  return sentText(file.fileName, bytes);
}

/** A file the manager made in its own workspace on the hub machine; the real path (links resolved) must stay inside it. */
async function sendFromWorkspace(path: string, caption: string, ctx: ToolContext): Promise<string> {
  if (!isAbsolute(path)) throw new ValidationError('send_file needs an absolute path');
  if (ctx.workspaceDir === undefined || (ctx.outbound.sendFile === undefined && ctx.outbound.sendMediaPath === undefined)) {
    throw new RefusedError('Sending files from your workspace is not available.');
  }
  const root = await realpath(ctx.workspaceDir).catch(() => ctx.workspaceDir ?? '');
  const real = await realpath(path).catch(() => {
    throw new NotFoundError(`${path} does not exist`);
  });
  const inside = relative(root, real);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new RefusedError(`From the hub machine only files under ${ctx.workspaceDir}/ can be sent`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new ValidationError(`${path} is not a file`);
  if (info.size > FILE_GET_MAX) throw new RefusedError(`${path} is too big (max 50 MB); split or zip it`);
  const fileName = basename(path);
  return deliverFile({ ...mediaKind(fileName), fileName, caption, path: real }, info.size, ctx);
}

/** What notify_user tells the manager when the text waits on the website first. */
export const HELD_ON_WEBSITE = 'Shown on the website. If the owner has not seen it in 10 minutes and a chat channel is connected, it goes there too.';

/** Calls need both the phone service and the owner's phone_enabled setting. */
function phoneReady(ctx: ToolContext): boolean {
  return ctx.phone.enabled() && ctx.settings.get().phone_enabled;
}

export const OWNER_TOOLS = {
  notify_user: defineTool('notify_user', async (args, ctx) => {
    const result = ctx.outbound.deliver === undefined
      ? { msgId: await ctx.outbound.send(args.text, null), held: false }
      : await ctx.outbound.deliver(args.text, null, { urgent: args.urgent });
    if (result.held) return HELD_ON_WEBSITE;
    const delivery = result.msgId === null ? 'queued (the chat is offline)' : 'sent';
    if (!args.urgent || !phoneReady(ctx)) return `Message ${delivery}.`;
    await ctx.phone.callOwner(oneLine(args.text, CALL_REASON_MAX));
    return `Message ${delivery}; calling the owner now.`;
  }),
  send_file: defineTool('send_file', async (args, ctx) => {
    if (isSelfHost(args.server)) {
      if (ctx.outbound.sendFile === undefined && !ctx.outbound.isUp()) throw new RefusedError(NO_CHAT);
      return sendFromWorkspace(args.path, args.caption, ctx);
    }
    if (!args.path.startsWith('/')) throw new ValidationError('send_file needs an absolute path');
    if (referencesDeniedPath(args.path)) throw new RefusedError(`${args.path} is a protected path`);
    refuseHubPath(ctx.fleet, args.server, args.path);
    // Without the website side a file can only go to the chat: refused before the server is asked.
    if (ctx.outbound.sendFile === undefined && (ctx.outbound.sendMedia === undefined || !ctx.outbound.isUp())) throw new RefusedError(NO_CHAT);
    const file = await ctx.fleet.client(args.server).fileGet(args.path, FILE_GET_MAX);
    const fileName = posix.basename(file.path);
    return deliverFile({ ...mediaKind(fileName), fileName, caption: args.caption, b64: file.b64 }, file.size, ctx);
  }),
  image_generate: defineTool('image_generate', async (args, ctx) => {
    if (ctx.images === undefined) throw new RefusedError('Image generation is not available.');
    const { id, path } = ctx.images.start(args.prompt, {
      references: args.references, transparent: args.transparent, deliver: args.deliver, caption: args.caption,
    });
    const followUp = `for a follow-up change pass {source:"${id}", role:"edit"}`;
    if (args.deliver === 'manager') {
      return `Image ${id} started in the background (1–2 min); the owner gets nothing — its path (${path}) arrives in an Event. Then ${followUp}. Don't poll it.`;
    }
    return `Image ${id} started in the background (1–2 min); it reaches the owner by itself (their chat, or the website while no chat channel is up). When done it is ${path} — ${followUp}. Don't poll it.`;
  }),
  call_user: defineTool('call_user', async (args, ctx) => {
    if (!phoneReady(ctx)) return 'Phone is not enabled yet.';
    await ctx.phone.callOwner(args.reason);
    return 'Calling the owner now.';
  }),
  schedule: defineTool('schedule', async (args, ctx) => {
    const task = ctx.scheduler.add(args.when, args.task);
    return `Scheduled ${task.id} (${task.when}); next run ${task.nextRunAt ?? 'not planned'}.`;
  }),
  schedule_list: defineTool('schedule_list', async (_args, ctx) => {
    const tasks = ctx.scheduler.list();
    if (tasks.length === 0) return 'No scheduled tasks.';
    return tasks
      .map((task) => `- ${task.id} · ${task.when} · next ${task.nextRunAt ?? '—'} · ${oneLine(task.task, TASK_PREVIEW_MAX)}`)
      .join('\n');
  }),
  schedule_cancel: defineTool('schedule_cancel', async (args, ctx) => {
    if (!ctx.scheduler.cancel(args.id)) throw new NotFoundError(`No scheduled task ${args.id}.`);
    return `Cancelled ${args.id}.`;
  }),
} satisfies Partial<Record<ToolName, ToolHandler>>;

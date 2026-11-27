#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readAddonToken } from '../token.js';
import { createEchoAddon } from './echo.js';

/**
 * Runs the example add-on in a terminal:
 *
 *   LUADY_HUB_SOCKET=~/.local/share/luady/run/hub.sock \
 *   LUADY_ADDON_TOKEN_FILE=~/.local/share/luady/data/addons/echo.token \
 *   node packages/addon-sdk/dist/examples/echo-main.js
 *
 * Each line you type is a message from the owner; the hub's answers are printed. Ctrl+D or Ctrl+C stops it.
 */
async function main(): Promise<void> {
  const socketPath = process.env.LUADY_HUB_SOCKET;
  const tokenFile = process.env.LUADY_ADDON_TOKEN_FILE;
  if (socketPath === undefined || tokenFile === undefined) {
    throw new Error('Set LUADY_HUB_SOCKET (the hub socket) and LUADY_ADDON_TOKEN_FILE (this add-on\'s token file).');
  }
  const addon = createEchoAddon({
    id: process.env.LUADY_ADDON_ID ?? 'echo', token: await readAddonToken(tokenFile), socketPath,
    onText: (text) => process.stdout.write(`hub> ${text}\n`),
  });
  addon.start();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() !== '') addon.say(line);
  });
  const stop = (): void => {
    void addon.stop().then(() => process.exit(0));
  };
  lines.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

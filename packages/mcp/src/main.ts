#!/usr/bin/env node
import { startStdioServer } from './start.js';

// stdout carries MCP JSON-RPC only; startup errors go to stderr.
startStdioServer({ env: process.env }).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

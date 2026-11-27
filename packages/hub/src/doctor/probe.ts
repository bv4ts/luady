import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { INTERNAL_PATHS } from '@luady/shared';
import { hubSocketPath } from '../config/defaults.js';
import type { HubConfig } from '../core/contracts.js';
import type { HubStatus } from '../wire/status.js';
import type { DoctorProbe, ExecResult, FileFacts } from './types.js';

const EXEC_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5_000;
const STATUS_MAX_BYTES = 1024 * 1024;

function stat(path: string): FileFacts | null {
  try {
    const facts = statSync(path);
    let executable = false;
    try {
      accessSync(path, constants.X_OK);
      executable = facts.isFile();
    } catch {
      executable = false;
    }
    return { isFile: facts.isFile(), isDir: facts.isDirectory(), mode: facts.mode & 0o777, executable };
  } catch {
    return null;
  }
}

function exec(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024, ...(env === undefined ? {} : { env }) },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** The internal status route over the hub's socket, with the hub token (read here, never printed). */
function status(config: HubConfig): Promise<HubStatus | null> {
  return new Promise((resolve) => {
    const req = request({
      socketPath: hubSocketPath(config), path: INTERNAL_PATHS.status, method: 'GET', timeout: STATUS_TIMEOUT_MS,
      headers: { authorization: `Bearer ${config.hubSocketToken}` },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > STATUS_MAX_BYTES) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(body) as HubStatus);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** A small text file, or null. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, 64 * 1024);
  } catch {
    return null;
  }
}

/** The real outside world. */
export const realProbe: DoctorProbe = {
  nodeVersion: () => process.versions.node,
  platform: () => process.platform,
  stat,
  readText,
  exec,
  portFree,
  status,
};

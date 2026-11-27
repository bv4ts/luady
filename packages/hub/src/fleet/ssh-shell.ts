import { StringDecoder } from 'node:string_decoder';
import type { ClientChannel } from 'ssh2';
import type { ShellStream } from '../core/contracts.js';

/** Adapts an ssh2 channel to the ShellStream. Decodes UTF-8 across chunks and buffers output until a listener exists. */
export function wrapShellChannel(channel: ClientChannel): ShellStream {
  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  const backlog: string[] = [];
  let exitCode: number | null = null;
  let exited = false;

  const emit = (text: string): void => {
    if (text.length === 0) return;
    if (dataListeners.length === 0) {
      backlog.push(text);
      return;
    }
    for (const listener of dataListeners) listener(text);
  };
  channel.on('data', (chunk: Buffer) => emit(outDecoder.write(chunk)));
  channel.stderr.on('data', (chunk: Buffer) => emit(errDecoder.write(chunk)));
  channel.on('exit', (code: unknown) => {
    exitCode = typeof code === 'number' ? code : null;
  });
  channel.on('close', () => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(exitCode);
  });

  return {
    write(data) {
      if (!exited) channel.write(Buffer.from(data, 'utf8'));
    },
    resize(cols, rows) {
      if (!exited) channel.setWindow(rows, cols, 0, 0);
    },
    onData(listener) {
      dataListeners.push(listener);
      if (dataListeners.length === 1) for (const text of backlog.splice(0)) listener(text);
    },
    onExit(listener) {
      if (exited) listener(exitCode);
      else exitListeners.push(listener);
    },
    close() {
      if (!exited) channel.close();
    },
  };
}

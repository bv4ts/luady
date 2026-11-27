import { describe, expect, it } from 'vitest';
import { createMutex } from '../../src/security/mutex.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createMutex', () => {
  it('runs tasks one at a time in call order', async () => {
    const mutex = createMutex();
    const trace: string[] = [];
    const task = (name: string, ms: number) => async (): Promise<string> => {
      trace.push(`start ${name}`);
      await delay(ms);
      trace.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([mutex.run(task('a', 20)), mutex.run(task('b', 1)), mutex.run(task('c', 5))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(trace).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps going after a task fails', async () => {
    const mutex = createMutex();
    const failing = mutex.run(async () => {
      throw new Error('boom');
    });
    const next = mutex.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});

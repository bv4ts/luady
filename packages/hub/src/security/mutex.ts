/** Runs async tasks one at a time, in call order. A failing task does not block the next one. */
export interface Mutex {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

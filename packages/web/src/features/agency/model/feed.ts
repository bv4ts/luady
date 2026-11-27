/** A tiny publish/subscribe channel: fast events (hover) reach one component without re-rendering the page. */
export interface Feed<T> {
  emit(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

export function createFeed<T>(): Feed<T> {
  let listeners: ReadonlyArray<(value: T) => void> = [];
  return {
    emit: (value) => listeners.forEach((listener) => listener(value)),
    subscribe: (listener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((other) => other !== listener);
      };
    },
  };
}

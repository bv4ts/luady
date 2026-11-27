import type { EventBus, HubEvents } from './contracts.js';

type ErrorHandler = (err: unknown, event: string) => void;
type AnyListener = (payload: unknown) => unknown;

interface Registration {
  readonly fn: AnyListener;
}

const logToConsole: ErrorHandler = (err, event) => {
  console.error(`[luady-hub] bus listener for "${event}" failed`, err);
};

/**
 * Synchronous typed event bus. Every listener runs even if an earlier one throws. Thrown errors and
 * promises rejected by async listeners go to onError (default: console.error). Listener lists are
 * copy-on-write, so (un)subscribing during an emit takes effect from the next emit.
 */
export function createBus(onError: ErrorHandler = logToConsole): EventBus {
  const table = new Map<keyof HubEvents, readonly Registration[]>();

  const report: ErrorHandler = (err, event) => {
    try {
      onError(err, event);
    } catch (handlerErr) {
      console.error(`[luady-hub] bus onError failed for "${event}"`, handlerErr, err);
    }
  };

  const on = <K extends keyof HubEvents>(name: K, fn: (payload: HubEvents[K]) => void): (() => void) => {
    const registration: Registration = { fn: fn as AnyListener };
    table.set(name, [...(table.get(name) ?? []), registration]);
    return () => {
      table.set(name, (table.get(name) ?? []).filter((entry) => entry !== registration));
    };
  };

  const emit = <K extends keyof HubEvents>(name: K, payload: HubEvents[K]): void => {
    for (const registration of table.get(name) ?? []) {
      deliver(registration, payload, name, report);
    }
  };

  return { emit, on };
}

function deliver(registration: Registration, payload: unknown, event: string, report: ErrorHandler): void {
  try {
    const result = registration.fn(payload);
    if (isThenable(result)) {
      result.then(undefined, (err: unknown) => report(err, event));
    }
  } catch (err) {
    report(err, event);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

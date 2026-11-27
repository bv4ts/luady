/**
 * The manager's display name: the one source for every text that names the manager as a person (chat, notices,
 * board words, tool replies, the remote-control name). The product's own name (the hub, the kit, the app) is not this.
 * It is the `manager_name` setting: the hub and the website set it when the settings load and after each change.
 */
const DEFAULT_MANAGER_NAME = 'Luady';
const MANAGER_NAME_MAX = 40;

let current = DEFAULT_MANAGER_NAME;

/** The manager's display name right now. */
export function managerName(): string {
  return current;
}

/** Sets the display name (trimmed, at most 40 characters); an empty name keeps the default. */
export function setManagerName(name: string): void {
  const trimmed = name.trim().slice(0, MANAGER_NAME_MAX);
  current = trimmed === '' ? DEFAULT_MANAGER_NAME : trimmed;
}

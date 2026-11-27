import type { ActionDTO } from '@luady/shared';
import type { ActionKind, ActionRequest, ActionService } from '../core/contracts.js';

/** Returns a copy without undefined values so the params stay JSON-clean for the audit log. */
export function definedOnly(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/**
 * Every mutating owner request from the website goes through the action service, which handles
 * the audit, tiers and PIN step-up.
 */
export function ownerAction(
  actions: ActionService,
  kind: ActionKind,
  params: Readonly<Record<string, unknown>>,
  pin?: string,
  opts: { alwaysPin?: boolean; sid?: string } = {},
): Promise<ActionDTO> {
  const base: ActionRequest = { kind, actor: 'owner', channel: 'web', params: definedOnly(params) };
  const pinned = opts.alwaysPin === true ? { ...base, alwaysPin: true } : base;
  const request = opts.sid === undefined ? pinned : { ...pinned, sid: opts.sid };
  return actions.request(pin === undefined ? request : { ...request, pin });
}

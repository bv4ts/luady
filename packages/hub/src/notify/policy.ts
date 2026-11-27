import type { Settings } from '@luady/shared';
import { inQuietHours } from '../core/time.js';

export type NoticeKind = 'question' | 'permission' | 'confirmation' | 'finished' | 'error' | 'ended';

export const BATCH_WINDOW_MS = 60_000;
export const BATCH_MAX_INDIVIDUAL = 3;
export const FAILURE_DEDUPE_MS = 10 * 60_000;
const MINUTE_MS = 60_000;

export interface FinishedDecisionInput {
  durationSec: number;
  remote: boolean;
  away: boolean;
  replay: boolean;
  finishedMinSeconds: number;
}

export function shouldNotifyFinished(input: FinishedDecisionInput): boolean {
  if (input.replay) return false;
  return input.durationSec >= input.finishedMinSeconds || input.remote || input.away;
}

export function isAlwaysSent(kind: NoticeKind): boolean {
  return kind === 'question' || kind === 'permission' || kind === 'confirmation';
}

export function isBatchable(kind: NoticeKind): boolean {
  return kind === 'finished' || kind === 'error' || kind === 'ended';
}

export function allowedInQuietHours(kind: NoticeKind, remote: boolean): boolean {
  return isAlwaysSent(kind) || remote;
}

export function passesQuietHours(kind: NoticeKind, remote: boolean, now: Date, settings: Settings): boolean {
  return !inQuietHours(now, settings.quiet_hours) || allowedInQuietHours(kind, remote);
}

export interface EscalationInput {
  pending: boolean;
  alreadyEscalated: boolean;
  phoneEnabledSetting: boolean;
  phoneAvailable: boolean;
  quiet: boolean;
  nightCalls: boolean;
}

export function canEscalate(input: EscalationInput): boolean {
  if (!input.pending || input.alreadyEscalated) return false;
  if (!input.phoneEnabledSetting || !input.phoneAvailable) return false;
  return !input.quiet || input.nightCalls;
}

export function escalationDueAt(createdAtIso: string, escalateAfterMin: number): number {
  return Date.parse(createdAtIso) + escalateAfterMin * MINUTE_MS;
}

export function recentSends(sentAt: readonly number[], nowMs: number): number[] {
  return sentAt.filter((t) => nowMs - t < BATCH_WINDOW_MS);
}

export function shouldHold(sentAt: readonly number[], nowMs: number): boolean {
  return recentSends(sentAt, nowMs).length >= BATCH_MAX_INDIVIDUAL;
}

export function isDuplicateFailure(lastAtMs: number | undefined, nowMs: number): boolean {
  return lastAtMs !== undefined && nowMs - lastAtMs < FAILURE_DEDUPE_MS;
}

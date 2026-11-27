import { ownerFormat } from '@luady/shared';

/** In the owner's zone, read at every call (the settings load sets it). */
const OWNER_TIME = ownerFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const OWNER_DATE_TIME = ownerFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A server with less disk free than this (10 GB) is flagged. */
export const LOW_DISK_KB = 10 * 1024 * 1024;

export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  const time = parseTime(iso);
  if (time === null) return '—';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ownerTime(iso: string | null): string | null {
  const time = parseTime(iso);
  return time === null ? null : OWNER_TIME.format(time);
}

export function ownerDateTime(iso: string | null): string {
  const time = parseTime(iso);
  return time === null ? '—' : OWNER_DATE_TIME.format(time);
}

export function formatKb(kb: number): string {
  const gb = kb / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(kb / 1024)} MB`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function percentUsed(total: number, available: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((total - available) / total) * 100)));
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function basename(path: string): string {
  return path.split('/').filter((part) => part !== '').at(-1) ?? path;
}

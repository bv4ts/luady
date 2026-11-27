import { z } from 'zod';
import { HostIdSchema } from './ids.js';
import { LIMITS } from './limits.js';
import { RoomIdSchema } from './rooms.js';
import { HttpsUrlSchema } from './urls.js';

// Every shape of the welcome-back card, the fleet wall, the wins wall, the today strip, the schedule board, the links
// shelf and the website preferences.

/** What a recap line or a timeline mark opens: a card, a session (the agent view), a question (its answer) or a note. */
export const OFFICE_REF_KINDS = ['todo', 'session', 'question', 'note'] as const;
export const OfficeRefSchema = z.object({ kind: z.enum(OFFICE_REF_KINDS), id: z.string() });
export type OfficeRef = z.infer<typeof OfficeRefSchema>;

// ── Welcome-back card ──

export const RecapLineSchema = z.object({
  at: z.string(),
  text: z.string().max(LIMITS.recapTextMax),
  ref: OfficeRefSchema.nullable(),
  server: HostIdSchema.nullable(),
});
export type RecapLine = z.infer<typeof RecapLineSchema>;

const RecapLines = z.array(RecapLineSchema).max(LIMITS.recapLinesMax);
const Count = z.number().int().min(0);

/** `GET /api/recap?since=`: newest first in every list; `since` older than 7 days counts as 7 days. */
export const RecapDTOSchema = z.object({
  since: z.string(),
  until: z.string(),
  finished: RecapLines,
  failed: RecapLines,
  waiting: RecapLines,
  meetings: RecapLines,
  cards: z.object({ added: Count, done: Count }),
  sessions: z.object({ started: Count, ended: Count }),
});
export type RecapDTO = z.infer<typeof RecapDTOSchema>;

/** True when the card has nothing to say (every list empty, every count zero): the website shows nothing. */
export function isEmptyRecap(recap: RecapDTO): boolean {
  const lists = [recap.finished, recap.failed, recap.waiting, recap.meetings];
  const counts = [recap.cards.added, recap.cards.done, recap.sessions.started, recap.sessions.ended];
  return lists.every((list) => list.length === 0) && counts.every((count) => count === 0);
}

// ── Fleet wall ──

const Pct = z.number().min(0).max(100);
const EpochSeconds = z.number().int().min(0);

/** `[t, load, memPct, diskPct]`, `t` in epoch seconds; `diskPct` null = the kit (older than 2.1.0) does not report the disk size: no disk graph. */
export const ServerPointSchema = z.tuple([EpochSeconds, z.number().min(0), Pct, Pct.nullable()]);
/** `[t, fiveHourPct, sevenDayPct]`; null = the window was not reported. */
export const AccountPointSchema = z.tuple([EpochSeconds, Pct.nullable(), Pct.nullable()]);

/** `GET /api/fleet/history`: the last 24 hours, kept in the hub's memory, at most 240 points a series. */
export const FleetHistoryDTOSchema = z.object({
  servers: z.array(z.object({ name: HostIdSchema, points: z.array(ServerPointSchema).max(LIMITS.fleetPointsMax) })),
  accounts: z.array(z.object({ id: z.string(), label: z.string(), points: z.array(AccountPointSchema).max(LIMITS.fleetPointsMax) })),
});
export type FleetHistoryDTO = z.infer<typeof FleetHistoryDTOSchema>;

// ── Wins wall ──

export const WinLinkSchema = HttpsUrlSchema.max(LIMITS.winsLinkMax);

export const WinDTOSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  project: z.string().nullable(),
  server: HostIdSchema.nullable(),
  result: z.string().nullable(),
  /** `https://` addresses found in the result and the card's log. */
  links: z.array(WinLinkSchema).max(LIMITS.winsLinksMax),
  doneAt: z.string(),
});
export type WinDTO = z.infer<typeof WinDTOSchema>;

/** `GET /api/wins?days=7`: done cards, newest first, and how many per office. */
export const WinsDTOSchema = z.object({
  items: z.array(WinDTOSchema),
  byServer: z.partialRecord(HostIdSchema, Count),
});
export type WinsDTO = z.infer<typeof WinsDTOSchema>;

// ── Today strip ──

export const TIMELINE_KINDS = ['started', 'done', 'asked', 'answered', 'arrived', 'left', 'meeting', 'alert'] as const;
export const TimelineKindSchema = z.enum(TIMELINE_KINDS);
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** An owner calendar day, `YYYY-MM-DD`. */
export const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const TimelineItemSchema = z.object({
  at: z.string(),
  kind: TimelineKindSchema,
  /** In the owner's words (a session's name, a card's title), never raw ids. */
  label: z.string().max(LIMITS.timelineLabelMax),
  server: HostIdSchema.nullable(),
  ref: OfficeRefSchema.nullable(),
});
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

/** `GET /api/timeline?day=` (owner day; default today): oldest first, at most 400. */
export const TimelineDTOSchema = z.object({
  day: z.string().regex(DAY_RE),
  items: z.array(TimelineItemSchema).max(LIMITS.timelineItemsMax),
});
export type TimelineDTO = z.infer<typeof TimelineDTOSchema>;

// ── Schedule board ──

/** One of Luady's reminders or timed jobs; `when` is an ISO time with offset or a 5-field cron in owner time. */
export const ScheduleItemDTOSchema = z.object({
  id: z.string(),
  when: z.string(),
  task: z.string(),
  nextRunAt: z.string().nullable(),
});
export type ScheduleItemDTO = z.infer<typeof ScheduleItemDTOSchema>;

export const ScheduleListDTOSchema = z.object({ items: z.array(ScheduleItemDTOSchema) });
export type ScheduleListDTO = z.infer<typeof ScheduleListDTOSchema>;

export const CreateScheduleBodySchema = z.strictObject({
  when: z.string().trim().min(LIMITS.scheduleWhenMin).max(LIMITS.scheduleWhenMax),
  task: z.string().trim().min(LIMITS.scheduleTaskMin).max(LIMITS.scheduleTaskMax),
});
export type CreateScheduleBody = z.infer<typeof CreateScheduleBodySchema>;

// ── Links shelf ──

/** Only `https://` addresses, at most 500 characters. The hub stores them and never requests them. */
export const LinkUrlSchema = HttpsUrlSchema.max(LIMITS.linkUrlMax);
const LinkLabel = z.string().trim().min(1).max(LIMITS.linkLabelMax);
const Position = z.number().int().min(0);

export const LinkDTOSchema = z.object({
  id: z.number().int().positive(),
  /** The room key of the office whose shelf it is on. */
  server: RoomIdSchema,
  label: z.string().min(1).max(LIMITS.linkLabelMax),
  url: LinkUrlSchema,
  position: Position,
});
export type LinkDTO = z.infer<typeof LinkDTOSchema>;

/** `GET /api/links`: every office's links, by server then position. */
export const LinkListDTOSchema = z.object({ items: z.array(LinkDTOSchema) });
export type LinkListDTO = z.infer<typeof LinkListDTOSchema>;

export const CreateLinkBodySchema = z.strictObject({ server: RoomIdSchema, label: LinkLabel, url: LinkUrlSchema });
export type CreateLinkBody = z.infer<typeof CreateLinkBodySchema>;

export const UpdateLinkBodySchema = z.strictObject({ label: LinkLabel.optional(), url: LinkUrlSchema.optional(), position: Position.optional() });
export type UpdateLinkBody = z.infer<typeof UpdateLinkBodySchema>;

// ── Website preferences (sound, day and night) ──

/** Kept in the hub's settings table, so every device agrees. */
export const WebPrefsDTOSchema = z.object({
  sound: z.object({ muted: z.boolean(), volume: z.number().min(0).max(1) }),
  dayNight: z.boolean(),
});
export type WebPrefsDTO = z.infer<typeof WebPrefsDTOSchema>;

export const DEFAULT_WEB_PREFS: WebPrefsDTO = Object.freeze({ sound: Object.freeze({ muted: false, volume: 0.6 }), dayNight: true });

/** `PUT /api/prefs`: any part; what is left out stays as stored. */
export const UpdateWebPrefsBodySchema = z.strictObject({
  sound: z.strictObject({ muted: z.boolean().optional(), volume: z.number().min(0).max(1).optional() }).optional(),
  dayNight: z.boolean().optional(),
});
export type UpdateWebPrefsBody = z.infer<typeof UpdateWebPrefsBodySchema>;

/** The stored preferences with a change on top (a new object; neither input is changed). */
export function mergeWebPrefs(base: WebPrefsDTO, patch: UpdateWebPrefsBody): WebPrefsDTO {
  return {
    sound: {
      muted: patch.sound?.muted ?? base.sound.muted,
      volume: patch.sound?.volume ?? base.sound.volume,
    },
    dayNight: patch.dayNight ?? base.dayNight,
  };
}

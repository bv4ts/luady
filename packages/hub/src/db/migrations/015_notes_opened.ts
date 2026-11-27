/**
 * A meeting note shows "NEW" until the owner opens it. `opened_at` is the first time it was opened on any
 * device. Additive only. Meetings filed as history, and meetings that started more than a day before this migration
 * runs, count as opened, so the owner starts with only the last day of meetings marked new.
 */
export const sql = `ALTER TABLE meetings ADD COLUMN opened_at TEXT;
UPDATE meetings SET opened_at = updated_at
  WHERE state = 'history' OR started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day');`;

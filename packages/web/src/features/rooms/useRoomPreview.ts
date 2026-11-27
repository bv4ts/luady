import type { ProjectMatch, RoomKind, RoomPreviewDTO } from '@luady/shared';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { reportError } from '../../lib/report.js';

/** The preview waits this long after the last keystroke. */
export const PREVIEW_DELAY_MS = 400;

export type RoomPreview =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly data: RoomPreviewDTO }
  | { readonly state: 'unavailable' };

const IDLE: RoomPreview = { state: 'idle' };

/**
 * "This room will hold…" (POST /api/rooms/preview), refreshed shortly after the kind, host or matches change. Only
 * complete matches are sent; a hub without the route shows nothing.
 */
export function useRoomPreview(input: { kind: RoomKind; host: string; match: readonly ProjectMatch[]; id: string | null; enabled: boolean }): RoomPreview {
  const api = useApi();
  const [preview, setPreview] = useState<RoomPreview>(IDLE);
  const match = useMemo(() => input.match.map((m) => ({ by: m.by, glob: m.glob.trim() })).filter((m) => m.glob !== ''), [input.match]);
  const key = JSON.stringify([input.kind, input.host, match, input.id]);
  const ready = input.enabled && (input.kind !== 'project' || match.length > 0) && (input.kind === 'project' || input.host !== '');
  useEffect(() => {
    if (!ready) {
      setPreview(IDLE);
      return undefined;
    }
    let alive = true;
    setPreview({ state: 'loading' });
    const timer = setTimeout(() => {
      api.previewRoom({ kind: input.kind, host: input.host === '' ? null : input.host, match, ...(input.id === null ? {} : { id: input.id }) })
        .then((data) => {
          if (alive) setPreview({ state: 'ready', data });
        }, (err: unknown) => {
          if (!alive) return;
          if (!isApiError(err) || err.status >= 500) reportError('room preview', err);
          setPreview({ state: 'unavailable' });
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `key` stands for kind, host, matches and id.
  }, [api, key, ready]);
  return preview;
}

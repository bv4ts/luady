import type { NoticeFile, PanelBlock } from '@luady/shared';
import type { ChannelsService, Clock, Logger, OutboundChannel, OutboundLink } from '../core/contracts.js';
import { DELIVER_IN_FLIGHT_MAX, DELIVER_PER_MINUTE, DELIVER_WINDOW_MS } from './budgets.js';
import type { AddonRegistry } from './addons-file.js';
import type { ChannelHost, DeliverFrame } from './host.js';
import type { OwnerChannelFacade } from './owner-channel.js';
import type { Outbox } from './outbox.js';
import { confineAddonFile } from './paths.js';
import { HubError } from '../core/errors.js';

declare module '../core/contracts.js' {
  interface ChannelsService {
    /** The panel block that carries `action` (its `pin` says whether the PIN is needed), or null. */
    panelBlock(id: string, action: string): Extract<PanelBlock, { type: 'input' | 'button' }> | null;
    /** Sends `ui.action` to the add-on; false when it is not connected. */
    uiAction(id: string, action: string, value: string | null): boolean;
    /** A file the outbox keeps for the owner (`GET /api/files/:id`): its record and where its bytes are. */
    file(id: string): { readonly file: NoticeFile; readonly path: string } | null;
  }
}

/** The outbox record as `NoticeDTO.file` carries it: id, name, type and size only. */
export function noticeFileOf(file: { id: string; name: string; mime: string; size: number } | null): NoticeFile | null {
  return file === null ? null : { id: file.id, name: file.name, mime: file.mime, size: file.size };
}

export function createChannelsService(deps: { host: ChannelHost; outbox: Outbox }): ChannelsService {
  return {
    list: () => deps.host.list(),
    panelBlock: (id, action) => deps.host.panelBlock(id, action),
    uiAction(id, action, value) {
      const link = deps.host.link(id);
      return link !== null && link.ready() && link.send({ t: 'ui.action', action, value });
    },
    file(id) {
      const record = noticeFileOf(deps.outbox.get(id));
      const path = deps.outbox.pathOf(id);
      return record === null || path === null ? null : { file: record, path };
    },
  };
}

export interface DeliverDeps {
  host: ChannelHost;
  addons: AddonRegistry;
  owner: OwnerChannelFacade;
  /** Text for the owner from an add-on: a notice-routed sender (website first while the owner is there). */
  text: OutboundChannel;
  clock: Clock;
  log: Logger;
}

/** Per add-on: deliveries running now, and when the recent ones started (the per-minute budget). */
interface Budget { inFlight: number; starts: readonly number[] }

const NO_LINK: OutboundLink | null = null;

/**
 * Who said it: every text and caption an add-on delivers starts with its configured name, so nothing from an add-on
 * (a tools add-on above all) can pass for the hub or the manager.
 */
export function attributed(name: string, text: string): string {
  const who = `🧩 ${name.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'Add-on'}`;
  return text.trim() === '' ? who : `${who}: ${text.trim()}`;
}

/**
 * An add-on's `deliver`: text goes to the owner like the hub's own results; a file must be inside
 * the add-on's own files folder, then goes to the chat or the website's outbox. The add-on hears `delivered`.
 */
export function handleDeliver(deps: DeliverDeps): (id: string, frame: DeliverFrame) => Promise<void> {
  const budgets = new Map<string, Budget>();

  /** One at a time and a few a minute, per add-on: an add-on can neither fill the disk nor bury the notices. */
  function admit(id: string): string | null {
    const now = deps.clock.now().getTime();
    const budget = budgets.get(id) ?? { inFlight: 0, starts: [] };
    const recent = budget.starts.filter((at) => now - at < DELIVER_WINDOW_MS);
    if (budget.inFlight >= DELIVER_IN_FLIGHT_MAX) return 'one delivery at a time: wait for "delivered" before the next';
    if (recent.length >= DELIVER_PER_MINUTE) return `at most ${DELIVER_PER_MINUTE} deliveries a minute; try again shortly`;
    budgets.set(id, { inFlight: budget.inFlight + 1, starts: [...recent, now] });
    return null;
  }

  function release(id: string): void {
    const budget = budgets.get(id);
    if (budget !== undefined) budgets.set(id, { ...budget, inFlight: Math.max(0, budget.inFlight - 1) });
  }

  return async (id, frame) => {
    const answer = (ok: boolean, error: string | null): void => {
      deps.host.link(id)?.send({ t: 'delivered', ref: frame.ref, ok, error });
    };
    const refused = admit(id);
    if (refused !== null) {
      deps.log.warn({ addon: id }, 'channels: an add-on delivery was refused by its budget');
      answer(false, refused);
      return;
    }
    const name = deps.addons.get(id)?.name ?? id;
    try {
      if (frame.file !== undefined) {
        const checked = await confineAddonFile(deps.addons.filesDir(id), frame.file.path);
        if (!checked.ok) {
          deps.log.warn({ addon: id, reason: checked.reason }, 'channels: refused a file an add-on delivered');
          answer(false, `the file was refused (${checked.reason})`);
          return;
        }
        const { kind, mime, fileName, caption } = frame.file;
        await deps.owner.sendFile({ kind, mime, fileName, caption: attributed(name, caption), path: checked.path, identity: checked.identity });
        if (frame.text !== undefined && frame.text.trim() !== '') await deps.text.send(attributed(name, frame.text), NO_LINK);
      } else if (frame.text !== undefined && frame.text.trim() !== '') {
        await deps.text.send(attributed(name, frame.text), NO_LINK);
      } else {
        answer(false, 'nothing to deliver');
        return;
      }
      answer(true, null);
    } catch (err) {
      deps.log.warn({ addon: id, err: err instanceof Error ? err.message : String(err) }, 'channels: an add-on delivery failed');
      // A refusal (the outbox is full, the file too big) is told plainly; anything else stays generic.
      answer(false, err instanceof HubError ? err.message : 'the hub could not deliver it');
    } finally {
      release(id);
    }
  };
}

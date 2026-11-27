import { ChannelActionBodySchema, ChannelInfoDTOSchema, PinSchema, type ChannelInfoDTO, type NoticeFile } from '@luady/shared';
import { z } from 'zod';
import type { Http } from './http.js';
import { checked, seg, type Verbs } from './verbs.js';

/** The accounts the website connects. */
export type ConnectService = 'google' | 'wispr';

const ChannelListSchema = z.array(ChannelInfoDTOSchema);
const OkSchema = z.object({ ok: z.literal(true) });
const ConnectStartSchema = z.object({ url: z.url({ protocol: /^https$/ }) });
const ConnectStartBodySchema = z.strictObject({ pin: PinSchema, label: z.string().min(1).max(24).optional() });

/**
 * Channels and add-ons: the declared add-ons, a panel action, the Google and Wispr connect links,
 * and a file the website keeps for the owner. On the main client (`api.channels`), so every call goes through the
 * client's own HTTP layer: its fetch, the page key, same origin and the signed-in CSRF token.
 */
export interface ChannelsApi {
  list(): Promise<ChannelInfoDTO[]>;
  action(id: string, body: { action: string; value?: string | null; pin?: string }): Promise<void>;
  connect(service: ConnectService, body: { pin: string; label?: string }): Promise<{ url: string }>;
  /** `GET /api/files/:id` with the page key: the bytes, for a download the browser saves. */
  download(file: NoticeFile): Promise<Blob>;
}

/** The channels routes of the main client. */
export function channelRoutes(http: Pick<Http, 'blob'>, { get, post }: Verbs): ChannelsApi {
  return {
    list: () => get('/api/channels', ChannelListSchema),
    async action(id, body) {
      await post(`/api/channels/${seg(id)}/action`, OkSchema, checked(ChannelActionBodySchema, body));
    },
    connect: async (service, body) => post(`/api/connect/${service}`, ConnectStartSchema, checked(ConnectStartBodySchema, body)),
    download: (file) => http.blob(`/api/files/${seg(file.id)}`),
  };
}

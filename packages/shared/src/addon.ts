import { z } from 'zod';
import { ADDON_ID_RE, PinSchema } from './ids.js';
import { LIMITS } from './limits.js';

/**
 * Add-on Protocol v1: an add-on is a separate process speaking one zod-validated JSON object per frame
 * over `<runDir>/hub.sock`, at `/internal/addon/<id>`. Types only here; the hub's channel host and the SDK use them.
 */
export const ADDON_PROTOCOL = 1;
export const ADDON_KINDS = ['channel', 'tools'] as const;
export const CHANNEL_STATES = ['starting', 'linking', 'up', 'down', 'unlinked'] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];
/** Close codes of the add-on socket. */
export const ADDON_CLOSE = { replaced: 4000, protocolMismatch: 4001 } as const;
export const ADDON_TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

export const AddonIdSchema = z.string().regex(ADDON_ID_RE);

export const CapabilitiesSchema = z.strictObject({
  text: z.boolean(), files: z.boolean(), edit: z.boolean(), pin: z.boolean(), revoke: z.boolean(), typing: z.boolean(),
  played: z.boolean(), profile: z.boolean(), replyQuote: z.boolean(), voiceNotes: z.boolean(),
  maxText: z.number().int().min(LIMITS.addonMaxTextMin).max(LIMITS.addonMaxTextMax),
  maxFileBytes: z.number().int().min(0),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

const PanelText = z.string().max(LIMITS.addonPanelTextMax);
/** Panel blocks: data only; every string renders as text and `qr` through the website's QR drawer. */
export const PanelBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), id: z.string().max(64).optional(), text: PanelText }),
  z.strictObject({ type: z.literal('qr'), id: z.string().max(64).optional(), data: PanelText }),
  z.strictObject({ type: z.literal('code'), id: z.string().max(64).optional(), text: PanelText }),
  z.strictObject({ type: z.literal('input'), id: z.string().max(64), label: PanelText, action: z.string().min(1).max(64) }),
  z.strictObject({
    type: z.literal('button'), id: z.string().max(64).optional(), label: PanelText, action: z.string().min(1).max(64),
    pin: z.boolean().optional(), danger: z.boolean().optional(),
  }),
]);
export type PanelBlock = z.infer<typeof PanelBlockSchema>;
export const PanelSpecSchema = z.strictObject({ title: z.string().max(80), blocks: z.array(PanelBlockSchema).max(LIMITS.addonPanelBlocksMax) });
export type PanelSpec = z.infer<typeof PanelSpecSchema>;
export const PanelStateSchema = z.strictObject({ blocks: z.array(PanelBlockSchema).max(LIMITS.addonPanelBlocksMax) });
export type PanelState = z.infer<typeof PanelStateSchema>;

/** A tool an add-on offers the manager; the hub checks only the size of `args`, the add-on validates them. */
export const AddonToolDefSchema = z.strictObject({
  name: z.string().regex(ADDON_TOOL_NAME_RE),
  description: z.string().min(1).max(LIMITS.addonToolDescriptionMax),
  input: z.record(z.string(), z.unknown()).refine((schema) => JSON.stringify(schema).length <= LIMITS.addonToolSchemaMaxBytes, {
    message: `a tool's input schema may be at most ${LIMITS.addonToolSchemaMaxBytes} bytes`,
  }),
});
export type AddonToolDef = z.infer<typeof AddonToolDefSchema>;

export const MediaRefSchema = z.strictObject({
  kind: z.enum(['image', 'video', 'audio', 'document', 'sticker']), path: z.string().nullable(), mime: z.string().max(200),
  fileName: z.string().max(255).nullable(), size: z.number().int().min(0).nullable(), error: z.string().max(500).nullable(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

const MsgId = z.string().min(1).max(200);
const Ref = z.string().min(1).max(64);

/** From the add-on to the hub. */
export const AddonToHubSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('hello'), protocol: z.number().int(), kind: z.enum(ADDON_KINDS), version: z.string().max(64),
    capabilities: CapabilitiesSchema.optional(), panel: PanelSpecSchema.optional(),
    tools: z.array(AddonToolDefSchema).max(LIMITS.addonToolsMax).optional(),
    brainNotes: z.string().max(LIMITS.addonBrainNotesMax).optional(),
  }).refine((hello) => hello.kind !== 'channel' || hello.capabilities !== undefined, { message: 'a channel declares its capabilities' }),
  z.strictObject({
    t: z.literal('status'), state: z.enum(CHANNEL_STATES), detail: z.string().max(LIMITS.addonDetailMax).nullable(),
    panel: PanelStateSchema.optional(),
  }),
  z.strictObject({
    t: z.literal('incoming'), msgId: MsgId, from: z.string().min(1).max(200), text: z.string().max(LIMITS.addonTextMax), ts: z.number(),
    replyTo: z.strictObject({
      msgId: MsgId, text: z.string().max(LIMITS.addonTextMax).optional(), fromMe: z.boolean().optional(), media: MediaRefSchema.optional(),
    }).optional(),
    media: MediaRefSchema.extend({
      voice: z.strictObject({ transcript: z.string().max(LIMITS.addonTextMax).nullable(), error: z.string().max(500).nullable() }).optional(),
    }).optional(),
  }),
  z.strictObject({ t: z.literal('sent'), ref: Ref, msgId: MsgId.nullable(), error: z.string().max(500).nullable() }),
  z.strictObject({ t: z.literal('tool.result'), callId: Ref, ok: z.boolean(), text: z.string().max(LIMITS.addonTextMax) }),
  z.strictObject({
    t: z.literal('deliver'), ref: Ref, text: z.string().max(LIMITS.addonTextMax).optional(),
    file: z.strictObject({
      kind: z.enum(['image', 'document', 'video', 'audio']), path: z.string().min(1).max(1024), mime: z.string().max(200),
      fileName: z.string().min(1).max(255), caption: z.string().max(1000),
    }).optional(),
  }),
]);
export type AddonToHub = z.infer<typeof AddonToHubSchema>;

/** From the hub to the add-on. */
export const HubToAddonSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('welcome'), protocol: z.number().int(), hub: z.string().max(64), manager: z.strictObject({ name: z.string().max(40) }),
    owner: z.string().max(200).nullable(),
  }),
  z.strictObject({ t: z.literal('send'), ref: Ref, text: z.string().max(LIMITS.addonTextMax), replyTo: MsgId.nullable() }),
  z.strictObject({
    t: z.literal('send_file'), ref: Ref, kind: z.enum(['image', 'document', 'video', 'audio']), mime: z.string().max(200),
    fileName: z.string().min(1).max(255), caption: z.string().max(1000), path: z.string().max(1024).optional(), b64: z.string().optional(),
  }),
  z.strictObject({ t: z.literal('typing'), on: z.boolean() }),
  z.strictObject({ t: z.literal('edit'), ref: Ref, msgId: MsgId, text: z.string().max(LIMITS.addonTextMax) }),
  z.strictObject({
    t: z.literal('pin'), msgId: MsgId, on: z.boolean(),
    seconds: z.union([z.literal(86_400), z.literal(604_800), z.literal(2_592_000)]).optional(),
  }),
  z.strictObject({ t: z.literal('revoke'), msgId: MsgId }),
  z.strictObject({ t: z.literal('played'), msgId: MsgId }),
  z.strictObject({
    t: z.literal('profile'), about: z.string().max(LIMITS.addonProfileAboutMax), description: z.string().max(LIMITS.addonProfileDescriptionMax),
  }),
  z.strictObject({ t: z.literal('unlink') }),
  z.strictObject({ t: z.literal('ui.action'), action: z.string().min(1).max(64), value: z.string().max(LIMITS.addonPanelTextMax).nullable() }),
  z.strictObject({ t: z.literal('tool.call'), callId: Ref, name: z.string().regex(ADDON_TOOL_NAME_RE), args: z.unknown() }),
  z.strictObject({ t: z.literal('delivered'), ref: Ref, ok: z.boolean(), error: z.string().max(500).nullable() }),
]);
export type HubToAddon = z.infer<typeof HubToAddonSchema>;

/** `GET /api/channels`: one entry per declared channel add-on; `absent` while it is not connected. */
export const ChannelInfoDTOSchema = z.object({
  id: AddonIdSchema, kind: z.enum(ADDON_KINDS), name: z.string().max(80),
  state: z.enum([...CHANNEL_STATES, 'absent']), detail: z.string().max(LIMITS.addonDetailMax).nullable(),
  since: z.string().nullable(), primary: z.boolean(), capabilities: CapabilitiesSchema.nullable(), panel: PanelSpecSchema.nullable(),
});
export type ChannelInfoDTO = z.infer<typeof ChannelInfoDTOSchema>;

/** `POST /api/channels/:id/action`: a panel action; the PIN when its block says so. */
export const ChannelActionBodySchema = z.strictObject({
  action: z.string().min(1).max(64), value: z.string().max(LIMITS.addonPanelTextMax).nullable().optional(),
  pin: PinSchema.optional(),
});
export type ChannelActionBody = z.infer<typeof ChannelActionBodySchema>;

import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from '../core/contracts.js';
import type { HostCheck } from '../web/host-check.js';
import type { TwilioPhone } from './service.js';
import { EMPTY_TWIML, HANGUP_TWIML, relayTwiml } from './speech.js';
import { validTwilioSignature } from './twilio.js';

export const VOICE_PORT = 7411;
const BODY_LIMIT = 64 * 1024;
const CALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface VoiceServerDeps {
  phone: TwilioPhone;
  authToken: string;
  /** The configured public origin (https://voice.<domain>); signatures are checked against it, never against request headers. */
  origin: string;
  log: Logger;
  /** Requests whose Host this hub does not answer to are refused with 421. */
  hostCheck?: HostCheck;
}

type Form = Record<string, string>;

/**
 * Voice ingress: loopback only, reached through the tunnel as voice.<domain>; serves /twilio/* and nothing else;
 * every webhook and the ConversationRelay upgrade must carry a valid X-Twilio-Signature.
 */
export async function createVoiceServer(deps: VoiceServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT, trustProxy: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  const hostCheck = deps.hostCheck;
  if (hostCheck !== undefined) {
    app.addHook('onRequest', async (req, reply) => {
      if (!hostCheck(req)) await reply.code(421).send();
    });
  }
  await app.register(fastifyWebsocket, { options: { maxPayload: BODY_LIMIT } });

  const publicUrl = (req: FastifyRequest): string => `${deps.origin}${req.url}`;
  const signed = (req: FastifyRequest, form: Form): boolean => {
    const header = req.headers['x-twilio-signature'];
    return validTwilioSignature(deps.authToken, typeof header === 'string' ? header : undefined, publicUrl(req), form);
  };
  const callId = (req: FastifyRequest): string | null => {
    const id = (req.query as Record<string, unknown>).call;
    return typeof id === 'string' && CALL_ID_RE.test(id) ? id : null;
  };
  const twiml = (reply: FastifyReply, body: string): FastifyReply => reply.type('text/xml').send(body);

  async function guard(req: FastifyRequest, reply: FastifyReply): Promise<{ id: string; form: Form } | null> {
    const form = (req.body ?? {}) as Form;
    const id = callId(req);
    if (!signed(req, form)) {
      deps.log.warn({ path: req.url.split('?')[0] }, 'voice: rejected an unsigned or forged Twilio request');
      await reply.code(403).send();
      return null;
    }
    if (id === null) {
      await twiml(reply, HANGUP_TWIML);
      return null;
    }
    return { id, form };
  }

  app.post('/twilio/voice', async (req, reply) => {
    const ok = await guard(req, reply);
    if (ok === null) return reply;
    const greeting = deps.phone.greeting(ok.id);
    return twiml(reply, greeting === null ? HANGUP_TWIML : relayTwiml({ relayUrl: deps.phone.relayUrl(ok.id), greeting, languages: deps.phone.languages(ok.id) }));
  });

  app.post('/twilio/status', async (req, reply) => {
    const ok = await guard(req, reply);
    if (ok === null) return reply;
    deps.phone.onStatus(ok.id, ok.form);
    return twiml(reply, EMPTY_TWIML);
  });

  app.post('/twilio/amd', async (req, reply) => {
    const ok = await guard(req, reply);
    if (ok === null) return reply;
    deps.phone.onAmd(ok.id, ok.form);
    return twiml(reply, EMPTY_TWIML);
  });

  app.get('/twilio/relay', { websocket: true }, (socket, req) => {
    const id = callId(req);
    const header = req.headers['x-twilio-signature'];
    const wsUrl = `${deps.origin.replace(/^https:/, 'wss:')}${req.url}`;
    if (id === null || !validTwilioSignature(deps.authToken, typeof header === 'string' ? header : undefined, wsUrl)) {
      deps.log.warn('voice: rejected an unsigned ConversationRelay connection');
      socket.close(1008, 'forbidden');
      return;
    }
    if (!deps.phone.attach(id, socket)) socket.close(1008, 'unknown call');
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send());
  return app;
}

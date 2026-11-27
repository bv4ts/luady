import type { ChatSender } from '../../src/notices/router.js';
import { createFakeOutbound, type FakeOutbound } from '../helpers/fakes.js';

/** The chat channel id the fake reports while it is up (`settledVia` keeps it). */
export const CHAT_ID = 'test-channel';

/** The raw chat channel for the notice tests: the fake outbound, plus which channel took a send. */
export function createFakeChat(): FakeOutbound & ChatSender {
  const fake = createFakeOutbound();
  return Object.assign(fake, { channelId: () => (fake.isUp() ? CHAT_ID : null), declared: () => true });
}

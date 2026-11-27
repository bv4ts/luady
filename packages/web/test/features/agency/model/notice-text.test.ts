import { describe, expect, it } from 'vitest';
import { chatChannelName, noticeBody } from '../../../../src/features/agency/model/notice-text.js';
import { channelDto } from '../../../room-fixtures.js';

describe('chatChannelName', () => {
  it('names the given channel, else the primary one, else "your chat channel"', () => {
    const list = [channelDto({ id: 'pager', name: 'Pager', primary: false }), channelDto({ id: 'chatapp', name: 'Chat app' })];
    expect(chatChannelName(list, 'pager')).toBe('Pager');
    expect(chatChannelName(list, 'web')).toBe('Chat app');
    expect(chatChannelName(list)).toBe('Chat app');
    expect(chatChannelName([])).toBe('your chat channel');
    expect(chatChannelName([channelDto({ name: ' ' })])).toBe('your chat channel');
  });
});

describe('noticeBody', () => {
  it('drops the chat "reply to this message" hints, which mean nothing on the website', () => {
    const text = '🔴 *Needs your OK* · birch · qa  #EYXMYHNV\nWants to use *Bash*:\n```git push```\n'
      + '↩️ Reply *yes* to allow or *no* to deny (anything else = deny with your message).';
    expect(noticeBody(text)).toBe('🔴 *Needs your OK* · birch · qa  #EYXMYHNV\nWants to use *Bash*:\n```git push```');
    expect(noticeBody('✅ done\n↩️ Reply to this message to continue this session.')).toBe('✅ done');
  });

  it('keeps every other line, including a meeting reminder\'s "last time" line', () => {
    const text = '📅 Standup in 12 min\n↩️ Last time (Mon): the release';
    expect(noticeBody(text)).toBe(text);
    expect(noticeBody('Plain text')).toBe('Plain text');
  });
});

import { describe, expect, it } from 'vitest';
import { listWords, loginUsage, noLoginWaiting } from '../../src/claude-login/text.js';

describe('the chat sign-in texts name the fleet\'s own hosts, never fixed ones', () => {
  it('names the hosts of the demo fleet', () => {
    const demo = ['cedar', 'birch', 'ash', 'local'];
    expect(loginUsage(demo)).toBe('Usage: /login (signs Luady in) or /login cedar, birch, ash or local; /login codex connects ChatGPT for images');
    expect(noLoginWaiting(demo)).toBe('No sign-in is waiting. Send /login first (or /login cedar, birch, ash, local).');
  });

  it('follows any fleet, and leaves the host part out when there is none', () => {
    expect(loginUsage(['mars'])).toBe('Usage: /login (signs Luady in) or /login mars; /login codex connects ChatGPT for images');
    expect(loginUsage([])).toBe('Usage: /login (signs Luady in); /login codex connects ChatGPT for images');
    expect(noLoginWaiting(['mars', 'computer'])).toBe('No sign-in is waiting. Send /login first (or /login mars, computer).');
    expect(noLoginWaiting([])).toBe('No sign-in is waiting. Send /login first.');
  });

  it('lists words with "or" or "and" before the last', () => {
    expect([listWords([]), listWords(['a']), listWords(['a', 'b']), listWords(['a', 'b', 'c'], 'and')]).toEqual(['', 'a', 'a or b', 'a, b and c']);
  });
});

import { describe, expect, it } from 'vitest';
import { parseCardReports } from '../../src/board/reports.js';

describe('report parsing', () => {
  it('reads done, blocked and progress in any case and spacing', () => {
    expect(parseCardReports('#12 done: Login fixed')).toEqual([{ id: 12, verb: 'done', text: 'Login fixed' }]);
    expect(parseCardReports('#12 DONE : Login fixed')).toEqual([{ id: 12, verb: 'done', text: 'Login fixed' }]);
    expect(parseCardReports('  # 7   Blocked:no key  ')).toEqual([{ id: 7, verb: 'blocked', text: 'no key' }]);
    expect(parseCardReports('- #3 progress: half way')).toEqual([{ id: 3, verb: 'progress', text: 'half way' }]);
    expect(parseCardReports('#4 done:')).toEqual([{ id: 4, verb: 'done', text: '' }]);
  });

  it('reads several lines and ignores the rest', () => {
    const text = 'Summary of the work\r\n#1 done: a\nsee #2 done: inline does not count\n#2 blocked: b\n#x done: y\n#0 done: zero\n#3 finished: no';
    expect(parseCardReports(text)).toEqual([
      { id: 1, verb: 'done', text: 'a' },
      { id: 2, verb: 'blocked', text: 'b' },
    ]);
  });

  it('nothing to read', () => {
    expect(parseCardReports('The deploy is live: https://example.com')).toEqual([]);
    expect(parseCardReports('')).toEqual([]);
  });
});

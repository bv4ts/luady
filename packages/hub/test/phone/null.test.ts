import { describe, expect, it } from 'vitest';
import { createNullPhone } from '../../src/phone/null.js';

describe('createNullPhone', () => {
  it('is never enabled and its calls resolve without doing anything', async () => {
    const phone = createNullPhone();
    expect(phone.enabled()).toBe(false);
    await expect(phone.callForQuestion('ABCDEFGH')).resolves.toBeUndefined();
    await expect(phone.callOwner('owner asked')).resolves.toBeUndefined();
  });
});

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The label mixed into the sealing key. Fixed: changing it would leave every sealed row
 * (google_accounts.refresh_enc, wispr_auth.refresh_enc, jira_sites.token_enc) unreadable without a reseal.
 */
export const SEAL_LABEL = 'hub-seal-v1:';

export interface Sealer {
  seal(text: string): string;
  open(sealed: string): string;
}

/** AES-256-GCM with a key derived from the hub's session secret: tokens are never stored in clear. */
export function sealer(secret: string, label: string = SEAL_LABEL): Sealer {
  const key = createHash('sha256').update(`${label}${secret}`).digest();
  return {
    seal(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    open(sealed) {
      const raw = Buffer.from(sealed, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

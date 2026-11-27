import { readFile } from 'node:fs/promises';

/** The hub writes 32 random bytes as hex into `<dataDir>/addons/<id>.token` (mode 0600). */
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Reads an add-on token file. The token itself never appears in an error message. */
export async function readAddonToken(file: string): Promise<string> {
  const raw = await readFile(file, 'utf8').catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
    throw new Error(`addon-sdk: cannot read the token file ${file} (${code}); start the hub once with this add-on declared`);
  });
  const token = raw.trim();
  if (!TOKEN_RE.test(token)) throw new Error(`addon-sdk: the token file ${file} does not hold a token`);
  return token;
}

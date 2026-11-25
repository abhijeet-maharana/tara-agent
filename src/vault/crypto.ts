import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The vault's encryption: AES-256-GCM with a 32-byte key from `TARA_VAULT_KEY` (64 hex characters, or
 * base64), which lives in the root-only env file next to `APPROVAL_SEAL_KEY`. Each value is bound to its
 * login and purpose through the additional data, so a ciphertext copied to another row won't open.
 */

const VERSION = 'v1';

export class VaultKeyError extends Error {}

/** The key from its env value; throws on anything that isn't exactly 32 bytes. */
export function parseVaultKey(value: string): Buffer {
  const v = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.length !== 32)
    throw new VaultKeyError('TARA_VAULT_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32)');
  return key;
}

/** A short public fingerprint of the key, stored once so a wrong key is noticed before any write. */
export const keyCheck = (key: Buffer) =>
  createHash('sha256').update('tara-vault-check').update(key).digest('hex').slice(0, 16);

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function seal(key: Buffer, purpose: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`tara-vault:${VERSION}:${purpose}`));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** The plain text, or throws when the key, the purpose or the data don't match. */
export function open(key: Buffer, purpose: string, sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new VaultKeyError('Unknown vault value format');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`tara-vault:${VERSION}:${purpose}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultKeyError("This value can't be opened with the current TARA_VAULT_KEY");
  }
}

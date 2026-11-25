import { createHmac } from 'node:crypto';

/**
 * Authenticator codes (TOTP, RFC 6238) from the setup key a website shows next to its QR code: a base32
 * key, or an `otpauth://totp/…?secret=…` link (which may set the algorithm, digits and period).
 */
export interface Totp {
  secret: Buffer;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  digits: number;
  period: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean))
    throw new Error('The authenticator key is not valid base32 (A–Z, 2–7)');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A setup key or `otpauth://` link; throws with what to fix. */
export function parseTotp(input: string): Totp {
  const text = input.trim();
  if (!text.toLowerCase().startsWith('otpauth://'))
    return { secret: base32Decode(text), algorithm: 'sha1', digits: 6, period: 30 };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('The otpauth:// link is not valid');
  }
  if (url.host.toLowerCase() !== 'totp')
    throw new Error('Only time-based (otpauth://totp/) keys are supported');
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
  if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512')
    throw new Error(`Unknown algorithm "${algorithm}"`);
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  if (![6, 7, 8].includes(digits)) throw new Error('digits must be 6, 7 or 8');
  if (!Number.isInteger(period) || period < 10 || period > 300)
    throw new Error('period must be 10–300 seconds');
  return { secret: base32Decode(url.searchParams.get('secret') ?? ''), algorithm, digits, period };
}

/** The code for this moment (`at`, ms). */
export function totpCode(t: Totp, at: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / t.period)));
  const mac = createHmac(t.algorithm, t.secret).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0xf;
  const n = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(n % 10 ** t.digits).padStart(t.digits, '0');
}

/** Seconds until the code changes: a code about to expire is better waited out than typed. */
export const secondsLeft = (t: Totp, at: number) => t.period - (Math.floor(at / 1000) % t.period);

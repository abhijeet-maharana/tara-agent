import { createHash, createHmac, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import type { PhoneDevice, Store } from '../store/store.js';
import { type DashboardContext, esc, layout, pageHead, relative, section } from './dashboard.js';

/**
 * The desk phone (docs/jarvis-phone.md): the Android shell in `android/` pairs with tara-agent by
 * scanning a QR on the Phone page, then shows `/phone` full screen.
 *
 * Pairing: the QR holds the HTTPS host and port, the certificate's public key hash (SPKI SHA-256, so
 * the shell pins it) and a one-time code. The shell trades the code for a device key over the pinned
 * connection. The key stays in the shell (native calls only); the WebView gets a session cookie that
 * lasts a day, signed with the key's hash, so a leaked cookie is short-lived and dies with the device.
 *
 * Certificates are renewed in place (`tailscale cert`), often with a new key. Then the shell asks
 * `POST /phone/pin` for proof: an HMAC, under the device key's hash, of its nonce and the key the
 * server now serves. Only tara-agent knows that hash, so the shell can move its pin without a re-scan.
 */

/** A pairing code is good for this long, and once. */
const CODE_MS = 10 * 60_000;
/** The WebView's session cookie lasts this long; the shell renews it at start and twice a day. */
const SESSION_MS = 24 * 3_600_000;
/** Wrong pairing codes in a row before pairing is refused for a while (codes are 80 bits anyway). */
const MAX_MISSES = 20;
export const PHONE_COOKIE = 'tara_phone';

/** Where `npm run`/Gradle puts the shell's release APK: `android/apk/` at the repo root. */
export const DEFAULT_APK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../android/apk/tara-phone.apk',
);

export class PhoneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApkInfo {
  versionCode: number;
  versionName: string;
  sha256: string;
  size: number;
  file: string;
}

export interface CertInfo {
  /** The name the certificate is for (its first DNS name), which the phone connects to. */
  host: string;
  port: number;
  /** base64 SHA-256 of the certificate's SubjectPublicKeyInfo: what the phone pins. */
  spki: string;
}

export interface PhoneOptions {
  store: Store;
  /** The HTTPS listener (`http.tls`). Without it, phones can't pair. */
  tls?: { port: number; cert: string };
  /** The shell APK served for updates, with `tara-phone.json` ({versionCode, versionName}) beside it. */
  apk?: string;
  now?: () => number;
}

const b64url = (b: Buffer) => b.toString('base64url');
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const sameText = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest();

/** `tara-phone://pair?…`: what the QR says. The shell also opens it as a link (`adb shell am start -d`). */
export const pairingUri = (cert: CertInfo, code: string, name: string) =>
  `tara-phone://pair?${new URLSearchParams({ h: cert.host, p: String(cert.port), k: cert.spki, c: code, n: name })}`;

export class Phone {
  private readonly now: () => number;
  /** code → expiry. */
  private readonly codes = new Map<string, number>();
  private misses = 0;
  private certCache?: { mtime: number; info: CertInfo };
  private apkCache?: { key: string; info: ApkInfo };

  constructor(private readonly options: PhoneOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The certificate the HTTPS listener serves now (re-read when its file changes). */
  cert(): CertInfo | undefined {
    const tls = this.options.tls;
    if (!tls) return undefined;
    try {
      const mtime = statSync(tls.cert).mtimeMs;
      if (this.certCache?.mtime === mtime) return this.certCache.info;
      const x509 = new X509Certificate(readFileSync(tls.cert));
      const der = x509.publicKey.export({ type: 'spki', format: 'der' });
      const dns = /DNS:([^,\s]+)/.exec(x509.subjectAltName ?? '')?.[1];
      const host = dns ?? /CN=([^,\n]+)/.exec(x509.subject)?.[1] ?? 'localhost';
      const info = { host, port: tls.port, spki: createHash('sha256').update(der).digest('base64') };
      this.certCache = { mtime, info };
      return info;
    } catch {
      return undefined;
    }
  }

  /** A fresh one-time pairing code (older unused ones stay good until they expire). */
  newCode(): { code: string; expiresAt: number } {
    const at = this.now();
    for (const [c, exp] of this.codes) if (exp <= at) this.codes.delete(c);
    const code = b64url(randomBytes(10));
    const expiresAt = at + CODE_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** Trades a pairing code for a new device's id and key. The key is shown only this once. */
  pair(code: string, name: string): { id: string; key: string } {
    if (this.misses >= MAX_MISSES) throw new PhoneError(429, 'Too many wrong codes: show a new QR');
    const expiresAt = this.codes.get(code);
    if (!expiresAt || expiresAt <= this.now()) {
      this.misses++;
      throw new PhoneError(403, 'That pairing code is wrong or has expired: show a new QR');
    }
    this.codes.delete(code);
    this.misses = 0;
    const id = b64url(randomBytes(6));
    const key = b64url(randomBytes(32));
    this.options.store.addPhoneDevice({
      id,
      name: name.trim().slice(0, 60) || 'Phone',
      keyHash: sha256hex(key),
      createdAt: this.now(),
    });
    return { id, key };
  }

  /** The device an `Authorization: Device <id>:<key>` header belongs to. */
  deviceFromHeader(header: string | undefined): PhoneDevice | undefined {
    const m = /^Device ([\w-]+):([\w-]+)$/.exec(header ?? '');
    if (!m) return undefined;
    const device = this.options.store.phoneDevice(m[1] as string);
    return device && sameText(device.keyHash, sha256hex(m[2] as string)) ? device : undefined;
  }

  /** A session cookie value for the device's WebView: `<id>.<expiry>.<signature>`. */
  session(device: PhoneDevice, appVersion?: string): { session: string; expiresAt: number } {
    const at = this.now();
    this.options.store.seePhoneDevice(device.id, at, appVersion?.slice(0, 40));
    const expiresAt = at + SESSION_MS;
    const body = `${device.id}.${expiresAt}`;
    return { session: `${body}.${b64url(hmac(device.keyHash, body))}`, expiresAt };
  }

  /** The device a session cookie value belongs to, while it is valid. */
  deviceFromSession(value: string | undefined): PhoneDevice | undefined {
    const m = /^([\w-]+)\.(\d+)\.([\w-]+)$/.exec(value ?? '');
    if (!m || Number(m[2]) <= this.now()) return undefined;
    const device = this.options.store.phoneDevice(m[1] as string);
    if (!device) return undefined;
    const want = b64url(hmac(device.keyHash, `${m[1]}.${m[2]}`));
    return sameText(want, m[3] as string) ? device : undefined;
  }

  /** Proof for a paired phone that the certificate key it sees is the one tara-agent serves. */
  pinProof(id: string, nonce: string): { spki: string; proof: string } {
    const device = this.options.store.phoneDevice(id);
    const cert = this.cert();
    if (!device || !cert) throw new PhoneError(404, 'Unknown phone');
    if (!/^[\w-]{16,100}$/.test(nonce)) throw new PhoneError(400, 'Bad nonce');
    return { spki: cert.spki, proof: b64url(hmac(device.keyHash, `pin.${nonce}.${cert.spki}`)) };
  }

  /** The APK served for updates, if one has been built. */
  apk(): ApkInfo | undefined {
    const file = this.options.apk ?? DEFAULT_APK;
    const meta = file.replace(/\.apk$/, '.json');
    try {
      const st = statSync(file);
      const key = `${st.mtimeMs}:${st.size}:${statSync(meta).mtimeMs}`;
      if (this.apkCache?.key === key) return this.apkCache.info;
      const m = JSON.parse(readFileSync(meta, 'utf8')) as { versionCode?: unknown; versionName?: unknown };
      if (typeof m.versionCode !== 'number') return undefined;
      const info: ApkInfo = {
        versionCode: m.versionCode,
        versionName: String(m.versionName ?? m.versionCode),
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        size: st.size,
        file,
      };
      this.apkCache = { key, info };
      return info;
    } catch {
      return undefined;
    }
  }

  devices(): PhoneDevice[] {
    return this.options.store.phoneDevices();
  }

  forget(id: string): boolean {
    return this.options.store.forgetPhoneDevice(id);
  }
}

/** The QR as inline SVG (dark modules on white, so any camera reads it). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}

const PAIR_STYLE = `<style>
.pair{display:grid;grid-template-columns:minmax(0,300px) 1fr;gap:24px;align-items:start}
.qr{background:#fff;border-radius:var(--radius);padding:10px;max-width:300px}.qr svg{display:block;width:100%;height:auto}
.steps{margin:0;padding-left:20px;line-height:1.7}.steps code,.uri{font-size:12px;overflow-wrap:anywhere}
.uri{display:block;margin-top:8px;color:var(--text-dim)}
@media(max-width:700px){.pair{grid-template-columns:1fr}}
</style>`;

export interface PairPageData {
  cert?: CertInfo;
  code?: { code: string; expiresAt: number };
  devices: PhoneDevice[];
  apk?: ApkInfo;
  now: number;
}

/** The dashboard's Phone page: the pairing QR and the paired phones. */
export function pairPage(ctx: DashboardContext, d: PairPageData): string {
  const pairing =
    d.cert && d.code
      ? (() => {
          const uri = pairingUri(d.cert, d.code.code, ctx.agentName);
          return `<div class="pair"><div class="qr" role="img" aria-label="Pairing QR code">${qrSvg(uri)}</div>
<div><ol class="steps"><li>On the phone, turn on <b>Tailscale</b>.</li>
<li>Open the <b>Tara Phone</b> app and tap <b>Scan pairing QR</b>.</li>
<li>Scan this code. It works once, until ${esc(relative(d.code.expiresAt, d.now).replace(/^in /, 'about '))} from now; reload for a new one.</li></ol>
<p class="dim">The phone connects to <code>${esc(d.cert.host)}:${d.cert.port}</code> and pins its certificate key <code>${esc(d.cert.spki)}</code>.</p>
<details><summary class="dim">Pairing link</summary><code class="uri">${esc(uri)}</code></details></div></div>`;
        })()
      : `<p class="empty">Pairing needs HTTPS: set <code>http.tls</code> in the host config (e.g. with a <code>tailscale cert</code> certificate).</p>`;
  const devices = d.devices.length
    ? d.devices
        .map(
          (
            x,
          ) => `<div class="row"><span class="dot ${x.lastSeenAt && d.now - x.lastSeenAt < 36 * 3_600_000 ? 'ok' : 'dim'}"></span>
<span style="flex:1"><b>${esc(x.name)}</b><br><span class="dim">paired ${esc(relative(x.createdAt, d.now))} · last seen ${esc(
            relative(x.lastSeenAt, d.now),
          )}${x.appVersion ? ` · app ${esc(x.appVersion)}` : ''}</span></span>
<form method="post" action="/phone/devices/${esc(x.id)}/forget"><button class="btn danger" type="submit">Forget</button></form></div>`,
        )
        .join('')
    : '<p class="empty">No phone paired yet.</p>';
  const apk = d.apk
    ? `<p>Version <b>${esc(d.apk.versionName)}</b> (${d.apk.versionCode}), ${(d.apk.size / 1e6).toFixed(1)} MB. Paired phones are offered it on their own. First install: <code>adb install android/apk/tara-phone.apk</code>.</p>`
    : '<p class="empty">No APK built yet: <code>cd android && ./gradlew publishApk</code>.</p>';
  return layout(
    ctx,
    'Phone',
    'Phone',
    `${PAIR_STYLE}${pageHead('Phone', 'The desk phone: pair it here, then it shows <a href="/phone">/phone</a> full screen.')}${section(
      'Pair a phone',
      pairing,
    )}${section('Paired phones', devices)}${section('App', apk)}`,
  );
}

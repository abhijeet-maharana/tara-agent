import { execFileSync } from 'node:child_process';
import { createHash, createHmac, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Phone } from '../src/http/phone.js';
import { startHttpServer } from '../src/http/server.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const TOKEN = 'dash-token';

let dir: string;
let cert: string;
let store: Store;
let server: Server;
let base: string;
const apk = () => path.join(dir, 'tara-phone.apk');

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'tara-phone-'));
  cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=desk.example.ts.net',
      '-addext',
      'subjectAltName=DNS:desk.example.ts.net',
      '-keyout',
      path.join(dir, 'key.pem'),
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  store = new Store(':memory:');
  server = await startHttpServer({
    bind: '127.0.0.1',
    port: 0,
    token: TOKEN,
    // Only the Phone object reads it here; the HTTPS listener itself is covered in https.test.ts.
    scheduler: { list: () => [], plannedRuns: () => [] } as unknown as Scheduler,
    store,
    projects: [],
    log: silent,
    phoneApk: apk(),
    dashboard: { projects: [], timeZone: 'UTC', agentName: 'Jarvis' },
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('Phone (unit)', () => {
  it('reads the host and the public key hash from the certificate', () => {
    const phone = new Phone({ store, tls: { port: 4443, cert } });
    const x = new X509Certificate(readFileSync(cert));
    const want = createHash('sha256')
      .update(x.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    expect(phone.cert()).toEqual({ host: 'desk.example.ts.net', port: 4443, spki: want });
  });

  it('takes a code once, and refuses expired ones', () => {
    let t = 1_000;
    const phone = new Phone({ store, now: () => t });
    const { code } = phone.newCode();
    expect(phone.pair(code, 'Desk').key).toMatch(/^[\w-]{40,}$/);
    expect(() => phone.pair(code, 'Desk')).toThrow(/wrong or has expired/);
    const late = phone.newCode().code;
    t += 11 * 60_000;
    expect(() => phone.pair(late, 'Desk')).toThrow(/expired/);
  });

  it('signs sessions that end after a day or when the phone is forgotten', () => {
    let t = 5_000;
    const phone = new Phone({ store, now: () => t });
    const { id, key } = phone.pair(phone.newCode().code, 'Desk');
    const device = phone.deviceFromHeader(`Device ${id}:${key}`);
    expect(device?.id).toBe(id);
    expect(phone.deviceFromHeader(`Device ${id}:wrong`)).toBeUndefined();
    const { session } = phone.session(device as NonNullable<typeof device>, '0.1.0');
    expect(phone.deviceFromSession(session)?.id).toBe(id);
    expect(phone.deviceFromSession(session.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeUndefined();
    // Another expiry with the old signature: refused.
    const [, exp, sig] = session.split('.');
    expect(phone.deviceFromSession(`${id}.${Number(exp) + 1}.${sig}`)).toBeUndefined();
    t += 25 * 3_600_000;
    expect(phone.deviceFromSession(session)).toBeUndefined();
    t -= 25 * 3_600_000;
    phone.forget(id);
    expect(phone.deviceFromSession(session)).toBeUndefined();
  });
});

describe('/phone over HTTP', () => {
  it('pairs with the QR code, then the phone gets a session for its WebView', async () => {
    // The dashboard's Phone page needs the token, and shows the QR only with HTTPS set up.
    expect((await fetch(`${base}/phone/pair`)).status).toBe(401);
    const page = await (
      await fetch(`${base}/phone/pair`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).text();
    expect(page).toContain('Pairing needs HTTPS');
    // Codes are made only by the Phone page; anything else is refused.
    expect((await post('/phone/pair', { code: 'made-up-code' })).status).toBe(403);
  });

  it('serves /phone to a paired phone, for reads only', async () => {
    const tlsServer = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      token: TOKEN,
      tls: { port: 0, cert, key: path.join(dir, 'key.pem') },
      scheduler: { list: () => [], plannedRuns: () => [] } as unknown as Scheduler,
      store,
      projects: [],
      log: silent,
      phoneApk: apk(),
      dashboard: { projects: [], timeZone: 'UTC', agentName: 'Jarvis' },
    });
    const url = `http://127.0.0.1:${(tlsServer.address() as AddressInfo).port}`;
    try {
      const page = await (
        await fetch(`${url}/phone/pair`, { headers: { authorization: `Bearer ${TOKEN}` } })
      ).text();
      expect(page).toContain('<svg');
      const uri = /tara-phone:\/\/pair\?[^<\s]+/.exec(page)?.[0].replaceAll('&amp;', '&') as string;
      const q = new URL(uri).searchParams;
      expect(q.get('h')).toBe('desk.example.ts.net');
      expect(q.get('n')).toBe('Jarvis');

      const paired = await fetch(`${url}/phone/pair`, {
        method: 'POST',
        body: JSON.stringify({ code: q.get('c'), name: 'moto g34' }),
      });
      expect(paired.status).toBe(200);
      const { id, key } = (await paired.json()) as { id: string; key: string };

      // Not a token holder: no /phone without a session.
      expect((await fetch(`${url}/phone`)).status).toBe(401);
      expect(
        (
          await fetch(`${url}/phone/session`, {
            method: 'POST',
            headers: { authorization: `Device ${id}:x` },
          })
        ).status,
      ).toBe(401);
      const s = (await (
        await fetch(`${url}/phone/session`, {
          method: 'POST',
          headers: { authorization: `Device ${id}:${key}` },
          body: JSON.stringify({ version: '0.1.0 (7)' }),
        })
      ).json()) as { session: string; cookie: string };
      const jar = { cookie: `${s.cookie}=${s.session}` };
      const screen = await fetch(`${url}/phone`, { headers: jar });
      expect(screen.status).toBe(200);
      expect(await screen.text()).toContain('Needs you');
      // Reads elsewhere work (Phase 2 reads /attention, /runs, …); writes don't.
      expect((await fetch(`${url}/health`, { headers: jar })).status).toBe(200);
      expect((await fetch(`${url}/reload`, { method: 'POST', headers: jar })).status).toBe(401);
      // Nor can a phone make pairing codes.
      expect((await fetch(`${url}/phone/pair`, { headers: jar })).status).toBe(401);
      expect(store.phoneDevice(id)?.appVersion).toBe('0.1.0 (7)');

      // The pin proof: HMAC under the key's hash of the nonce and the served key.
      const nonce = 'n0nce-n0nce-n0nce-1234';
      const pin = (await (
        await fetch(`${url}/phone/pin`, {
          method: 'POST',
          body: JSON.stringify({ id, nonce }),
        })
      ).json()) as { spki: string; proof: string };
      expect(pin.spki).toBe(q.get('k'));
      const hash = createHash('sha256').update(key).digest('hex');
      expect(pin.proof).toBe(
        createHmac('sha256', hash).update(`pin.${nonce}.${pin.spki}`).digest('base64url'),
      );

      // Forgetting it on the dashboard ends its session.
      const forgot = await fetch(`${url}/phone/devices/${id}/forget`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        redirect: 'manual',
      });
      expect(forgot.status).toBe(303);
      expect((await fetch(`${url}/phone`, { headers: jar })).status).toBe(401);
    } finally {
      await new Promise((r) => tlsServer.close(r));
    }
  });

  it('streams the glance on /phone/events, to a phone or the token holder only', async () => {
    expect((await fetch(`${base}/phone/events`)).status).toBe(401);
    expect((await fetch(`${base}/phone/state`)).status).toBe(401);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const state = (await (await fetch(`${base}/phone/state`, { headers: auth })).json()) as {
      quiet: { from: string };
      approvals: { total: number };
    };
    expect(state.quiet.from).toBe('23:00');
    expect(state.approvals.total).toBe(0);
    expect((await fetch(`${base}/phone/run/nope`, { headers: auth })).status).toBe(404);

    const stop = new AbortController();
    const res = await fetch(`${base}/phone/events`, { headers: auth, signal: stop.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    while (!text.includes('event: state')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"build"');
    stop.abort();

    // The shell listens with its device key (alerts while the screen is off); a wrong key is refused.
    const phone = new Phone({ store });
    const { id, key } = phone.pair(phone.newCode().code, 'Desk');
    expect(
      (await fetch(`${base}/phone/events`, { headers: { authorization: `Device ${id}:x` } })).status,
    ).toBe(401);
    const native = new AbortController();
    const shell = await fetch(`${base}/phone/events`, {
      headers: { authorization: `Device ${id}:${key}` },
      signal: native.signal,
    });
    expect(shell.status).toBe(200);
    native.abort();
  });

  it('takes battery reports from a paired phone and shows the latest on the Phone page', async () => {
    const phone = new Phone({ store });
    const { id, key } = phone.pair(phone.newCode().code, 'Battery desk');
    const auth = { authorization: `Device ${id}:${key}` };
    expect((await post('/phone/telemetry', { battery: { level: 80 } })).status).toBe(401);
    expect((await post('/phone/telemetry', { battery: { level: 'full' } }, auth)).status).toBe(400);
    expect((await post('/phone/telemetry', { battery: { level: 140 } }, auth)).status).toBe(400);
    const ok = await post(
      '/phone/telemetry',
      { battery: { level: 81, charging: false, plugged: true, temperature: 31.5 } },
      auth,
    );
    expect(ok.status).toBe(200);
    const [b] = store.phoneBattery(id, 0);
    expect(b).toMatchObject({ level: 81, charging: false, plugged: true, temperature: 31.5 });
    expect(store.phoneDevice(id)?.lastSeenAt).toBeGreaterThan(0);
    const page = await (
      await fetch(`${base}/phone/pair`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).text();
    expect(page).toContain('battery 81 %, 31.5 °C');
    // Forgetting the phone drops its reports too.
    store.forgetPhoneDevice(id);
    expect(store.phoneBattery(id, 0)).toEqual([]);
  });

  it('serves the APK and its version to a paired phone', async () => {
    const phone = new Phone({ store });
    const { id, key } = phone.pair(phone.newCode().code, 'Desk');
    const auth = { authorization: `Device ${id}:${key}` };
    expect((await fetch(`${base}/phone/app.json`, { headers: auth })).status).toBe(404);
    writeFileSync(apk(), 'PK fake apk');
    writeFileSync(
      apk().replace(/\.apk$/, '.json'),
      JSON.stringify({ versionCode: 42, versionName: '0.1.0' }),
    );
    expect((await fetch(`${base}/phone/app.json`)).status).toBe(401);
    const info = (await (await fetch(`${base}/phone/app.json`, { headers: auth })).json()) as Record<
      string,
      unknown
    >;
    expect(info).toEqual({
      versionCode: 42,
      versionName: '0.1.0',
      size: 11,
      sha256: createHash('sha256').update('PK fake apk').digest('hex'),
    });
    const file = await fetch(`${base}/phone/app.apk`, { headers: auth });
    expect(file.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(await file.text()).toBe('PK fake apk');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http/server.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('HTTPS listener', () => {
  it('serves the same pages over TLS, next to plain HTTP', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tara-tls-'));
    const cert = path.join(dir, 'cert.pem');
    const key = path.join(dir, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const free = await new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const store = new Store(':memory:');
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      tls: { port: free, cert, key },
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      projects: [],
      log: silent,
    });
    const get = (url: string) =>
      new Promise<number>((resolve, reject) =>
        httpsGet(url, { rejectUnauthorized: false }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject),
      );
    expect(await get(`https://127.0.0.1:${free}/health`)).toBe(200);
    expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`)).status).toBe(
      200,
    );
    await new Promise((r) => server.close(r));
    // Closing the main server closes the HTTPS one too.
    await expect(get(`https://127.0.0.1:${free}/health`)).rejects.toThrow();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

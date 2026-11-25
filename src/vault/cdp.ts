import type { VaultPage } from './sign-in.js';

/**
 * A tab of a shared Chrome, driven over the DevTools protocol (`/json/new`, then the tab's WebSocket).
 * tara-agent opens it for one sign-in and closes it after; runs never get it (the tab-ownership hook
 * keeps them on their own tabs).
 */
export class CdpPage implements VaultPage {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(
    private readonly cdpUrl: string,
    private readonly targetId: string,
    private readonly ws: WebSocket,
    private readonly timeoutMs: number,
  ) {
    ws.addEventListener('message', (e) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const w = msg.id === undefined ? undefined : this.waiting.get(msg.id);
      if (!w || msg.id === undefined) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message ?? 'DevTools error'));
      else w.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const w of this.waiting.values()) w.reject(new Error('The browser tab closed'));
      this.waiting.clear();
    });
  }

  /** Opens a blank tab in the Chrome at `cdpUrl` (e.g. http://127.0.0.1:9222). */
  static async open(cdpUrl: string, timeoutMs = 15_000): Promise<CdpPage> {
    const res = await fetch(`${cdpUrl}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`The browser did not open a tab (${res.status})`);
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl?: string };
    if (!target.webSocketDebuggerUrl) throw new Error('The browser gave no DevTools address for the tab');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The browser tab did not answer')), 5_000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('Could not connect to the browser tab'));
        });
      });
    } catch (err) {
      await fetch(`${cdpUrl}/json/close/${target.id}`).catch(() => undefined);
      throw err;
    }
    const page = new CdpPage(cdpUrl, target.id, ws, timeoutMs);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // The tab stays in the background (nobody's view jumps to it) but behaves as if focused.
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    return page;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async url(): Promise<string> {
    const { frameTree } = await this.send<{ frameTree: { frame: { url: string } } }>('Page.getFrameTree');
    return frameTree.frame.url;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (r.exceptionDetails) throw new Error(`Page script failed: ${r.exceptionDetails.text ?? 'error'}`);
    return r.result.value as T;
  }

  async navigate(url: string): Promise<void> {
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (r.errorText) throw new Error(`Could not open the sign-in page (${r.errorText})`);
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const state = await this.evaluate<string>('document.readyState').catch(() => 'loading');
      if (state === 'complete') return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async pressEnter(): Promise<void> {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async close(): Promise<void> {
    try {
      this.ws.close();
    } catch {}
    await fetch(`${this.cdpUrl}/json/close/${this.targetId}`, { signal: AbortSignal.timeout(5_000) }).catch(
      () => undefined,
    );
  }
}

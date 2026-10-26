import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanPath, parseGrep, parseNumstat, parseStatus, RepoReader, snippet } from '../src/code/repo.js';
import type { Project } from '../src/config/schema.js';
import { startHttpServer } from '../src/http/server.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'tara-code-'));
const repo = path.join(root, 'shop');
const outside = path.join(root, 'secret.txt');
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
const EXCLUDE = ['**/.env*', '**/*.pem'];

beforeAll(() => {
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(outside, 'top secret\n');
  writeFileSync(path.join(repo, 'src/app.ts'), 'const a = 1;\nconst b = 2;\n');
  writeFileSync(path.join(repo, 'src/gone.ts'), 'bye\n');
  writeFileSync(path.join(repo, 'README.md'), '# Shop\n');
  writeFileSync(path.join(repo, '.env.production'), 'ENC[abc]\n');
  writeFileSync(path.join(repo, '.gitignore'), 'sessions/\n');
  symlinkSync(outside, path.join(repo, 'leak.txt'));
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  // Uncommitted: one edit, one staged new file, one deletion, one untracked file, an ignored secret.
  writeFileSync(path.join(repo, 'src/app.ts'), 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
  writeFileSync(path.join(repo, 'src/new.ts'), 'export {};\n');
  git('add', 'src/new.ts');
  unlinkSync(path.join(repo, 'src/gone.ts'));
  writeFileSync(path.join(repo, 'notes.md'), 'one\ntwo\n');
  mkdirSync(path.join(repo, 'sessions'));
  writeFileSync(path.join(repo, 'sessions/token.json'), '{"t":1}\n');
  // Mutagen never copies .env files to the other machine: deleted there, but must not show.
  unlinkSync(path.join(repo, '.env.production'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const reader = (gitDir = path.join(repo, '.git')) =>
  new RepoReader(
    { name: 'shop', title: 'Shop', dir: repo, gitDir, askIn: 'shop' },
    { exclude: EXCLUDE, stateDir: mkdtempSync(path.join(root, 'state-')) },
  );

describe('parsing', () => {
  it('reads porcelain status and numstat', () => {
    expect(parseStatus(' M a.ts\0?? b c.ts\0A  d.ts\0')).toEqual([
      { xy: ' M', path: 'a.ts' },
      { xy: '??', path: 'b c.ts' },
      { xy: 'A ', path: 'd.ts' },
    ]);
    expect(parseNumstat('3\t1\ta.ts\0-\t-\timg.png\0')).toEqual(
      new Map([
        ['a.ts', { added: 3, removed: 1, binary: false }],
        ['img.png', { added: 0, removed: 0, binary: true }],
      ]),
    );
  });

  it('reads git grep output and shortens long lines around the match', () => {
    expect(parseGrep('src/a.ts\x003\x00const x = 1;\nb c.md\x0012\x00hi\n')).toEqual([
      { path: 'src/a.ts', line: 3, text: 'const x = 1;' },
      { path: 'b c.md', line: 12, text: 'hi' },
    ]);
    const long = `${'a'.repeat(300)}NEEDLE${'b'.repeat(300)}`;
    const cut = snippet(long, 'needle');
    expect(cut).toContain('NEEDLE');
    expect(cut.startsWith('…') && cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan(200);
  });

  it('keeps paths inside the repo and out of .git', () => {
    expect(cleanPath('./src//app.ts')).toBe('src/app.ts');
    expect(cleanPath('')).toBe('');
    expect(cleanPath('src/')).toBe('src');
    for (const bad of ['../x', 'src/../../x', '/etc/passwd', '.git/config', 'a/.git/HEAD'])
      expect(() => cleanPath(bad), bad).toThrow(/inside the repo/);
  });
});

describe('RepoReader', () => {
  it('lists uncommitted changes with line counts, never ignored or excluded files', async () => {
    const status = await reader().status();
    expect(status.branch).toBe('main');
    expect(status.head?.subject).toBe('first');
    expect(status.changes).toEqual([
      { path: 'notes.md', state: 'untracked', staged: false, added: 2, removed: 0, binary: false },
      { path: 'src/app.ts', state: 'modified', staged: false, added: 2, removed: 1, binary: false },
      { path: 'src/gone.ts', state: 'deleted', staged: false, added: 0, removed: 1, binary: false },
      { path: 'src/new.ts', state: 'added', staged: true, added: 1, removed: 0, binary: false },
    ]);
  });

  it('shows diffs, a new file as all added lines', async () => {
    const r = reader();
    const edit = await r.diff('src/app.ts');
    expect(edit.text).toContain('-const b = 2;');
    expect(edit.text).toContain('+const c = 4;');
    expect((await r.diff('notes.md')).text).toBe('@@ -0,0 +1,2 @@\n+one\n+two');
    await expect(r.diff('README.md')).rejects.toMatchObject({ status: 404 });
  });

  it('serves only files git lists, and nothing through a symlink out of the repo', async () => {
    const r = reader();
    expect((await r.read('src/app.ts')).text).toContain('const c = 4;');
    expect((await r.tree('')).dirs).toEqual(['src']);
    expect((await r.tree('')).files).toEqual(['.gitignore', 'README.md', 'leak.txt', 'notes.md']);
    await expect(r.read('sessions/token.json')).rejects.toMatchObject({ status: 404 });
    await expect(r.read('.env.production')).rejects.toMatchObject({ status: 404 });
    await expect(r.read('leak.txt')).rejects.toMatchObject({ status: 403 });
    await expect(r.read('../secret.txt')).rejects.toMatchObject({ status: 400 });
    await expect(r.read('src/gone.ts')).rejects.toMatchObject({ status: 404 });
  });

  it('works from a copy of the git data elsewhere, without writing to it', async () => {
    const copy = path.join(root, 'replica.git');
    cpSync(path.join(repo, '.git'), copy, { recursive: true });
    const before = statSync(path.join(copy, 'index')).mtimeMs;
    const status = await reader(copy).status();
    expect(status.changes.map((c) => c.path)).toEqual([
      'notes.md',
      'src/app.ts',
      'src/gone.ts',
      'src/new.ts',
    ]);
    expect(statSync(path.join(copy, 'index')).mtimeMs).toBe(before);
  });

  it('searches file names and text, never ignored or excluded files', async () => {
    const r = reader();
    const hits = await r.search('CONST C');
    expect(hits.files).toEqual([]);
    expect(hits.matches).toEqual([{ path: 'src/app.ts', line: 3, text: 'const c = 4;' }]);
    expect((await r.search('notes')).files).toEqual(['notes.md']);
    expect((await r.search('"t":1')).matches).toEqual([]); // sessions/ is ignored
    expect((await r.search('ENC[')).matches).toEqual([]); // .env* is excluded
    expect((await r.search('nothing like this')).matches).toEqual([]);
    await expect(r.search('a')).rejects.toMatchObject({ status: 400 });
  });

  it('says when there is no git data', async () => {
    expect((await reader(path.join(root, 'nope')).status()).error).toMatch(/No git data/);
  });
});

describe('Code pages and API', () => {
  const project = {
    dir: repo,
    config: { name: 'shop', title: 'Shop', slackChannel: 'C1', allowedUsers: [] },
  } as unknown as Project;
  let base = '';
  let close = () => {};
  const asked: string[] = [];

  beforeAll(async () => {
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store: new Store(':memory:'),
      projects: ['shop'],
      log: { info() {}, warn() {}, error() {} },
      adminToken: 'key',
      decisionsFromLocal: true,
      code: {
        readers: [reader()],
        ask: async (_repo, title, prompt) => {
          asked.push(title, prompt);
          return { url: 'https://acme.slack.com/archives/C1/p1' };
        },
      },
      dashboard: { projects: [project], timeZone: 'UTC', agentName: 'Jarvis' },
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const page = (p: string) => fetch(`${base}${p}`, { headers: { accept: 'text/html' } });

  it('answers JSON for tools', async () => {
    const all = (await (await fetch(`${base}/code`)).json()) as {
      repos: Array<{ name: string; changes: [] }>;
    };
    expect(all.repos[0]).toMatchObject({ name: 'shop' });
    expect(all.repos[0]?.changes).toHaveLength(4);
    expect((await fetch(`${base}/code/shop/file?path=sessions/token.json`)).status).toBe(404);
    expect((await fetch(`${base}/code/nope`)).status).toBe(404);
  });

  it('renders the overview, changes, a diff, a folder and a file', async () => {
    expect(await (await page('/code')).text()).toContain('<b>4</b> changed files');
    expect(await (await page('/code/shop')).text()).toContain('/code/shop/diff?path=src%2Fapp.ts');
    const diff = await (await page('/code/shop/diff?path=src%2Fapp.ts')).text();
    expect(diff).toContain('<div class="add"><i>3</i><code>+const c = 4;</code></div>');
    expect(diff).toContain('Unlock this browser'); // no approvals cookie: no Ask box
    expect(await (await page('/code/shop/files?path=src')).text()).toContain('gone.ts');
    expect(await (await page('/code/shop/file?path=README.md')).text()).toContain('# Shop');
    expect((await page('/code/shop/file?path=..%2Fsecret.txt')).status).toBe(400);
  });

  it('searches one repo or all, with matches marked and linked to their line', async () => {
    const all = await (await page('/code?q=const+c')).text();
    expect(all).toContain('<mark>const c</mark> = 4;');
    expect(all).toContain('href="/code/shop/file?path=src%2Fapp.ts#L3"');
    expect(await (await page('/code/shop?q=notes')).text()).toContain('<mark>notes</mark>.md');
    expect(await (await page('/code/shop?q=zzzz')).text()).toContain('No matches.');
    const json = (await (await fetch(`${base}/code/shop?q=const+c`)).json()) as { matches: unknown[] };
    expect(json.matches).toHaveLength(1);
    expect((await fetch(`${base}/code?q=x`)).status).toBe(400);
    expect(await (await page('/code/shop/file?path=src%2Fapp.ts')).text()).toContain('<div id="L3">');
  });

  it('asks in Slack only from an unlocked browser, with the diff for Claude', async () => {
    const ask = (cookie?: string) =>
      fetch(`${base}/code/shop/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
        body: JSON.stringify({ path: 'src/app.ts', question: 'Safe to commit?' }),
      });
    expect((await ask()).status).toBe(403);
    const ok = await ask('tara_admin=key');
    expect(await ok.json()).toEqual({ url: 'https://acme.slack.com/archives/C1/p1' });
    expect(asked[0]).toBe('📄 `src/app.ts` in Shop: Safe to commit?');
    expect(asked[1]).toContain('+const c = 4;');
  });
});

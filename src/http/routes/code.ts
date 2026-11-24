import path from 'node:path';
import type { ServerContext } from '../context.js';
import { HttpError, readJson, str } from '../io.js';
import { type Route, type RouteRequest, route } from '../router.js';
import type { HttpOptions } from '../server.js';

/**
 * The Code page's API (read-only git, see docs/code-view.md):
 *   GET  /code                         each repo's branch, last commit and uncommitted changes
 *   GET  /code/<repo>                  one repo's changes; /diff?path=, /file?path=, /files?path= (a folder)
 *   GET  /code?q=, /code/<repo>?q=     search file names and text (every repo, or one)
 *   POST /code/<repo>/ask              {path, question} asks in Slack; needs the unlocked browser
 */
export function codeRoutes(c: ServerContext, code: NonNullable<HttpOptions['code']>): Route<unknown>[] {
  const reader = (r: RouteRequest) => c.codeReader(r.params.repo);
  const file = (r: RouteRequest) => r.url.searchParams.get('path') ?? '';
  return [
    route('GET /code', async ({ url }) => {
      const query = url.searchParams.get('q');
      if (query !== null) return { results: await c.searchAll(query) };
      return {
        repos: await Promise.all(
          code.readers.map(async (r) => ({ name: r.repo.name, title: r.repo.title, ...(await r.status()) })),
        ),
      };
    }),
    route('GET /code/:repo', (r) => {
      const query = r.url.searchParams.get('q');
      return query !== null ? reader(r).search(query) : reader(r).status();
    }),
    route('GET /code/:repo/diff', (r) => reader(r).diff(file(r))),
    route('GET /code/:repo/file', (r) => reader(r).read(file(r))),
    route('GET /code/:repo/files', (r) => reader(r).tree(file(r))),
    route('POST /code/:repo/ask', async (r) => {
      const repo = reader(r);
      c.human(r.req);
      const ask = code.ask;
      if (!ask || !repo.repo.askIn) throw new HttpError(404, 'Asking is off for this repo');
      const body = await readJson(r.req);
      const question = str(body.question)?.slice(0, 4_000);
      if (!question) throw new HttpError(400, '"question" is required');
      const target = str(body.path) ?? '';
      const changes = (await repo.status()).changes;
      // About the whole repo: the list of what changed (Claude reads the diffs itself, read-only).
      if (!target) {
        const lines = changes
          .slice(0, 300)
          .map((ch) => `${ch.state.padEnd(9)} ${ch.path} (+${ch.added} −${ch.removed})`)
          .join('\n');
        return ask(
          repo.repo,
          `📄 ${repo.repo.title}: ${question}`,
          `${question}\n\nAbout the uncommitted changes in the repo ${repo.repo.dir} (${changes.length} files${
            changes.length > 300 ? ', the first 300 listed' : ''
          }; run \`git diff\` there to read them). Only read and answer: don't commit, stage or change files.\n\`\`\`\n${lines}\n\`\`\``,
        );
      }
      const change = changes.find((ch) => ch.path === target);
      // The diff goes to Claude only: the thread shows the question.
      const diff = change ? (await repo.diff(target)).text.split('\n').slice(0, 400).join('\n') : '';
      return ask(
        repo.repo,
        `📄 \`${target}\` in ${repo.repo.title}: ${question}`,
        `${question}\n\nAbout the file \`${path.join(repo.repo.dir, target)}\`${
          change
            ? `, which has an uncommitted change (${change.state}). The diff against the last commit:\n\`\`\`diff\n${diff}\n\`\`\``
            : '.'
        }`,
      );
    }),
  ];
}

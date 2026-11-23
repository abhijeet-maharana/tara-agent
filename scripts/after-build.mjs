// After `tsc`: removes compiled files whose source is gone (dist/ is never wiped, so a running process
// never sees it empty), and writes dist/build.json, which GET /health shows: a hash of src/ and the time.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return []; // .DS_Store and the like differ between machines
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

let removed = 0;
for (const file of walk(path.join(root, 'dist'))) {
  const rel = path.relative(path.join(root, 'dist'), file).replace(/\.js(\.map)?$/, '').replace(/\.d\.ts$/, '');
  if (rel === 'build.json') continue;
  if (!existsSync(path.join(root, 'src', `${rel}.ts`))) {
    rmSync(file);
    removed++;
  }
}

const hash = createHash('sha256');
for (const file of walk(path.join(root, 'src')).sort()) hash.update(path.relative(root, file)).update(readFileSync(file));
const build = { source: hash.digest('hex').slice(0, 12), builtAt: new Date().toISOString() };
writeFileSync(path.join(root, 'dist', 'build.json'), `${JSON.stringify(build)}\n`);
console.log(`build ${build.source}${removed ? `, removed ${removed} stale files` : ''}`);

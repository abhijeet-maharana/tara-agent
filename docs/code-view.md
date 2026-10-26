# Code page

See what changed in your repos from a phone: each repo's uncommitted changes, their diffs, and a file browser, served by the dashboard at `/code`. Read-only. The agent edits files with full permissions, so being able to check what it touched without opening a laptop matters.

## What it shows

| Page | Shows |
|---|---|
| `/code` | One row per repo: branch, how many files changed (+/− lines), last commit |
| `/code/<repo>` | The changed files: **M** modified, **A** added, **D** deleted, **N** new and not added to git, **!** conflict; staged changes are marked in the tooltip |
| `/code/<repo>/diff?path=` | The change against the last commit (staged and unstaged together), line numbers, wrapped for a phone. A new file shows as all added lines. First 2,000 lines |
| `/code/<repo>/files?path=` | A folder: subfolders, files, and which of them changed |
| `/code/<repo>/file?path=` | A file with line numbers (up to 512 KB; binary files are named, not shown); `#L12` jumps to line 12 |
| `/code?q=`, `/code/<repo>?q=` | **Search** every repo (box on `/code`) or one (box on its page and folders): file names containing the text, and lines containing it (case-insensitive, literal, 5 per file, 200 in all), each linked to its line. Binary files are skipped |

The same paths answer JSON (`Accept: application/json`) for tools. `GET /code` returns every repo's status.

**Ask.** A diff or file page has a box to ask about it. It posts the question as a new thread in the project's Slack channel and starts a conversation there, as if the project `owner` had asked; Claude also gets the diff. Asking needs the browser unlocked on `/unlock` (the approvals key), like deciding approvals.

## Configuration

Host `config.yaml`. Without a `code` block, every project's repo is shown.

```yaml
code:
  enabled: true                 # default
  repos:                        # default: the projects
    - path: ~/Projects/shop
    - path: ~/Projects/tara-agent
      askIn: shop               # a repo that isn't a project: whose channel "Ask" uses
      title: tara-agent
    - path: ~/Projects/site
      gitDir: ~/git-copies/site.git   # git data somewhere else (see below)
  exclude: ['**/.env*', '**/*.pem', '**/*.key']   # default: never listed, shown or diffed
```

A repo that is a project takes its name and title from `.tara/config.json`; others use the folder name.

## How it reads git

- Git runs as the tara-agent user with `GIT_OPTIONAL_LOCKS=0` and a **private copy of the index** in `<stateDir>/code/`. It never writes to the repo or its git data, and never runs hooks, external diff tools or text conversion.
- The copy is refreshed from the repo's index whenever that changes (a commit, a stage), and refreshed against the working tree, so later checks only hash files that changed. Results are kept for 15 seconds.
- **Git data elsewhere (`gitDir`).** The working tree can come from one machine and the git data from another. Example: code is edited on a laptop and synced to the server without `.git` (Mutagen with `--ignore-vcs`); add a second, one-way session that copies the laptop's `.git` to the server, and point `gitDir` at the copy:
  ```sh
  mutagen sync create --name=site-git --mode=one-way-replica --no-ignore-vcs \
    --default-file-mode=0640 --default-directory-mode=0750 --default-group-beta=<group tara-agent is in> \
    --ignore='*.lock' --ignore='fsmonitor--daemon*' \
    ~/Projects/site/.git server:~/git-copies/site.git
  ```
  The page then shows the same changes as `git status` on the laptop, plus anything edited on the server, even while the laptop is off. Files the sync doesn't copy but git tracks would show as deleted: add them to `exclude`.

## Safety

- Only files git lists are served or searched: tracked, or untracked and **not ignored**. Ignored secrets (sessions, tokens, `node_modules`) never are; `exclude` hides tracked ones too.
- Paths are relative to the repo; `..`, absolute paths and anything in `.git` are refused, and so is a symlink that resolves outside the repo.
- The pages sit behind the dashboard's `allowFrom` and `TARA_HTTP_TOKEN` like every other page. Source code is sensitive: keep `allowFrom` to your own network.
- Asking starts a Claude conversation, so it needs the unlock cookie from another device, as decisions do.

## Code

- `src/code/repo.ts`: `RepoReader` (status, files, tree, read, diff, search with `git grep --untracked`), path checks, `codeReaders()` from the host config
- `src/http/code.ts`: the pages
- `src/http/server.ts`: routes, and `POST /code/<repo>/ask`; `src/index.ts` wires Ask to Slack and the session manager
- Tests: `test/code.test.ts` (a real temp repo: every change kind, ignored and excluded files, traversal, a symlink out, a copied git dir left untouched, search, pages, Ask)

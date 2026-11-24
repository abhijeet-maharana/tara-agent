# @tara-agent/kit

Shared code for a project's own service (a small Node server next to tara-agent that owns the project's data and pages). Install it as a local dependency and copy it into each release:

```json
"dependencies": { "@tara-agent/kit": "file:../../tara-agent/packages/kit" }
```

It is TypeScript source (no build step): run the service with `tsx`, or bundle it. Node 22.13 or later.

| Import | What it gives you |
|---|---|
| `@tara-agent/kit` | Everything below |
| `@tara-agent/kit/http` | `HttpError`, `handle` (JSON routes), `tailnetOnly`, `writeGuard`, `hostAndOrigin`, `adminCookie` (person-only routes), `clientIp`, `uiPrefix` |
| `@tara-agent/kit/tara` | `taraClient` (`ask`, `propose`, `runJob`, `jobs`, `call`), `taraThread`, `TaraError` |
| `@tara-agent/kit` only | `openDb` (SQLite, WAL, numbered migrations from `<repo>/.tara/db/migrations`), `DataApi` and `loadTables` (the data API behind the dashboard's Data tab and the agents' data tools) |

The subpaths don't load `node:sqlite`, so a service on older Node type definitions can use them. A TypeScript project with `"moduleResolution": "node"` ignores package `exports`; map the subpaths for types:

```json
"paths": { "@tara-agent/kit/*": ["./node_modules/@tara-agent/kit/src/*"] }
```

## Access rules (`http`)

The service listens on all interfaces with no user accounts. People reach it through tara-agent's dashboard, which proxies `/app/<project>/*` to it from this machine and forwards the browser's address (`x-forwarded-for`), the host it asked for (`x-forwarded-host`) and the path prefix (`x-tara-prefix`). Forwarded headers count only from loopback, and only to narrow access.

| Rule | Use on | Lets through |
|---|---|---|
| `writeGuard` | every request (`app.use`) | reads from anywhere; writes as `tailnetOnly` |
| `tailnetOnly` | writes | this machine and the tailnet; a browser only from a page on a known host |
| `hostAndOrigin` | every request (optional, stricter) | a known `Host`, and browser writes only from the same origin |
| `adminCookie({ cookie, token }).humanOnly` | approve, edit, release | `tailnetOnly` plus a cookie holding a token agents can't read |

Known hosts: IP literals, `localhost`, this machine's hostname, `*.ts.net`, and the names in `$TARA_HOST_NAMES` (comma-separated).

# Contributing

tara-agent is a personal project that runs a real business's automation. Pull requests and issues are welcome; support is best-effort and there are no promises on response times.

## Setup

```sh
npm ci
npm run typecheck && npm run lint && npm test
```

Node ≥ 22.13. Tests don't need Slack or a Claude login: the CLI is replaced by `test/fixtures/fake-claude.mjs` and Slack by `test/fakes.ts`. The MCP end-to-end test starts the real MCP server through `tsx`.

## Guidelines

- **Never call the Anthropic API or reuse Claude credentials.** Everything goes through the official `claude` binary. PRs that add token handling, header spoofing or account pooling will be closed.
- Keep it small and dependency-light. New runtime dependencies need a good reason.
- Add tests for behaviour changes. Fixtures of CLI output must be sanitised (no real paths, ids or content).
- Match the existing style: Biome formats and lints (`npm run format`), comments explain why rather than what.
- Update the README or `docs/` in the same PR when behaviour or config changes, and add a line to `CHANGELOG.md`.

## Releases

Versions follow semver. Tag `vX.Y.Z` after updating `package.json` and `CHANGELOG.md`.

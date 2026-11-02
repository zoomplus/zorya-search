# Contributing

Thanks for helping improve Zorya Search. This guide describes the `v0.1.7` preview, whose runtime/source basis is `3be35fd`; the prepared package metadata/documentation snapshot is `ee82077827bc0e099ae63fd2e44c5c512c9f2ba7` and leaves compiled runtime files unchanged. Before opening an issue or pull request, check the [v0.1.7 release page](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.7) for actual asset availability, install only an asset listed there, and verify the package version. Use an npm version or `next` tag only if the registry actually lists it. The historical `v0.1.6` archive has an earlier capability set.

## Issues and pull requests

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for a reproducible defect and the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for a user problem or proposed capability.
- Keep reports focused. Include the package/source version, Node version, operating system, transport (SDK, stdio, or HTTP), a minimal reproduction, observed result, and expected result when relevant.
- Never include API keys, tokens, private repository contents, user data, or unredacted configuration/logs in an issue or pull request.
- Pull requests should explain the behavior changed, compatibility implications, and checks run. Add focused tests for code changes and update the relevant docs for public API/CLI changes.
- Do not claim provider, hosted-client, Windows-device, or broad retrieval quality based only on a local fixture or source test.

## Local checks

The repository uses Node.js `>=20.19.0` and pnpm `9.15.9` in CI. From a clean checkout, install dependencies and run the shared build/type checks:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm pack:dry-run
```

Choose the test command for the Node version you are using:

- Node 20 or 22: `pnpm test`
- Node 24: `pnpm test:node24` (the CI-compatible WebAssembly wrapper)

The PostgreSQL integration job also uses `pnpm test:node24`. Run PostgreSQL integration tests only against a unique disposable database that you own. Before any write, verify `SELECT current_database()` through the same pool the tests will use; never point `ELEMENT_DATABASE_URL` at an application, shared, or user database.

The code retrieval paths are designed to remain bounded, cancellable, and tied to current source identity. Preserve caller control, explicit opt-in for provider-backed behavior, and compatibility for existing SDK/MCP adapters. Do not add automatic repository writes or hidden backfill as part of a read operation.

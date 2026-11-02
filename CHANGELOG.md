# Changelog

## 0.1.11 source candidate — not published

This source candidate adds `zorya-search-bridge`, a separate local stdio MCP entry with explicit client/server configuration. It binds the actual current workspace and native per-call conversation identity, transfers changed source bytes only for explicit indexing or synchronization, and forwards the existing Search MCP calls without changing their contracts. Reads do not trigger synchronization or indexing. Ordinary ChatGPT receives no local project-file access.

The candidate also adds `serve-remote-ip --config PATH --policy PATH`, an explicit IP/CIDR-allowlisted MCP mode on the loopback daemon. The strict policy binds a canonical public HTTPS resource URL and exact Host, requires allowed origins, and grants a principal explicit roots and operations. Optional trusted proxy CIDRs enable a single `X-Real-IP` value; bearer/OAuth and IP mode cannot be combined. MCP tool metadata advertises `noauth` only in this explicit mode; server-side grants and root filtering remain active. No provider or capability is enabled automatically.

The intended public web-only target is `https://startzorya.com/mcp/search`; it has no project roots/data or project read/index grants. The separate private workspace target is `https://startzorya.com/mcp/search/workspace`. Both are configuration targets, not deployed endpoints. This source candidate does not establish npm/GitHub publication, production deployment, ChatGPT UI support, or production endpoint acceptance. Check the release page and registry for availability. See [workspace bridge guidance](docs/workspace-bridge.md).

## 0.1.10 — 2026-11-02

Published to npm on 2026-11-02 and available as the GitHub prerelease [`v0.1.10`](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.10). At that publication date, npm `next` pointed to `0.1.10`; `latest` intentionally remained `0.1.9`.

- Add typed capability availability and grant reasons, plus trusted task-specific MCP tool guidance.
- Add incremental `configure` roles for project text, public web reading, Brave discovery, visual retrieval, code embeddings, project-text embeddings, and Jev classification. Setup asks for consent, keeps secrets in the local hidden terminal or explicit env reference, and never enables providers automatically.
- Report `mcpReconnectRequired` after profile changes; callers reconnect and refresh tools and capabilities. A configured profile is not provider-health verification.
- Keep public URL reading and lexical project-text setup keyless. Brave discovery uses a Brave Search key; Voyage and Jev model profiles use an OpenRouter key.
- Preserve existing roots, data and profiles. A restarted watch-enabled owner may resume its already configured indexing policy. On POSIX secret files use mode `0600`; this is not encryption or proof of Windows ACL protection.

Four native Codex CLI onboarding scenarios passed for the tested fixture, including a keyless public URL read; no Search provider HTTP calls were made.

## 0.1.9 — 2026-11-02

This source changes the npm package identity from the historical scoped name `@zorya/search` to `zorya-search` and updates package metadata and installed-consumer instructions. Before installing, verify that the release page and npm registry list the exact `v0.1.9` tag and `zorya-search@0.1.9` version.

- Preserve all `0.1.8` runtime features and public APIs; this is an identity and packaging migration only.
- Keep `--result-presentation structured` opt-in for `mcp` and `client-config`; `legacy` remains the default.
- Do not reinterpret historical `v0.1.8` assets, scoped package metadata, release evidence, or URLs as `v0.1.9` publication evidence.

No runtime behavior changes are included in this package identity migration.

## 0.1.8 preview — 2026-11-02

Historical source behavior is based on [`af0a1ed`](https://github.com/zoomplus/zorya-search/tree/af0a1ed6faa9dd912798d28af8401bd8026964c6). The `v0.1.8` release/package retained the historical scoped name `@zorya/search`; check that release's own page and registry separately. These facts do not establish `v0.1.9` availability. This candidate retained the previously published `0.1.7` capabilities.

- Add an opt-in `--result-presentation structured` mode to the local stdio proxy and generated client configuration. `legacy` remains the default.
- In structured mode, replace only an exact duplicate JSON text block with `See structuredContent.`; keep structured fields, source identity, independent content, and metadata intact.
- Add [result-presentation guidance](docs/mcp-result-presentation.md) for the structured MCP transport option.

Native Codex CLI checks verified structured fields and source identity for the tested client and payload.

## 0.1.7 preview — 2026-11-02

Runtime behavior in this preview is based on source `3be35fdbe69357a4bb0daf6203d9472b5c5a184d`. The prepared `v0.1.7` package metadata/documentation snapshot is `ee82077827bc0e099ae63fd2e44c5c512c9f2ba7`; compiled runtime files are unchanged. Check the [v0.1.7 release page](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.7) for actual asset availability; use a listed asset and verify its installed version before relying on these capabilities. The [historical v0.1.6 release](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.6) provides a separate archive with the earlier capability set.

- Add a separate opt-in project-text index for documentation, rules, and skills.
- Add exact symbol and reference queries, bounded static call tracing, and opt-in logical code context.
- Add opt-in Jev-backed classification and reuse context with shared classifier port and explicit grants.
- Add caller-selected multi-query Brave discovery; Search does not generate the additional queries.
- Add typed, snapshot-bound source-read recovery guidance for bounded EOF reads.
- Keep lexical code search as the default; preserve separate code, project-text, web, and visual model spaces.
- Update SDK, CLI, MCP, setup, and client skill guidance to describe actual capability and release boundaries.

## 0.1.6 — public GitHub archive

The historical archive includes lexical and optional embedding-backed code search, source reading, bounded context, duplicate candidates, SDK/CLI/MCP interfaces, and the then-published optional web, classification, and visual capabilities. It does not include the project-text index, exact symbol/reference tools, static call tracing, logical context, multi-query web discovery, or source-read recovery in the current preview.

See the [capability matrix](docs/capabilities.md) for version-specific details and limitations.

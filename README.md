# Zorya Search

**Local-first code and project-text retrieval for existing SDK and MCP clients, with optional embeddings, static symbol evidence, and caller-controlled web discovery.**

**[Читать по-русски](README.ru.md)**

[![CI](https://github.com/zoomplus/zorya-search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zoomplus/zorya-search/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/zoomplus/zorya-search)](LICENSE)
[![Node.js >=20.19](https://img.shields.io/badge/Node.js-%3E%3D20.19-339933?logo=node.js&logoColor=white)](package.json)

Zorya Search lets an existing application or agent search an approved repository, inspect current source behind a result, and gather bounded related evidence. Use its Node.js SDK or expose the same operations through MCP. Search returns candidates with source identity and known limits; the caller decides when to search, what to trust, and what to do next. It does not create agents, edit files, or automatically repair a project.

## What it provides

| Need | Capability |
| --- | --- |
| Find and verify code | Lexical search by default; optional embedding retrieval; bounded source reads and context tied to repository, worktree, and snapshot. |
| Inspect structure | Exact symbol lookup, static references and call tracing, duplicate candidates, and opt-in logical context. Static evidence does not establish runtime behavior. |
| Search project guidance | A separate, opt-in project-text index for documentation, rules, and skills. It does not share the code or knowledge namespace. |
| Find public sources | Caller-selected Brave discovery queries and bounded page reading, when configured. Search does not generate extra queries. |
| Integrate with a client | Node.js SDK, local stdio/loopback MCP, or an owner-hosted remote MCP endpoint with separately configured OAuth. |

The code path is lexical unless the owner enables an embedding profile. Optional presets include code `voyageai/voyage-code-4` (1024 dimensions) with `voyageai/rerank-2.5-lite`, project text `voyageai/voyage-4-large` with separate document/query roles, and independent visual `voyageai/voyage-multimodal-3.5`. These are opt-in configurations, not defaults. Reranking only reorders candidates. Classification and reuse context use the pinned Jev model `typesafe/jev-1.14`; unsupported classifier models are rejected rather than silently substituted.

## Release availability

Version **`0.1.10`** of `zorya-search` was published on npm on 2026-11-02 and is available as the GitHub prerelease [`v0.1.10`](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.10). At its 2026-11-02 publication, npm `next` pointed to `0.1.10` and `latest` intentionally remained `0.1.9`. This release adds trusted MCP capability availability and task-specific tool guidance, plus a consent-based `configure` command for seven independent roles. Agents can offer owner setup only when a needed capability is not configured; they do not enable it automatically or replace the caller. Public URL reading and local project-text lexical search need no provider key. Brave discovery uses a Brave Search key; Voyage and Jev model presets use an OpenRouter key. After a profile change, reconnect the MCP client and refresh its tool list and capabilities. Configure does not probe providers; restarting an already watch-enabled owner can resume its existing indexing policy. See the [MCP](docs/mcp.md), [CLI](docs/cli.md), and [client guidance](docs/agent-clients.md) guides for safe setup and limits.

Source candidate `v0.1.11` adds an explicit IP/CIDR allowlist mode for a remote MCP endpoint via `serve-remote-ip`. The daemon stays on loopback; the owner configures the HTTPS proxy, exact Host and Origin values, trusted proxy CIDRs if used, and principal/root/operation grants. This mode is separate from OAuth and rejects requests that also carry Authorization. The intended public target `https://startzorya.com/mcp/search` is web-only, with no project roots/data or project read/index grants; it is a configuration target, not evidence of a deployed endpoint. Check the release page and registry for availability. See the [MCP](docs/mcp.md) and [CLI](docs/cli.md) guides.

The same source candidate adds `zorya-search-bridge`, a local Codex stdio adapter for explicit workspace transfers to a separately configured private Search server. It does not change Search tools or grant ordinary ChatGPT access to local project files. The public web-only target `https://startzorya.com/mcp/search` and private workspace target `https://startzorya.com/mcp/search/workspace` are configuration targets only; neither is presented as deployed. See the [workspace bridge guide](docs/workspace-bridge.md). This candidate is not yet published to npm or GitHub.

These version-pinned commands install the published `0.1.10` release. They require Node.js `>=20.19.0`; see the [English](docs/getting-started.en.md) and [Russian](docs/getting-started.md) quickstarts.

Install the exact version and create a first profile:

```sh
npm install --save-exact zorya-search@0.1.10
npx --yes zorya-search@0.1.10 setup --root .
npx --yes zorya-search@0.1.10 client-config
```

`client-config` prints MCP registration instructions; it does not install or register the server in a client. The owner registers the chosen entry and grants access. Indexing is explicit unless the owner enables watch.
## SDK example

This example uses lexical SDK APIs available in `zorya-search@0.1.10`, with source verification and duplicate candidates. Import from `zorya-search` and its subpaths. Keep the database outside the indexed repository.

```js
import { openEmbeddedDatabase } from 'zorya-search'
import { createCodeIndex } from 'zorya-search/code'

const root = '/absolute/path/to/repository'
const database = await openEmbeddedDatabase('/absolute/path/to/private/search-data')
const index = createCodeIndex({ database })
try {
  await index.indexRepository({ root })
  const result = await index.searchCode({ root, query: 'initiative trigger', mode: 'lexical', limit: 5 })
  const hit = result.hits[0]
  const source = hit && await index.readSource({
    root, path: hit.path, lineStart: hit.lineStart, lineEnd: hit.lineEnd, snapshotId: hit.snapshotId,
  })
  const duplicates = await index.findCodeDuplicates({ root, limit: 5 })
  console.log({ hits: result.hits, source: source?.text, duplicates: duplicates.groups })
} finally {
  try { await index.close() } finally { await database.close() }
}
```

The lexical example makes no embedding-provider call. Search returns candidates; verify the source and decide whether any duplicate is relevant. See the [SDK reference](docs/sdk.md) for the package capabilities and ownership details.

## Guides

- [Getting started (English)](docs/getting-started.en.md) · [Начало работы (русский)](docs/getting-started.md)
- [Capabilities and release boundaries](docs/capabilities.md)
- [SDK](docs/sdk.md) · [CLI](docs/cli.md) · [MCP](docs/mcp.md)
- [Project text and web discovery](docs/project-text.md)
- [Agent client guidance](docs/agent-clients.md)
- [Local workspace bridge source candidate](docs/workspace-bridge.md)
- [Architecture](docs/architecture.md) · [Service flows](docs/service-flows.md)
- [Jev classification and reuse](docs/jev-classification.md) · [Voyage profiles](docs/voyage-profiles.md)
- [MCP result presentation and native evidence](docs/mcp-result-presentation.md)
- [Changelog](CHANGELOG.md) · [Code retrieval skill](skills/code-retrieval/SKILL.md) · [Web retrieval skill](skills/web-source-retrieval/SKILL.md)

MIT License. See [LICENSE](LICENSE).

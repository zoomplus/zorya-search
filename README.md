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

The current source/package version is **`v0.1.9`** with the unscoped npm name `zorya-search`. This changes package identity and packaging only; it retains the `v0.1.8` runtime, public APIs, CLI behavior, and defaults. Structured MCP stdio presentation remains opt-in and `legacy` remains the default. Before installing, verify that the release page and npm registry list the exact `v0.1.9` tag and `zorya-search@0.1.9` version, then check the installed name and version. The previous `v0.1.8` release record and native caller evidence remain in the [result-presentation guide](docs/mcp-result-presentation.md).

After the registry lists exact version `zorya-search@0.1.9` and the `v0.1.9` release/tag is verified, install with Node.js `>=20.19.0`:

```sh
npm install --save-exact zorya-search@0.1.9
npm ls zorya-search --depth=0
npx --yes zorya-search@0.1.9 setup --root .
npx --yes zorya-search@0.1.9 client-config
```

Run these version-pinned commands only after verifying the exact GitHub tag and registry version. The historical `v0.1.8` archive retains its original package identity and release facts; see [the changelog](CHANGELOG.md).

The previously published [`v0.1.7` release](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.7) is the prior capability baseline; it does not include structured stdio presentation. The historical [`v0.1.6` GitHub archive](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.6) remains a still earlier, separate installation option. Those releases used the scoped package name recorded in their historical instructions. `client-config` prints examples; an owner separately registers one in the chosen client and grants access. Indexing is explicit unless the owner selected watch. See the [English quickstart](docs/getting-started.en.md), [Russian quickstart](docs/getting-started.md), and [capability matrix](docs/capabilities.md).

## SDK example

This example uses lexical SDK APIs retained through candidate `v0.1.9`, with source verification and duplicate candidates. Import from `zorya-search` and its subpaths. Keep the database outside the indexed repository.

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

The lexical example makes no embedding-provider call. Search returns candidates; verify the source and decide whether any duplicate is relevant. See the [SDK reference](docs/sdk.md) for the current candidate capabilities and ownership details.

## Guides

- [Getting started (English)](docs/getting-started.en.md) · [Начало работы (русский)](docs/getting-started.md)
- [Capabilities and release boundaries](docs/capabilities.md)
- [SDK](docs/sdk.md) · [CLI](docs/cli.md) · [MCP](docs/mcp.md)
- [Project text and web discovery](docs/project-text.md)
- [Agent client guidance](docs/agent-clients.md)
- [Architecture](docs/architecture.md) · [Service flows](docs/service-flows.md)
- [Jev classification and reuse](docs/jev-classification.md) · [Voyage profiles](docs/voyage-profiles.md)
- [MCP result presentation and native evidence](docs/mcp-result-presentation.md)
- [MCP comparison evidence and limits](docs/mcp-comparison.md)
- [Changelog](CHANGELOG.md) · [Code retrieval skill](skills/code-retrieval/SKILL.md) · [Web retrieval skill](skills/web-source-retrieval/SKILL.md)

**Status:** package and current-source checks do not establish broad end-answer quality, hosted-client support, a Windows/game/device integration, live-provider behavior, or full-program acceptance. The four-run stdio presentation check is limited to native Codex CLI 0.163.0 transport and source preservation; it does not establish answer quality or billing savings. The negative controlled MCP quality comparison remains published with its scope and limitations in [the comparison guide](docs/mcp-comparison.md). Ordinary search and file-reading tools may be sufficient for a task.

MIT License. See [LICENSE](LICENSE).

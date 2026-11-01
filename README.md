# Zorya Search

**Repository code search and retrieval for SDK and MCP clients, with optional code embeddings, semantic search, and reranking.**

**[Читать по-русски](README.ru.md)**

[![CI](https://github.com/zoomplus/zorya-search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zoomplus/zorya-search/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/zoomplus/zorya-search)](LICENSE)
[![Node.js >=20.19](https://img.shields.io/badge/Node.js-%3E%3D20.19-339933?logo=node.js&logoColor=white)](package.json)

Zorya Search gives an existing app or agent a fast way to search an approved repository, inspect the current source behind a result, and gather related evidence. Use the SDK from a Node.js service or expose the same capabilities to a client through MCP. Search returns bounded source-backed results; the caller decides when to search, what to trust, and what to do next.

It is useful for questions such as “where is this initiative trigger handled?”, checking callers and tests around a known symbol, or finding repeated code bodies worth reviewing. It can also find and read public web sources when the owner enables web access. It does not replace the agent, edit files, or automatically repair a project.

## What it can do

| Need | Search provides |
| --- | --- |
| Find code and verify it | Lexical or configured embedding-backed retrieval, current source reads, bounded context, paths, line ranges, and snapshot identity. |
| Explore code structure | Duplicate candidates in release `v0.1.6`; current-main source adds exact symbol lookup, static references/call tracing, and opt-in logical context. |
| Retrieve other sources | Optional Brave web discovery and page reading; classification (pinned Jev in current source candidate) and caller-provided visual references. |
| Connect an existing client | Node.js SDK, local stdio/loopback MCP, or owner-hosted remote MCP with separately configured OAuth. |

The default code path is lexical and makes no model-provider call. Optional code embeddings and reranking use the code-specialized `voyageai/voyage-code-4` and `voyageai/rerank-2.5-lite` preset. Current source candidate `0a584e6` adds the shared Jev Decisions port, `getReuseContext` SDK and `get_reuse_context` MCP tool, plus the large symbol-limit correction. These additions, like the separate project-text index and caller-selected multi-query web discovery, are not in archive `v0.1.6`; npm publication is pending. See the [Jev and reuse guide](docs/jev-classification.md) for migration and limits. MCP exposes tools to a client; it does not impose a workflow or make Search autonomous.

## Install the available release

Node.js `>=20.19.0` is required. The currently available artifact is the GitHub release archive `v0.1.6`:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.6/zorya-search-0.1.6.tgz
npm exec -- zorya-search setup --root .
npm exec -- zorya-search client-config
```

`client-config` prints connection examples; you register one with your chosen client, grant only the required access, and start indexing explicitly with `npm exec -- zorya-search index`. Installation alone does not connect a client or start indexing. See the [English quickstart](docs/getting-started.en.md) or [Russian quickstart](docs/getting-started.md).

## SDK example

This runnable example uses the public `v0.1.6` SDK, lexical search, current-source verification, and duplicate candidates. Install the archive above and save this as `search.mjs` in that Node.js project:

```js
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { openEmbeddedDatabase } from '@zorya/search'
import { createCodeIndex } from '@zorya/search/code'

const rootInput = process.env.ZORYA_SEARCH_ROOT
const dataInput = process.env.ZORYA_SEARCH_DATA_DIR
if (!rootInput || !dataInput || !isAbsolute(rootInput) || !isAbsolute(dataInput)) {
  throw new Error('Set absolute ZORYA_SEARCH_ROOT and ZORYA_SEARCH_DATA_DIR paths')
}

const root = resolve(rootInput)
const dataDir = resolve(dataInput)
const dataFromRoot = relative(root, dataDir)
if (dataFromRoot === '' || (!dataFromRoot.startsWith(`..${sep}`) && dataFromRoot !== '..' && !isAbsolute(dataFromRoot))) {
  throw new Error('ZORYA_SEARCH_DATA_DIR must be outside the indexed repository')
}

const database = await openEmbeddedDatabase(dataDir)
const index = createCodeIndex({ database })
try {
  await index.indexRepository({ root })
  const result = await index.searchCode({
    root,
    query: 'initiative trigger',
    mode: 'lexical',
    limit: 5,
  })
  const hit = result.hits[0]
  const source = hit
    ? await index.readSource({
        root,
        path: hit.path,
        lineStart: hit.lineStart,
        lineEnd: hit.lineEnd,
        snapshotId: hit.snapshotId,
      })
    : undefined
  const duplicates = await index.findCodeDuplicates?.({ root, limit: 5 })
  console.log({ hits: result.hits, source: source?.text, duplicates: duplicates?.groups })
} finally {
  try {
    await index.close()
  } finally {
    await database.close()
  }
}
```

Run it with absolute paths; keep the database outside the repository:

```sh
ZORYA_SEARCH_ROOT=/absolute/path/to/repository \
ZORYA_SEARCH_DATA_DIR=/absolute/path/to/private/search-data \
node search.mjs
```

The sample is read-only with respect to source files and does not call an embedding provider. Index creation and database use are explicit. The caller can inspect duplicate groups and decide whether any are worth reviewing; Search does not merge or change them. It uses the default index limits; for a large repository, set suitable validated limits for your project as described in the [CLI guide](docs/cli.md) or [SDK reference](docs/sdk.md).

## Which version has which features?

The GitHub archive `v0.1.6` includes code search/source reading/context, duplicate candidates, indexing/status, and optional web and classification capabilities. Current source adds exact symbol/reference queries, bounded static call tracing, `includeLogical`, and opt-in Jev-backed reuse context. `includeLogical` is off by default and independent of `includeRelated`; its coverage and omissions are explicit, and it does not claim complete runtime calls or dynamic dispatch. These additions are source-only and are not in archive `v0.1.6`.

Archive `v0.1.6` does not contain the project-text index. Current source has a separate capability for documentation, rules, and skills in supported text formats including `.md`, `.mdc`, `.txt`, `AGENTS.md`, and `SKILL.md`. See the [project text and web discovery guide](docs/project-text.md) for SDK, CLI, and MCP examples, and the [capability guide](docs/capabilities.md) for version availability.

## Guides

- [Getting started (English)](docs/getting-started.en.md) · [Начало работы (русский)](docs/getting-started.md)
- [Capabilities and version boundaries (Russian)](docs/capabilities.md)
- [SDK reference (Russian)](docs/sdk.md)
- [Project text and caller-controlled web discovery (Russian, current source)](docs/project-text.md)
- [MCP, local service, and remote OAuth (Russian)](docs/mcp.md)
- [CLI setup and operation (Russian)](docs/cli.md)
- [Connect agent clients (Russian)](docs/agent-clients.md)
- [Architecture (Russian)](docs/architecture.md)
- [Changelog](CHANGELOG.md)
- [Code retrieval skill (Russian)](skills/code-retrieval/SKILL.md)
- [Web-source retrieval skill (Russian)](skills/web-source-retrieval/SKILL.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Project status

The historical main snapshot passed its recorded source and package checks. The new Jev/reuse candidate has its own scoped evidence and remaining gates; neither statement claims hosted ChatGPT, user-device/game, paired agent quality, or full-program acceptance. The public GitHub artifact remains `v0.1.6`; npm publication has not happened. Use Search when its repository index, current-source identity, or configured retrieval capabilities help. Ordinary search and file-reading tools may be all a task needs.

MIT License. See [LICENSE](LICENSE).

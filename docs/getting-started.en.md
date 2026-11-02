# Getting started with Zorya Search

This guide describes source candidate `v0.1.8` at source [`af0a1ed`](https://github.com/zoomplus/zorya-search/tree/af0a1ed6faa9dd912798d28af8401bd8026964c6). It retains the previously published `v0.1.7` capabilities and adds an opt-in local MCP stdio result presentation mode. Before installing, check the [v0.1.8 release page](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.8) for a listed asset; verify npm version/tag separately for registry installs.

## 1. Install the preview package

Use Node.js `>=20.19.0`. When the release page lists `zorya-search-0.1.8.tgz`, install it in the project that will own Search:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.8/zorya-search-0.1.8.tgz
npm ls @zorya/search --depth=0
```

The URL command is a recipe for that asset, not confirmation that it is available. If you choose npm, first confirm that the registry lists `0.1.8` under the `next` tag; then you can run `npm install --save-exact @zorya/search@next`. Use `@zorya/search@0.1.8` only after verifying that exact registry version. Do not use unqualified `latest` or `npx` to fetch an unavailable version. GitHub archive installation does not depend on npm account access.

## 2. Create a runtime config

For local lexical code search and project-text, choose this initial `setup` option:

```sh
npm exec -- zorya-search setup --root .
npm exec -- zorya-search client-config
```

New `setup` without provider flags creates `projectText: {}`: lexical code and project-text search stay local, with no models or cloud requests. `client-config` only prints examples and does not register a client.

### Optional cloud configuration

If the profile already has the required environment variables for OpenRouter and Brave Search API, you can choose this `setup` option instead of the local block above:

```sh
npm exec -- zorya-search setup --root . \
  --code-env OPENROUTER_API_KEY \
  --text-env OPENROUTER_API_KEY \
  --jev-env OPENROUTER_API_KEY \
  --web-env BRAVE_SEARCH_API_KEY
npm exec -- zorya-search client-config
```

Choose only one of the two initial `setup` options; do not run them sequentially for one config. These flags name existing environment variables, never key values: code, text, and Jev refer to an OpenRouter transport variable, while `web` separately refers to the Brave Search API variable. They are not direct Voyage or TypeSafe keys. Omitting only `--text-env` keeps project-text lexical and local but disables its text embedding; omit all cloud flags for a fully local configuration. The TTY wizard does not ask about Jev, so pass `--jev-env` explicitly to enable that optional capability. Do not put secrets in argv or client JSON.

Setup flags are initial config choices, not sequential updates. If a config already exists, setup refuses to overwrite it. To edit an existing runtime JSON, stop the service first and preserve its current `dataDir`, roots, and other settings. Pass the same `--config PATH` to setup/client-config/index/service. Keep the config and data directory outside the indexed root.

## 3. Connect the client and index the root

The owner separately registers a selected `client-config` example with an existing client and grants the required access. Then start initial indexing explicitly:

```sh
npm exec -- zorya-search index
```

Indexing does not edit source files. Watch runs only when the owner enables it in config. Do not run a second service owner against the same database directory.

For code, start with `search_code` and verify the returned range with `read_source`; bounded `get_code_context` and duplicate candidates are separate requests. Use only APIs present in the installed version. See the [capability matrix](capabilities.md), [SDK](sdk.md), [CLI](cli.md), and [MCP](mcp.md) guides.

## Choose stdio result presentation

Candidate `v0.1.8` lets a local MCP stdio proxy use `structured`, which replaces only a text block that exactly repeats the JSON in `structuredContent`. The default remains `legacy`. Use the supported CLI entrypoints:

```sh
npm exec -- zorya-search mcp --result-presentation structured
npm exec -- zorya-search client-config --result-presentation structured
```

`client-config` prints a profile; register it with the client separately. Keep `legacy` if an integration reads only text blocks or has not been checked with this representation. Native caller evidence covers Codex CLI 0.163.0 on Linux only; it does not establish support for hosted ChatGPT, Cursor, or other clients. See the [guide](mcp-result-presentation.md) for evidence and limits.

## Previously published versions

The earlier [`v0.1.7` release](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.7) does not include structured stdio presentation; keep its default `legacy` behavior. The historical [`v0.1.6` archive](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.6) also lacks later project-text, symbol/reference, multi-query web, and source-read recovery capabilities. Use version-specific documentation for either older release.

## Web and limits

Brave discovery requires `--web-env`; reading a known public URL uses the separate web reader and `web` grant, not the Brave key. `additionalQueries` is supplied by the caller; Search does not generate it. Code, project-text, web, classifier, and visual profiles are independent.

Doctor reports `providerProbed: false` and `providerProbe: 'not-run'`: it checks configuration and local owner status, not provider health. Remote MCP requires infrastructure you operate, an HTTPS proxy, and an OAuth issuer; Search is not a hosted service. See [MCP](mcp.md), [project text and web discovery](project-text.md), [Jev](jev-classification.md), and [Voyage profiles](voyage-profiles.md) for details.

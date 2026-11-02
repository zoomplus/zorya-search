# Getting started with Zorya Search

The public archive is still `v0.1.6`. Candidate `v0.1.7` is at source commit [`3be35fd`](https://github.com/zoomplus/zorya-search/tree/3be35fdbe69357a4bb0daf6203d9472b5c5a184d) and has not been published. The install command below installs `v0.1.6`, which does not include candidate project-text, symbol/reference, multi-query web, or typed source-read recovery features. There is no public npm install or future release URL for `v0.1.7` yet.

## 1. Install the available archive

Use Node.js `>=20.19.0`. Install the package in the project that will own Search:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.6/zorya-search-0.1.6.tgz
```

## 2. Create a runtime config for archive `v0.1.6`

For local lexical search and MCP:

```sh
npm exec -- zorya-search setup --root .
npm exec -- zorya-search client-config
```

`setup` creates a config once; `client-config` only prints examples and does not register a client. The `v0.1.6` archive supports optional code retrieval and Brave discovery, for example:

```sh
npm exec -- zorya-search setup --root . \
  --code-env OPENROUTER_API_KEY \
  --web-env BRAVE_SEARCH_API_KEY
```

This command and the short setup command above are **alternative initial config choices**; choose one and do not run them in sequence for the same config. `--code-env` names the OpenRouter environment variable; `--web-env` names the Brave Search API variable. Use credentials already configured for those providers. Do not put key values in argv or client JSON. Archive `v0.1.6` does not support `--text-env`, `--jev-env`, or project-text.

These flags are for initial config creation. `setup` refuses to overwrite an existing file. Preserve its `dataDir`, roots, and other settings when editing an existing runtime JSON; stop the service first and edit the current file explicitly. Pass the same `--config PATH` to setup/client-config/index/service. Keep the config and data directory outside the indexed root.

## 3. Connect the client and index the root

The owner separately registers a suitable `client-config` example with an existing client and grants the required access. Then start initial indexing explicitly:

```sh
npm exec -- zorya-search index
```

Indexing does not edit source files. Watch runs only when the owner enables it in config. Do not run a second service owner against the same database directory.

For code, start with `search_code` and verify the returned range with `read_source`; bounded `get_code_context` and duplicate candidates are separate requests. Candidate `v0.1.7` adds a separate project-text index, exact symbol/reference/static-call tools, `includeLogical`, reuse, and caller-selected `additionalQueries`. Use only APIs present in the installed version. See the [capability matrix](capabilities.md), [SDK](sdk.md), [CLI](cli.md), and [MCP](mcp.md) guides.

## Review the candidate locally

To review `v0.1.7`, first install the specific locally prepared candidate tarball or source checkout provided separately by its owner. There is no public install command yet; do not invent a future release URL. After installation, check the package version, exports, and actual SDK/MCP schema.

With candidate `v0.1.7` installed, use this command **instead of** the `v0.1.6` initial setup above:

```sh
npm exec -- zorya-search setup --root . \
  --code-env OPENROUTER_API_KEY \
  --text-env OPENROUTER_API_KEY \
  --jev-env OPENROUTER_API_KEY \
  --web-env BRAVE_SEARCH_API_KEY
```

Here `--code-env`, `--text-env`, and `--jev-env` refer to an existing OpenRouter environment variable; they do not take direct Voyage or TypeSafe keys. `--web-env` separately refers to the Brave Search API variable. The options store variable names, not values. The TTY wizard does not offer a Jev setup question; pass `--jev-env` explicitly to enable Jev. Candidate setup creates `projectText: {}` and enables lexical project-text search even without `--text-env`; this default does not apply to installed `v0.1.6`. Choose exactly one initial `setup` command; do not run them sequentially on the same config. `setup` refuses to overwrite an existing file; edit an existing runtime config separately while preserving its roots and `dataDir`.

## Web and limits

Brave discovery requires `--web-env`; reading a known public URL uses the separate web reader and `web` grant, not the Brave key. `additionalQueries` is supplied by the caller; Search does not generate it. Code, project-text, web, classifier, and visual profiles are independent.

Doctor reports `providerProbed: false` and `providerProbe: 'not-run'`: it checks configuration/local owner status, not provider health. Remote MCP requires infrastructure you operate, an HTTPS proxy, and an OAuth issuer; Search is not a hosted service. See [MCP](mcp.md), [project text and web discovery](project-text.md), [Jev](jev-classification.md), and [Voyage profiles](voyage-profiles.md) for details.

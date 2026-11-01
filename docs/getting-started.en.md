# Getting started with Zorya Search

This guide installs the available GitHub archive `v0.1.6`. New APIs on current main are documented separately and are not in that archive. The npm registry package has not been published.

## 1. Install the release archive

Use Node.js `>=20.19.0`. Install the pinned archive in the project that will own Search:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.6/zorya-search-0.1.6.tgz
```

## 2. Create one configuration

Choose **one** first-setup option. Both create a configuration in the default user directory and leave client registration to you.

### Local lexical search only

```sh
npm exec -- zorya-search setup --root .
```

### Code profile and web discovery

If you want embeddings/reranking for code and Brave link discovery, set both profiles when creating that same configuration:

```sh
npm exec -- zorya-search setup --root . \
  --code-env OPENROUTER_API_KEY \
  --web-env BRAVE_SEARCH_API_KEY
```

These are alternatives; do not run both. The options contain environment-variable names only. The values must be available to the service owner process and stay out of command arguments, client JSON, and the repository. When enabled, the code profile may send source chunks and queries to the configured provider. Without it, code search remains local and lexical. Web discovery and web text embeddings are separate settings.

For a non-default config location, pass the same `--config` path to setup and every later CLI command:

```sh
npm exec -- zorya-search setup --config /absolute/path/runtime.json --root /absolute/path/repository
npm exec -- zorya-search client-config --config /absolute/path/runtime.json
npm exec -- zorya-search index --config /absolute/path/runtime.json
```

Replace the example paths with your own absolute paths. Keep the config and data directory outside the indexed repository. More profile and limit options are in the [CLI guide](cli.md).

### If you already have a configuration

`setup` refuses to overwrite an existing config. Do not run it again with the same path. If the service is running, stop it first with `npm exec -- zorya-search service --stop --config /absolute/path/runtime.json` (omit `--config` for the default path). Back up and edit the existing runtime JSON according to the [CLI schema and profile guidance](cli.md), preserving its `dataDir`, roots, and other settings. Then restart that same service using its usual launch method. Keep using the same `--config` path for `client-config`, `index`, and `service`. Choosing another setup path creates a separate profile; it does not update the existing service.

## 3. Connect your client and index

After creating the config, print connection examples:

```sh
npm exec -- zorya-search client-config
```

The command only prints options such as stdio; it does not register MCP in Codex or an editor, or connect Search to a chat. Add the selected config to your existing client and grant only the access it needs. Then start the initial index explicitly:

```sh
npm exec -- zorya-search index
```

For a non-default config, pass the same `--config /absolute/path/runtime.json` to `client-config` and `index`. Indexing updates the local database and does not edit source files. Use `root-add` for additional approved repositories. Do not run a second service owner against the same database directory.

For a text lookup, start with `search_code` and `read_source`; `get_code_context` gathers bounded sections. For example, search for an initiative trigger and verify the current source and tests yourself. Duplicate candidate discovery is a separate optional query. Current-main symbol/reference tools and `includeLogical` are not in archive `v0.1.6`; no tool defines a mandatory workflow.

For a Node.js application, use the SDK instead of MCP. The [README SDK example](../README.md#sdk-example) runs against the public `v0.1.6` archive, indexes a local repository, verifies the current snapshot before reading source, and prints duplicate candidates.

## Web and other optional profiles

Archive `v0.1.6` can search links through Brave, read a known URL when the web reader and client permission are enabled, classify supplied text, and search caller-provided visual references when the owner enables that profile. These are independent capabilities, not required steps for code search. Search does not capture the desktop or fetch images by URL. See the [CLI guide](cli.md) for setup and the [MCP guide](mcp.md) for permissions.

Remote MCP requires infrastructure you operate: the daemon stays on loopback, your HTTPS reverse proxy publishes the endpoint, and an external OIDC/OAuth provider authenticates users. This is not a hosted service. Local checks do not establish hosted ChatGPT support or qualify an arbitrary production identity provider. See the [remote MCP guide](mcp.md).

## Indexed files and current-source features

Current indexing supports `.md`/`.mdx` and selected source/config formats. It does not index `.mdc` or `.txt`. A separate embeddings feature for repository docs, rules, and skills has been requested but is not implemented. See the [capability guide](capabilities.md) for the release/current-main feature matrix.

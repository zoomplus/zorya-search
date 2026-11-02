# Changelog

## 0.1.7 candidate — 2026-11-02

This is a review candidate at source `3be35fdbe69357a4bb0daf6203d9472b5c5a184d`. It has **not** been published to npm or GitHub Releases. The publicly available archive remains `v0.1.6`; do not treat these notes as an install link.

- Add a separate opt-in project-text index for documentation, rules, and skills.
- Add exact symbol and reference queries, bounded static call tracing, and opt-in logical code context.
- Add opt-in Jev-backed classification and reuse context with shared classifier port and explicit grants.
- Add caller-selected multi-query Brave discovery; Search does not generate the additional queries.
- Add typed, snapshot-bound source-read recovery guidance for bounded EOF reads.
- Keep lexical code search as the default; preserve separate code, project-text, web, and visual model spaces.
- Update SDK, CLI, MCP, setup, and client skill guidance to describe actual capability and release boundaries.

No claim is made that these changes improve general answer quality. The controlled MCP comparison did not meet its predeclared quality requirements; see [the comparison report](docs/mcp-comparison.md). Archive installation, npm publication, user-device acceptance, and full-program acceptance remain separate checks.

## 0.1.6 — public GitHub archive

The available archive includes lexical and optional embedding-backed code search, source reading, bounded context, duplicate candidates, SDK/CLI/MCP interfaces, and the then-published optional web, classification, and visual capabilities. It does not include the project-text index, exact symbol/reference tools, static call tracing, logical context, multi-query web discovery, or source-read recovery added in the current candidate.

See the [capability matrix](docs/capabilities.md) for version-specific details and limitations.

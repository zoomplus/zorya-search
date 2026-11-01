# Changelog

This changelog records selected public-facing capability changes. It does not imply that an unreleased source change is present in a published archive.

## Unreleased on current main

- Added optional SDK/MCP symbol lookup, reference lookup, and bounded static call tracing. Symbol queries support exact `symbolId` and full-range `enclosing` filters; source readers report optional `fileLineCount`.
- Added opt-in logical context for SDK `getCodeContext` and MCP `get_code_context`. It can include statically proven contracts, callees, callers, and test owners, with explicit block coverage, limits, and omissions. It does not claim complete runtime-call coverage. The existing default response and independent `includeRelated` option remain unchanged.

These are current-source features and are not included in the available GitHub archive `v0.1.6`.

## GitHub archive `v0.1.6`

- Added code duplicate candidates with exact matching and a renamed mode limited to local/parameter symbols recognized by the TypeScript checker. The capability was not present in archive `v0.1.5`; see the [SDK reference](docs/sdk.md) for its limits and result fields.

The GitHub archive is the available release artifact. The npm registry package has not been published.

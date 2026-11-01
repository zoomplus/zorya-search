## Change

Describe the user-visible behavior and the reason for the change.

## Scope and compatibility

- [ ] Existing SDK/MCP callers and stored index behavior remain compatible, or the change documents the migration.
- [ ] Provider-backed behavior remains explicit and opt-in.
- [ ] The change does not introduce automatic edits to indexed repositories.

## Verification

List the exact commands run and their results. If checks were not run, say why.

## Data and security

- [ ] No credentials, private source, or user data are included in this diff or its logs.
- [ ] Any PostgreSQL integration test used a unique disposable database I own, verified with `SELECT current_database()` on the same pool before writes.
- [ ] Public docs and examples describe only behavior available in the stated version.

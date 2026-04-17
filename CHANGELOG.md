# Changelog

## [0.1.27] - 2026-04-17

### Features

- **Tape query scoping**: Added `scope` (`session`/`project`) and `anchorScope` (`current-session`/`project`) to `tape_search` and `tape_read`
- **Cross-session tape reads**: `MemoryTapeService` can now load entries from all sessions of the current project when using `scope: "project"`
- **Session-aware anchor resolution**: Anchor lookup now prefers current-session matches when requested, then falls back to project scope

### Fix

- **Path traversal hardening**: Added safe path resolution for `memory_read`, `memory_write`, and `memory_list`
- **Memory status init check**: `memory_sync(status)` now validates both `core/user` and `.git` on disk instead of relying on runtime flag state
- **Frontmatter consistency**: `memory_write` now preserves original `created` date when updating files
- **Init workflow robustness**: `memory_init` now checks project memory dir state and ensures default structure/files after successful sync

### Improvements

- **Smart selector scope upgrade**: `MemoryFileSelector` smart mode now evaluates tape entries in project scope (cross-session) and uses the latest project anchor timestamp as the recency boundary
- **Settings hot reload**: Runtime re-reads `settings.json`, and `localPath` updates immediately (with `~` expansion)
- **Auto-anchor lifecycle**: Moved threshold auto-anchor handling to a single `tool_result` listener and reset tape selectors when tape mode is disabled
- **Selector token budgeting**: Conversation selection now trims from newest entries and restores chronological output order

## [0.1.26] - 2026-04-16

### BreakingChange

**Tape Mode Refactor - Data Source Migration**

Major architectural changes to tape mode:

- **Data source change**: Now reads from pi session file instead of separate tape JSONL
- **Local storage simplified**: Only maintains anchor index, no longer stores full tape entries
- **New directory structure**: `{localPath}/TAPE/anchor-index/{project}__anchors.jsonl`

## [0.1.25] - 2026-04-14

### Features

- **Memory search enhancement**: Multi-mode search with custom grep support
- `tools.ts`: Extended search parameters for flexible content matching

## [0.1.24] - 2026-04-11

### Fix

- Fixed `scanDir` base path handling
- Return actual git error messages instead of generic ones

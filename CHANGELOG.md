# Changelog

## [Unreleased]

I'am sorry for so many default settings changes like the tapePath in tape-mode these days. But all these default settings remain customizable.

The reason is I’m thinking hard about the base logic in pi-memory-md, both the code side and the design side.

More stable chassis, longer mileage.

There’s still a lot of logic problems in the code I need to tidy up before next step.

After more than half a month of daily use and iteration, tape-mode is much more stable now.

### Features

- **Tape `/tree` compatibility**: Mirror tape anchors into pi `/tree` labels so anchored nodes are visible directly in the tree navigator. Customize the `/tree` anchor label prefix in setting with `"labelPrefix": "⚓ "`.
- **Anchor deletion tool**: Added `tape_delete` so tape anchors can be removed by id, with `/tree` mirrored labels resynced after deletion.

### Changes

- **Configurable anchor path**: Now `settings.tape.tapePath` customize where anchor index files are stored. Defaults to `{localPath}/TAPE`. The dumb `anchor-index` folder was removed.
- **Tape runtime consolidation**: Collapsed separate tape service / selector / runtime key fields into a single `activeTapeRuntime` object.
- **Session lifecycle anchors**: Tape now uses `session/new` for new-session entry points and `session/resume` for continued-session entry points instead of flattening everything into `session/start`.
- **Git sync noise reduction**: Session-start pull and session-end push now skip redundant syncs, and successful no-op syncs no longer notify the user.

  This was really annoying!

### Fix

- **Auto-anchor defaults restored**: Threshold-based auto anchors work when users do not explicitly set `settings.tape.anchor.mode`; the default mode is now correctly treated as `"threshold"`.
- **Runtime state simplification**: Removed the unused repo initialization ref and reshaped `index.ts` state around the current extension behavior: tape tool registration, session-start hook coordination, initial memory injection, and active tape runtime.
- **Tape + system-prompt alignment**: Tape mode now follows the same append semantics as normal `system-prompt` mode by appending to `event.systemPrompt` instead of replacing it.
- **Tree label resync cleanup**: Tape `/tree` label syncing now clears all anchor-prefixed labels in the current session tree before rebuilding, preventing stale auto-anchor labels from appearing on multiple entries.

## [0.1.29] - 2026-04-21

### Warning

- Old `autoSync.onSessionStart` is still supported and normalized into the new hooks config, but migration to `hooks` is recommended.

### Features

- **Hooks-based session actions**: Replaced the old `autoSync` model with `hooks.sessionStart` and `hooks.sessionEnd`, allowing multiple actions per trigger and future custom hook actions.

### Fix

- **Settings reload semantics**: Aligned `pi-memory-md` settings behavior with native pi runtime semantics. Settings are now loaded on extension initialization and applied on runtime reload.

### Improvements

- **Partial memory reads**: Added `offset` and `limit` support to `memory_read` for more targeted file reads

## [0.1.27] - 2026-04-17

### Features

- **Tape query scoping**: Added `scope` (`session`/`project`) and `anchorScope` (`current-session`/`project`) to `tape_search` and `tape_read`
- **Cross-session tape reads**: `TapeService` can now load entries from all sessions of the current project when using `scope: "project"`
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

# Changelog

The npm release may lag behind the GitHub version. To get the latest updates, install from GitHub: `pi install git:github.com/VandeeFeng/pi-memory-md`

## [Unreleased]

Pi is moving so fast now. I missed the releases for just one week, and there were already so many new features.

I don't know whether this is a good thing or a bad thing for Pi.

`memory_write` tool is also a bad design. In the beginning, it was just like `memory_read` — both started as skill + script. Now I'm back to that original simple pattern.

As pi versions move forward, the custom TUI rendering can run into a few small bugs, and frankly, that's not where I want to spend my energy. The behavior implemented by `memory_write` does not really need to be a tool; apart from looking a little nicer, the custom TUI rendering does not add much practical value.

With these skills, users can customize their own slash commands based on their needs.

## New Features

- **`memory-import` skill**: New skill for importing durable knowledge from URLs, folders, or files into pi-memory-md. Uses `npx defuddle` for web content extraction, analyzes sources before writing, asks for focus confirmation, and generates memories directly via `memory-write` skill with proper description, tags, and source references.

## Changed

- Refined delivered context formatting to compact XML-like sections with `mode="normal" | "tape"`, unified memory file entries, and clearer global/project source markers, making context easier for LLMs to parse.
- **`memory-write` skill**: Replaced the removed `memory_write` tool. Now uses bundled `scripts/memory-write.sh` to resolve memory directory, create files with validated frontmatter (`description`, `tags`, `created`, `updated`), and refresh `updated` timestamps on edits. Preserves YAML frontmatter when updating existing memories.
- `tape_handoff` is now blocked in `manual` anchor mode before execution unless a keyword match or manual handoff match is present — preventing unauthorized direct calls while preserving keyword-triggered and explicit manual handoffs.
- Tape session lookup now respects `PI_CODING_AGENT_SESSION_DIR` before falling back to `PI_CODING_AGENT_DIR/sessions`, because pi `0.71.0` added `PI_CODING_AGENT_SESSION_DIR` for configuring session storage from the environment. See [docs/usage.md#environment-variables](https://github.com/badlogic/pi-mono/blob/v0.71.0/docs/usage.md#environment-variables).
- Tape runtime now detaches captured `sessionManager` references on session shutdown or runtime replacement via `TapeService.detachSessionTree()`, and clears the active tape runtime during shutdown to avoid reusing stale session-bound objects. See [v0.69.0](https://github.com/badlogic/pi-mono/releases/tag/v0.69.0)
- Updated TypeBox imports from `@sinclair/typebox` to `typebox` to match pi `0.69.0+`, where pi switched to the new TypeBox package name.

## Fixed

- Clarified `session_start` handling for `/new` and `/fork` sessions with `previousSessionFile`: memory context is delivered without rerunning session-start hooks, avoiding duplicate hook execution while preserving handoff context. This follows pi's documented lifecycle where `/new` emits `session_start { reason: "new", previousSessionFile? }` and `/fork` emits `session_start { reason: "fork", previousSessionFile }`. See [pi extension lifecycle](https://github.com/badlogic/pi-mono/blob/v0.72.0/packages/coding-agent/docs/extensions.md#lifecycle-overview) and [session_start](https://github.com/badlogic/pi-mono/blob/v0.72.0/packages/coding-agent/docs/extensions.md#session_start).
- Fixed git sync update detection replacing fragile `git pull` output parsing (`Updating` / `Fast-forward`) with an explicit upstream behind count from `git rev-list --count HEAD..@{u}` after `fetch`: repos already at upstream now return `updated: false` before `pull`, successful pulls are marked updated only when the repo was actually behind, and a post-pull behind check warns users to resolve git issues manually if commits remain behind upstream.

## [0.1.35] - 2026-04-30

For global and shared knowledge, I still personally prefer AGENTS.md + manual management. So I won't add global memory writes to `memory_write`; the native `write` tool + AGENTS.md is already convenient enough.

pi-memory-md should first ensure strong memory management and optimization for the project level — that's the design principle and tradeoff behind this choice.

I still believe that things requiring hand-writing should not be delegated to AI or automation, and the global things do not change very frequently ether.

At the outset, I didn’t want `pi-memory-md` to become overly complex. It should be a compatible memory assistant tool, and lately I’ve been continuously experimenting with and refining that compatibility.

Those new Markdown files are not mandatory, they can work well alongside the user’s custom AGENTS.md.

## Changes

- Updated memory layout naming and initialization paths: shared global files now live directly under `{globalMemory}/` as `USER.md`, `MEMORY.md`, and `TASK.md`, while project task memory now uses `core/TASK.md` instead of `core/task/task.md`.
  `MEMORY.md` is only offered for `globalMemory`, and preference content is consolidated into `USER.md` instead of separate `prefer.md` files.
  This keeps the structure closer to agent conventions like Hermes/OpenClaw and only affects newly initialized files and context selection behavior, not existing memory files.

- Clarified native tool path semantics: `memory_write` uses project-memory-relative paths; `memory_list` returns project memory as relative paths and global memory as absolute paths.
  I think global memory should be maintained more manually with user's guide, while project memory is a better fit for pi-memory-md's native tools.
  Project memory in pi-memory-md is first meant for AI, and of course also for human. So `memory_write` supports project-level memory files. For `globalMemory`, I personally think it needs more deliberate manual maintenance, so `memory_write` does not support writing to or modifying global memory.

- Refined delivered memory context formatting: it now uses a unified `# Memory Context` header, clearer global/project sections, absolute memory file paths, and a short note that memory files help the agent better understand the project and the user.
- Commented out legacy built-in memory initialization helpers and removed their tests, since initialization now lives in the `memory-init` skill.

## Fixed

- Fixed `memory_check` and global memory enablement detection: shared global memory is now treated as enabled only when `memoryDir.globalMemory` is explicitly configured.
  When project memory exists but shared global memory is missing, `memory_check` no longer reports `Not initialized`; it continues to show the project memory structure and only warns about the missing shared global directory when global memory was actually enabled by config.

## [0.1.34]

God damn, the LLM makes so many logic errors! Even the bash script!

If it isn’t stated very explicitly in the prompt, the LLM’s logic gets confused easily once the context grows a little longer. I’ve noticed that recent LLMs seem noticeably dumber lately—maybe I’m just not paying enough.

This is an emergency patch release that had to be shipped.

### Changes

- **`memory-init` no longer forces `reference/` directory creation**: initialization now only ensures `core/project` and `core/task`, while `prefer.md` lives directly under `core/`, removing the fixed `reference/` folder requirement.
  The `identity` folder was originally kept as a reference to Letta's design, but through daily use I found it provided very little value, either to the agent or to myself, so I decided to remove it.

  To be precise: the script now only creates `core/project/` and `core/task/` for the project, plus `{globalMemory}/core/task/` when global memory is enabled. Files such as `core/prefer.md`, `core/task/task.md`, `{globalMemory}/core/prefer.md`, and `{globalMemory}/core/task/task.md` are optional and created only if the user chooses the corresponding templates or imports preferences.

## [0.1.33] - 2026-04-28

I'm really happy to have such helpful contributions — everyone's support has helped uncover and fix many issues I couldn't have found on my own.

And I've learned a lot!

Special thanks to:
- [@nqh-packages](https://github.com/nqh-packages)'s PR [#7](https://github.com/VandeeFeng/pi-memory-md/pull/7) for the globalMemory feature contribution!
- [@musaddiq-dev](https://github.com/musaddiq-dev)'s PR [#8](https://github.com/VandeeFeng/pi-memory-md/pull/8) for husky config to avoid `pi update` failure.

I think the `memory-init` tool is a bad design, so it's gone to jail now!

The built-in `memory-init` tool had too many constraints, so I abstracted and consolidated this tool into SKILL.

This skill provides guides through creating the memory folder structure and asks whether to create specific subfolders, giving users more autonomy.

This also better complements the design of globalMemory.

The experience of this part is the same as before, even smoother.

### Features

- **globalMemory: shared memory directory across projects**: Configures a shared memory folder (default: `global/`) under `localPath` accessible from any project.
  When enabled, global files such as `global/core/prefer.md` and `global/core/task/` are included in memory context alongside project-specific memory.
  Configure as a string value in `memoryDir.globalMemory` (e.g., `"globalMemory": "global"`).
  When configured, global memory files are also included in the delivered memory hidden message.

### Changes

- **Unified `memoryDir` config block**: `repoUrl`, `localPath`, and `globalMemory` are now consolidated under `memoryDir` for cleaner configuration. Top-level fields remain supported for backward compatibility.
  ```md
  "memoryDir": {
    "repoUrl": "git@github.com:username/repo.git", // Or HTTPS format
    "localPath": "~/.pi/memory-md",
    "globalMemory": "global"
  }
  ```
  Previously these were separate top-level fields. They still work, but `memoryDir` is the preferred structure.

- **Replaced `/memory-init` command and built-in tool with `memory-init` skill**: Provides greater flexibility and user-driven configuration instead of hardcoded logic.
  The skill delegates to `scripts/memory-init.sh` and prompts users to select templates and import preferences from AGENTS.md.
  The built-in `memory-init` tool had too many constraints. I abstracted and consolidated this tool into SKILL, preserving its original functionality while adding more flexibility and user control

- **Renamed `kind` to `type` for TapeAnchor**: `TapeAnchor.kind` → `TapeAnchor.type`, `TapeAnchorKind` → `TapeAnchorType`, `anchorKind` → `anchorType`.
  Before: `{"id":"...","kind":"handoff",...}` → After: `{"id":"...","type":"handoff",...}`
  `type` is more semantically accurate.
  **Note**: This will affect stored JSONL anchor records.

- **Unified AnchorStore query API**: Added `query(options: QueryOptions)` method that unifies id/name/sessionId/sessionEntryId filtering with `returnMode` ('first', 'last', 'all').
  Removed old `findById`, `findByName`, `findByNameInSession`, `findAllByName`, `findBySession`, `findBySessionEntryId`, `getLastAnchor` methods. Use `query()` instead.
  `search()` remains unchanged for complex queries (text search, time ranges, meta filtering).

### Fixed

- **Support `PI_CODING_AGENT_DIR` environment variable**: All modules now respect this env var for global settings path, defaulting to `~/.pi/agent` if unset.

## [0.1.32] - 2026-04-27

I think the `memory_read` tool is a bad idea — it doesn't add any real value and only imposes unnecessary constraints on reading and managing memory files, also hindered feature expansion.

It's gone to jail!

I've been working on compatibility issues for worktrees lately.

Less is more — I need to keep streamlining the code.

Big thanks to everyone who flagged issues in the PRs — really appreciate the feedback!

This project is meant to provide the basic memory foundation and scaffolding, so it's ready to integrate with more sophisticated memory systems down the road. That's about as far as I can take it with my current abilities.

For modern agents, context handling is where the big gains are. Got plenty of ideas rattling around in my head, and I need to dig deeper into the theory.

For now, this project needs to focus on the fundamentals — solid framework design, stability, and extensibility.

**Strange thing**: whenever I publish an npm release, a new big issue always shows up.

### Features

- **Worktree memory integration**: Memory tools now automatically resolve to the main repository's memory directory when operating in a worktree, using the `mainRoot` project name for path resolution.
  Project core memory files don't vary much across worktrees, so I think sharing them makes sense for better continuity.

### Changes

- **Worktree smart mode refinement**: Tape smart mode no longer falls back to scanning all memory files when there's no access history. Since worktrees have independent tape sessions (pi stores session JSONL history per worktree), they won't have memory file access history — returning an empty result is more appropriate than a full directory scan.This ensures file weights are calculated correctly for the current worktree's context.
- **Removed `memory_read` tool**: The memory read tool has been removed from the tool registry. Reading memory files is now handled by the native `read` tool with context hints. Tape-mode context now displays "Recent memory files" instead of "Available memory files" to clarify the smart selection behavior.

  I think this tool is somewhat redundant — beyond a bit of UI convenience, there's no fundamental difference from the native `read` tool.
  This also eliminates the need for complex path validation logic and removes the ambiguity around whether memory files outside the `core/` folder should be included or excluded.
  The memory delivery content already ensures that files in the `core/` folder are clearly communicated to the agent.
  And I think such guide for the agent shouldn't be overly restrictive on tool usage.

- **Removed session-start initialization notification**: No more "Memory-md not initialized. Use /memory-init to set up" notification on session start.
  That notify was really annoying.

### Fixed

- **Tape reader LRU caching**: Added `LRUCache` class to replace the unbounded `Map` caches in `tape-reader.ts`, preventing memory bloat during long sessions. `getSessionFilePath` now also validates session header cache via mtime/size before returning cached results.
- **AnchorStore findById simplification**: `findById` now uses `allAnchors` instead of iterating nested index maps, reducing lookup complexity from O(n*m) to O(n).
- **Tape context warmup fix**: `initDeliveryContent` (formerly `initMemoryContext`) now returns `true` when tape is enabled (even without memory directory), preventing the repeated `cacheInitialContext` calls that used to happen on every `before_agent_start` when memory files don't exist.

## [0.1.31] - 2026-04-25

I can't wrap my head around why LLM came up the code checking for a `.git` directory by walking up the folder tree to decide if it's a git repo — that's so dumb!

In this release, all memory context and tape-mode file selections are now pre-built asynchronously at `session_start` and cached for reuse at every `before_agent_start`, significantly cutting latency and eliminating the stuttering you used to feel on each turn.

Security boundaries have also been hardened: symlink traversals inside the memory directory are now blocked to prevent escape, search execution is bounded with timeouts and pattern limits to prevent runaway abuse, and project-level settings can no longer override high-trust global memory settings such as `repoUrl` or `localPath`.

In my daily use, I sometimes run pi outside of a git repo. So I added `onlyGit` and `excludeDirs` to avoid triggering tape's file analysis all the time.

There’s still some logic problems I need to tidy up.

### Features

- **Recent focus hints**: Tape context can now attach concise `recent focus` line ranges to selected memory files and recently active project files, based on recent `read` offsets and parsed `edit` diffs from session history within the effective smart-scan window. The delivered summary keeps the latest merged ranges (up to five per file), for example `read 340-420` or `edit 390-399`, so the agent can see which parts of each file were actually touched most recently.
- **Tape activation rules**: Tape now uses `"onlyGit": true` by default, so tape runs only inside a Git repository. Git detection now uses `git rev-parse --show-toplevel` instead of manually checking for a `.git` directory, so worktrees and subdirectories resolve correctly. You can also add absolute `"excludeDirs"` paths, and built-in system/temp directories are excluded by default for safety.

### Changes

- **Session-start caching mechanism**: Moved heavy initialization work from `before_agent_start` to `session_start`: tape activation resolution (`git rev-parse --show-toplevel`, exclude dir matching), `TapeService` and `MemoryFileSelector` instantiation (including anchor index loading), memory directory state checks, session-start hooks execution (git pull), and async context pre-building (memory dir scanning, file reading, smart file selection). The cached `initialMemoryContext` and `initialTapeContext` are then reused across all subsequent `before_agent_start` calls, significantly reducing agent response latency at the start of each turn.
- **Async API refactoring**: Core file operations (`memory_read`, `memory_write`, `memory_list`, `memory_sync`) and session management functions now return `Promise` results. Internal modules (`index.ts`, `memory-core.ts`, `utils.ts`) were updated to properly await these async operations, with parallel promises wrapped via `Promise.all()` where applicable.
- **Delivery wording replaces injection wording**: In settings, `["injection": "..."]` is replaced by `["delivery": "..."]`. Both config fields still work.
  `injection` easily suggests bad things like `prompt injection` specially in LLM area, and pi-memory-md does not actually inject memory anyway; it delivers memory by appending a hidden message or appending to the system prompt, so I think `deliver` / `delivery` is a more accurate description.
- **Tape config is now opt-out**: If a `"tape"` block exists, tape is enabled by default. Only `"enabled": false` disables it, while existing `"enabled": true` configs continue to work unchanged.
- **Tape context include/exclude overhaul**: In tape config, `"alwaysInclude": [...]` is replaced by `"whitelist": [...]`, and you can now also add `"blacklist": [...]`. Smart project-file delivery prefers `rg --files` ignore behavior when available, falls back to a built-in default ignore list for common noise, keeps `"blacklist"` as a hard exclude, and treats `"whitelist"` as a force-include override.
- **Deprecated legacy tape include setting**: If your config still uses `"alwaysInclude": [...]`, it will keep working for now, but please move it to `"whitelist": [...]`.

### Fixed

- **Unified project root resolution**: Added a shared `ProjectMeta` model to centralize project path handling. Project root detection now uses `git rev-parse --show-toplevel`, and all project directory logic consistently uses the resolved Git root when available, or falls back to `cwd` otherwise.
- **Tape handoff match flow**: `tape_handoff` now resolves keyword and manual handoffs internally instead of exposing `trigger` or `keywords` to the model. The model only provides `name`, `summary`, and `purpose`, and keyword handoffs only apply when the created anchor name matches the hidden keyword instruction for the current turn.
- **Smart project file tracking**: Smart tape selection now keeps `read` / `edit` / `write` project file paths as full project paths, so active non-memory files are ranked and delivered correctly.
- **Project settings trust boundary**: Project-level `.pi/settings.json` no longer overrides high-trust memory settings like `repoUrl`, `localPath`, sync hooks, legacy `autoSync`, or `tape.tapePath`. Those values now remain controlled by global user settings.
- **Symlink escape protection**: `memory_read`, `memory_write`, and `memory_list` now reject memory paths that traverse symbolic links inside the memory directory, preventing reads and writes from escaping the memory root through symlinked entries.
- **Bounded memory search execution**: `memory_search` now applies a timeout to `grep` / `rg`, caps custom pattern length, and limits search matches per command to reduce runaway regex and heavy search abuse.

## [0.1.30] - 2026-04-23

I'am sorry for so many default settings changes like the tapePath in tape-mode these days. But all these default settings remain customizable.

The reason is I’m thinking hard about the base logic in pi-memory-md, both the code side and the design side.

More stable chassis, longer mileage.

There’s still a lot of logic problems in the code I need to tidy up before next step.

After more than half a month of daily use and iteration, tape-mode is much more stable now.

The npm release may lag behind the GitHub version. To get the latest updates, install from GitHub: `pi install git:github.com/VandeeFeng/pi-memory-md`

### Features

- **Tape `/tree` compatibility**: Mirror tape anchors into pi `/tree` labels so anchored nodes are visible directly in the tree navigator. Customize the `/tree` anchor label prefix in setting with `"labelPrefix": "⚓ "`.
- **Anchor deletion tool**: Added `tape_delete` so tape anchors can be removed by id, with `/tree` mirrored labels resynced after deletion.
- **Anchor context listing**: `tape_list` now supports `contextLines` and returns anchor kind, metadata, and nearby entry context.
- **Manual handoff weighting**: Smart tape selection now boosts memory accesses after recent handoff anchors instead of treating generic anchors as the recency boundary.
- **Project file activity weighting**: Smart tape selection now also tracks `read` / `edit` / `write` tool usage, resolves those paths to full project file paths, and ranks them above `memory_read` / `memory_write`, with handoff-era activity weighted highest.
- **Keyword-triggered handoff prompts**: Tape can now match configured keywords from user prompts and deliver a hidden instruction telling the model to create a `tape_handoff` anchor before continuing the task.
- **Manual handoff mode**: Added `settings.tape.anchor.mode` so direct proactive `tape_handoff` calls can be hard-blocked, while dedicated `trigger: "keyword"` and `trigger: "manual"` flows remain allowed.
- **User-created manual anchors**: Added `/memory-anchor` so users can send a prompt to the LLM and have it derive a handoff anchor with `meta.trigger = "manual"` through the dedicated manual-anchor flow.

### Changes

- **Configurable anchor path**: Now `settings.tape.tapePath` customize where anchor index files are stored. Defaults to `{localPath}/TAPE`. The dumb `anchor-index` folder was removed.
- **Anchor model cleanup**: Anchors now use `kind` plus optional `meta` instead of the old loose `state` shape.
- **Tape runtime consolidation**: Collapsed separate tape service / selector / runtime key fields into a single `activeTapeRuntime` object.
- **Session lifecycle anchors**: Tape now uses `session/new` for new-session entry points and `session/resume` for continued-session entry points instead of flattening everything into `session/start`.
- **Anchor config simplification**: Removed threshold-based auto-anchor settings; `settings.tape.anchor` now only controls display options such as `labelPrefix` and `keywords`.
- **Tape docs relocation**: The old `skills/tape-mode/SKILL.md` guide was moved into `docs/tape-design.md`, and the package no longer registers tape mode as a skill.
- **Git sync noise reduction**: Session-start pull and session-end push now skip redundant syncs, and successful no-op syncs no longer notify the user.

  This was really annoying!
- **Tape memory summary reuse**: Tape smart-mode delivery now normalizes selected paths under the memory directory and reuses the traditional memory summary output (`Description`/`Tags`) for them, even when selected via absolute paths.

### Fixed

- **Smart selector ranking refinement**: Smart tape selection now applies diminishing returns to repeated accesses, gives stronger weight to `edit` / `write` activity than plain `read`, adds a recency bonus to recently touched files, ignores stale paths whose files no longer exist, and limits handoff boosts to the first 15 entries after the latest matching anchor with time decay.
- **Runtime state simplification**: Removed the unused repo initialization ref and reshaped `index.ts` state around the current extension behavior: tape tool registration, session-start hook coordination, initial memory delivery, and active tape runtime.
- **Tape + system-prompt alignment**: Tape mode now follows the same append semantics as normal `system-prompt` mode by appending to `event.systemPrompt` instead of replacing it.
- **Tree label resync cleanup**: Tape `/tree` label syncing now clears all anchor-prefixed labels in the current session tree before rebuilding, preventing stale anchor labels from appearing on multiple entries.
- **Smart selector time-window logic**: Smart tape selection no longer uses the latest arbitrary anchor as a hard cutoff. It now scans recent memory access history using `context.memoryScan` with a preferred and fallback window.
- **Recent-only semantics restored**: `recent-only` now matches its original intent by sorting memory files by modification time and selecting the newest files first.
- **Duplicate tape memory delivery**: Tape delivery now de-duplicates `alwaysInclude` and selector results before building the delivered memory index.
- **Keyword handoff authorization**: `tape_handoff` now only accepts `trigger: "keyword"` when the current turn actually produced a real keyword match. Unauthorized keyword-trigger metadata is downgraded to a normal direct handoff anchor, and the stored `keywords` come from the verified match instead of model-supplied arguments.
- **Tape keyword normalization**: Tape keyword settings are normalized on load so matching stays case-insensitive and de-duplicated.

## [0.1.29] - 2026-04-21

### Warning

- Old `autoSync.onSessionStart` is still supported and normalized into the new hooks config, but migration to `hooks` is recommended.

### Features

- **Hooks-based session actions**: Replaced the old `autoSync` model with `hooks.sessionStart` and `hooks.sessionEnd`, allowing multiple actions per trigger and future custom hook actions.

### Fixed

- **Settings reload semantics**: Aligned `pi-memory-md` settings behavior with native pi runtime semantics. Settings are now loaded on extension initialization and applied on runtime reload.

### Improvements

- **Partial memory reads**: Added `offset` and `limit` support to `memory_read` for more targeted file reads

## [0.1.27] - 2026-04-17

### Features

- **Tape query scoping**: Added `scope` (`session`/`project`) and `anchorScope` (`current-session`/`project`) to `tape_search` and `tape_read`
- **Cross-session tape reads**: `TapeService` can now load entries from all sessions of the current project when using `scope: "project"`
- **Session-aware anchor resolution**: Anchor lookup now prefers current-session matches when requested, then falls back to project scope

### Fixed

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

### Fixed

- Fixed `scanDir` base path handling
- Return actual git error messages instead of generic ones

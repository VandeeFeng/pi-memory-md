# Tape Design

Tape mode is an **anchor-based conversation history management system** that uses pi session as the data source and maintains only an anchor index locally. It provides on-demand context retrieval with intelligent memory file selection.

## Design Philosophy
**"On-demand memory, intelligent retrieval"**

Each new agent conversation lacks continuous memory, and larger context windows do not automatically mean more effective context. pi-memory-md therefore treats input quality, indexing, and deliberate retrieval as more important than dumping more history into the prompt.

The memory model is intentionally split like a computer system:
- **Context window as RAM**: fast, temporary, limited, and not always reliable.
- **Markdown memory files as disk**: persistent, grep-able, human-editable, and easier to organize.
- **Anchors and metadata as the index**: a compact entry point that helps both humans and agents locate the right details only when needed.

This is human-first as much as agent-first. The files should remain useful even without an agent: the user can grep tags, anchors, descriptions, and paths manually, build their own mental model, and then pass selected context to the agent. Agent retrieval should assist this workflow, not replace it.

Tape mode is inspired by:
- **LSTM memory** - Sequential context with checkpoint gates
- **Git workflow** - Anchors as commits, conversation as branches
- **Letta memory** - Explicit memory operations and tools

Tape mode stores anchors as points within pi session entries, using them as the source of truth. Context delivery then selects relevant memory files and recently active project files based on configured strategy, optionally including concise `recent focus` hints. Lifecycle anchors (`session/*`) are created automatically, while handoff anchors can be created via `/memory-anchor` manually. When `mode: "manual"` is set, direct `tape_handoff` calls are blocked, which means the agent will not create anchors automatically, though keyword-matched hidden instructions and `/memory-anchor` still work. Keyword detection can send a hidden message to guide the agent to create a keyword anchor, but the agent may refuse when unnecessary. This combination of anchors and keywords balances the agent's autonomy with user control.

The design now separates three memory horizons:
- **Immediate delivery**: session-start warmup builds memory/tape context once and delivers it through `message-append` or `system-prompt`.
- **Short bridge**: the optional `sessionBridge` hook uses a small BM25 index over the previous session and recent handoff anchors to carry only prompt-relevant continuity across `new` / `resume` / `fork` switches.
- **Durable memory**: the `memory-digest` skill turns recent tape anchors and selected session context into confirmed long-term Markdown memory updates.

For pi TUI compatibility, anchor names are mirrored into `/tree` as inline labels on the session nodes they attach to. During resync, tape clears existing anchor-prefixed labels before rebuilding them to avoid stale labels on old nodes. `/memory-review` adds a separate human-facing overlay for browsing, searching, deleting, and jumping to anchors without asking the agent to search for every handoff.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     LLM Agent Layer                      │
│  - Uses tape tools to query session history              │
│  - Creates anchors for phase transitions                 │
│  - Decides what context to retrieve                      │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   Tape Service Layer                     │
│  - Reads from pi session file (JSONL)                    │
│  - Maintains anchor store (local JSONL)                  │
│  - Provides query, search, and context selection         │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    Storage Layer                         │
│  - Session entries: pi session file (read-only)         │
│  - Anchor store: {localPath}/TAPE/                     │
└─────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Session Reader (`tape/tape-reader.ts`)

Reads entries directly from pi session files:

```typescript
// Session directory: ~/.pi/agent/sessions/--{cwd}--/
// getSessionFilePath() scans JSONL files in that directory and matches the header id
getSessionFilePaths(cwd: string): string[]
getSessionFilePath(cwd: string, sessionId: string): string | null
parseSessionFile(filePath: string): { header: SessionHeader; entries: SessionEntry[] } | null
getEntriesAfterTimestamp(entries: SessionEntry[], timestamp: string): SessionEntry[]
```

**Entry Types** (from pi session):
- `message` - User/assistant messages
- `custom` - Custom events
- `thinking_level_change` - Thinking level changes
- `model_change` - Model switches
- `compaction` - Session compactions
- plus any additional `SessionEntry` variants exposed by pi

### 2. Anchor Store (`tape/tape-anchor.ts`)

Local store of anchor checkpoints:

```typescript
// Storage: {tapePath ?? `${localPath}/TAPE`}/{projectName}__anchors.jsonl
interface TapeAnchor {
  id: string;             // Stable anchor id
  timestamp: string;      // ISO timestamp
  name: string;           // Anchor name (e.g., "session/new", "session/resume", "task/begin")
  type: "session" | "handoff";
  meta?: {
    trigger?: "direct" | "keyword" | "manual";
    keywords?: string[];
    summary?: string;
    purpose?: string; // 1-2 word label (e.g., "feature", "review", "deploy")
  };
  sessionId: string;      // Session ID
  sessionEntryId: string; // Related session entry ID
}
```

Current JSONL write order is: `id`, `timestamp`, `name`, `type`, `meta`, `sessionId`, `sessionEntryId`.

**Key Methods:**
- `append(entry)` - Add new anchor to store
- `removeById(id)` - Delete an anchor and rebuild the JSONL index
- `getAllAnchors()` - Return the in-memory anchor list
- `scan(options)` - Unified anchor filtering by id/name/session/sessionEntry/type/time/meta fields, with `mode: "latest" | "all"`
- `search(options)` - User-facing search wrapper over `scan`, with limit handling
- `clear()` - Remove the anchor index and reset in-memory maps

### 3. Tape Service (`tape/tape-service.ts`)

Main service combining session reading and anchor management:

```typescript
class TapeService {
  // Anchor operations
  createAnchor(name: string, type: "session" | "handoff", meta?: TapeAnchor["meta"], syncTreeLabel?: boolean): TapeAnchor
  recordSessionStart(reason?: "startup" | "reload" | "new" | "resume" | "fork"): TapeAnchor
  deleteAnchor(id: string): TapeAnchor | null
  findAnchorByName(name: string, anchorScope?: "session" | "project"): TapeAnchor | null
  getLastAnchor(anchorScope?: "session" | "project"): TapeAnchor | null

  // Query operations (reads from pi session)
  scan(options: TapeSessionScanOptions & { since?: string }): SessionEntry[]
  scanEntriesWithFallback(options: TapeSessionScanOptions): SessionEntry[]
  searchAnchorsWithFallback(options: TapeAnchorScanOptions): TapeAnchor[]
  getAnchorStore(): AnchorStore
  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: TapeAnchor | null;
    entriesSinceLastAnchor: number;
  }
}
```

### 4. Tape Context (`tape/tape-context.ts`)

**ConversationSelector**: Helper for formatting/reducing session entries
- Token budget filtering (default: 1000 tokens, 40 entries)
- Can format selected session entries into compact context text
- Exists as an internal helper; current runtime delivery is driven by `MemoryFileSelector`

**MemoryFileSelector**: Intelligently selects memory and project files
- **Smart strategy**: Scans recent project history within a configurable time window (`memoryScan`), expands up to the max window when samples are too small, ranks files with handoff-first weighting, then BM25 re-ranks candidates against the current intent
- **Recent focus extraction**: After smart selection picks files, extracts up to 5 concise `recent focus` ranges per selected file from recent `read` / `edit` activity within the same effective smart-scan window
- **Keyword handoff helper**: Normalizes configured keywords and builds a hidden handoff instruction when a user prompt in the `[10, 300]` character range matches a keyword
- **Recent-only strategy**: Scans memory files and returns the most recently modified files

### 5. Tape Tools (`tape/tape-tools.ts`)

Seven tools registered with pi extension API:

## Tape Tools Reference

### tape_handoff - Create Anchor Checkpoint

```typescript
tape_handoff(
  name: string,        // Anchor name (e.g., "task/begin", "task/complete", "handoff")
  summary?: string,    // Brief intent summary, under 18 words
  purpose?: string     // 1-2 word label for the anchor purpose
)
```

**When to use:**
- Starting a new task or phase
- Completing a milestone
- Before major context shifts
- After important decisions

**Example:**
```typescript
// Phase transition
tape_handoff(name="task/begin", summary="Starting database migration")

// Keyword-authorized handoff generated from a hidden instruction
// The model only supplies name / summary / purpose.
tape_handoff(
  name="handoff/keyword-migration",
  summary="Continue the database migration work",
  purpose="migration"
)
```

---

### tape_list - List All Anchors

```typescript
tape_list(
  limit?: number,          // Max anchors (default: 20, max: 100)
  contextLines?: number    // Context lines before/after (default: 1)
)
```

**Returns:** Anchor list with timestamps, type, meta, and nearby entry context

---

### tape_delete - Delete Anchor Checkpoint

```typescript
tape_delete(
  id: string   // Anchor id from tape_list
)
```

**Use when:**
- removing a mirrored `/tree` anchor label by deleting the underlying tape anchor
- cleaning up stale handoff anchors

---

### tape_info - Get Tape Statistics

```typescript
tape_info()
```

**Returns:**
```
📊 Tape Information:
  Total entries: 42
  Anchors: 3
  Last anchor: task/begin
  Entries since last anchor: 8
```

---

### tape_read - Read Conversation History

```typescript
tape_read({
  afterAnchor?: string,              // Read after this anchor name
  lastAnchor?: boolean,              // Read after last anchor
  betweenAnchors?: { start, end },   // Between two anchors
  betweenDates?: { start, end },     // ISO date range
  scan?: string,                     // Text scan over formatted entry JSON
  types?: SessionEntry["type"][],    // Filter by type
  entryScope?: "session" | "project", // Default: project
  anchorScope?: "session" | "project", // Default: session
  limit?: number,                    // Max entries (default: 20, max: 100)
  maxContentChars?: number | null    // Default: 300, null returns full formatted content
})
```

**Common patterns:**
```typescript
// Everything since last anchor
tape_read({ lastAnchor: true })

// Context since task started
tape_read({ afterAnchor: "task/begin" })

// Search messages
tape_read({ scan: "database schema", limit: 10 })

// Date range
tape_read({ betweenDates: { start: "2026-04-01", end: "2026-04-16" } })
```

---

### tape_search - Search Entries and Anchors

```typescript
tape_search({
  kinds?: ("entry" | "anchor" | "all")[],  // What to search
  types?: SessionEntry["type"][],          // Filter entries by type
  limit?: number,                           // Max results (default: 20, max: 100)
  sinceAnchor?: string,
  lastAnchor?: boolean,
  betweenAnchors?: { start, end },
  betweenDates?: { start, end },
  entryScope?: "session" | "project",
  anchorScope?: "session" | "project",
  scan?: string,                            // Text search in entry/anchor content
  anchorName?: string,                      // Anchor name substring
  anchorType?: "session" | "handoff",
  anchorSummary?: string,
  anchorPurpose?: string,
  anchorKeywords?: string[]                 // All keywords must be present
})
```

**Example:**
```typescript
// Find anchors matching query
tape_search({ kinds: ["anchor"], scan: "bug" })

// Find handoff anchors by metadata
tape_search({ kinds: ["anchor"], anchorType: "handoff", anchorPurpose: "migration" })

// Find memory-related tool calls
tape_search({ kinds: ["entry"], types: ["message"], scan: "memory" })
```

---

### tape_reset - Reset Anchor Store

```typescript
tape_reset(archive?: boolean)  // Archive flag is accepted but not implemented
```

**Behavior:** Clears the anchor store, then immediately creates a fresh session lifecycle anchor via `recordSessionStart()`.

---

## Runtime Flow

Tape mode has two different phases: session setup and per-turn context delivery.

```
session_start event
       ↓
┌──────────────────────────────────────┐
│ Create / refresh active tape runtime │
│ - Initialize TapeService             │
│ - Configure session tree labels      │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ Register Tape Tools (once)           │
│ - tape_handoff, tape_list, etc.      │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ Create session lifecycle anchor      │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ Warm up delivery context             │
│ - run sessionStart hooks if needed   │
│ - scan memory files asynchronously   │
│ - preselect smart tape files         │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ Anchor model stays active            │
│ - session/* lifecycle anchors        │
│ - handoff anchors via tape_handoff   │
└──────────────────────────────────────┘
```

```
before_agent_start event
       ↓
┌──────────────────────────────────────────────┐
│ Deliver or reuse prepared context            │
│ - await session-start warmup if needed       │
│ - detect keyword handoff instructions        │
│ - optionally render sessionBridge context    │
│ - deliver via system-prompt or               │
│   message-append                             │
└──────────────────────────────────────────────┘
```

**Important:** heavy scanning is warmed up at `session_start` and cached. `before_agent_start` still runs per agent turn, but normally only awaits the warmup, handles keyword/session-bridge logic, and delivers the cached payload.
- `message-append`: tape-selected memory is delivered once on the first agent turn as a hidden custom message (`pi-memory-md-tape`)
- `system-prompt`: the cached tape-selected memory is appended to the current system prompt on each agent turn
- Keyword-triggered handoff instructions can still be delivered on later turns as a separate hidden custom message (`pi-memory-md-tape-keyword`)
- That hidden keyword message stays within the same agent turn, so it does not create a second LLM request; it only adds tokens to the current request.
- In pi, appending means returning `systemPrompt: event.systemPrompt + "..."`; returning a bare string would replace the prompt for that turn

## Session Bridge

`hooks.beforeAgentStart: ["sessionBridge"]` is an opt-in short bridge for closely related session switches. It is not long-term memory.

When a session starts through `new`, `resume`, or `fork`, pi provides `previousSessionFile`. If that previous session ended within the bridge window (60 seconds by default), pi-memory-md prepares a small BM25 index from recent user/assistant messages. If tape is active, it also indexes recent handoff anchors by name, summary, purpose, and keywords.

At the next `before_agent_start`, the current prompt queries that prepared index. Only matches above the score threshold are rendered into a compact `<session_bridge>` block, with anchor matches rendered under `<tape_anchors>`. In `message-append` mode the bridge is appended to the startup memory message; in `system-prompt` mode it is sent as a separate hidden message.

This bridge exists to avoid the "amnesia" feel during immediate session switches without dumping the previous conversation into context. Durable knowledge should still be written through `memory-digest` / `memory-write`.

## Memory Context Delivery

Tape mode changes **which memory files are selected**, not the delivery mechanism itself.
The delivered content is a memory index/summary plus the tape hint.

```typescript
// settings.tape.context
{
  strategy: "smart",           // "smart" or "recent-only"
  fileLimit: 10,                // Max memory files
  memoryScan: [72, 168],        // Smart scan range: [startHours, maxHours]
  whitelist: [],                // Always include these files or directories
  blacklist: [],                // Always exclude these files or directories; other paths still use rg/default ignore filtering
}

// Delivery adds:
- Memory file list with descriptions/tags
- BM25 intent re-ranking over candidate memory/project files using the latest user prompt plus recent anchor summary/purpose/keywords; Chinese and mixed-language text is tokenized before ranking
- Files under the memory directory still get descriptions/tags even when selected via absolute paths
- Recently active project file paths when smart mode detects read/edit/write activity
- `recent focus` summaries for selected memory and project files, for example `recent focus: read 340-420, edit 390-399`
- Recent focus ranges are derived after file selection and are limited to the same effective smart-scan window that produced the selected files
- Smart-mode filtering that skips stale tape paths whose files no longer exist
- Hidden keyword-triggered handoff instruction when configured keywords match
- Optional `anchor.mode: "manual"` guard that hard-blocks direct `tape_handoff`, while keyword-matched hidden instructions and `/memory-anchor` remain allowed
- Tape hint with tool usage instructions
```

### Delivery behavior

| Delivery mode | Tape behavior |
|---------------|---------------|
| `message-append` | Delivers tape-selected memory once as a hidden custom message on the first agent turn (`pi-memory-md-tape`) |
| `system-prompt` | Appends the prepared tape-selected memory to the current system prompt on every agent turn |

Keyword-triggered handoff instructions are independent from the main memory payload and may be delivered later as `pi-memory-md-tape-keyword` when a configured keyword matches a user prompt. This remains part of the same agent turn, so it does not trigger an extra LLM request; it only increases the current turn's token usage.

If `settings.tape.anchor.mode === "manual"`, the main tape hint tells the LLM not to create `tape_handoff` anchors proactively, and the tool layer rejects direct `tape_handoff` calls. Keyword-triggered hidden instructions and `/memory-anchor` still authorize handoff creation through runtime binding.

This means tape affects **selection**, while the delivery mode controls **delivery frequency and location**.

### Tape activation rules

Tape runtime is enabled only when all of these checks pass:
- `settings.tape.enabled !== false`
- current `cwd` does not match any absolute path in `settings.tape.excludeDirs`
- current `cwd` does not match the built-in system safety exclude list
- when `settings.tape.onlyGit !== false`, `git rev-parse --show-toplevel` resolves a Git root from `cwd`

If any check fails, tape is skipped completely for that turn/session startup: no tape delivery, no tape keyword handoff message, and no anchor recording.

**Tape Hint:**
```
💡 Tape Context Management:
Your conversation history is recorded in tape with anchors (checkpoints).
- Use tape_info to check current tape status
- Use tape_search to query historical entries by type or content
- Use tape_list to list all anchor checkpoints
- Use tape_handoff to create a new anchor/checkpoint when starting a new task
```

## Configuration

```json
{
  "pi-memory-md": {
    "hooks": {
      "beforeAgentStart": ["sessionBridge"]
    },
    "tape": {
      "onlyGit": true,
      "excludeDirs": [
        "/absolute/path/to/sandbox"
      ],
      "context": {
        "strategy": "smart",
        "fileLimit": 10,
        "memoryScan": [72, 168],
        "whitelist": [],
        "blacklist": []
      },
      "anchor": {
        "labelPrefix": "⚓ ",
        "mode": "auto",
        "keywords": {
          "global": [],
          "project": []
        }
      }
    }
  }
}
```

- `hooks.beforeAgentStart: ["sessionBridge"]` is optional. Enable it only if you want short cross-session continuity for immediate `new` / `resume` / `fork` switches.
- `onlyGit` defaults to `true`. When enabled, tape runs only inside a Git repository; otherwise tape delivery and anchor recording are skipped.
- `excludeDirs` is a list of absolute directory paths. If `cwd` is equal to or inside any excluded directory, tape is skipped.
- Built-in system safety excludes are also applied by default and merged with user-defined `excludeDirs`.

### Context Strategy

**Smart** (default):
- Counts only assistant-side tool calls recorded in tape history
- Ignores stale tape paths when the referenced file no longer exists on disk
- Tracks weighted file activity:
  - `memory_write` => base score `16`
  - `read` => base score `20`
  - `edit` => base score `28`
  - `write` => base score `30`
- Repeated accesses use BM25-inspired saturation: each repeat still contributes, but the factor becomes `1 / sqrt(previousAccessCount + 1)`
- **Boost rules** (two independent boosts, both applied if applicable):
  - Latest handoff anchor (any trigger): up to `+30`
  - Latest keyword-triggered handoff anchor: up to `+40`
- Anchor boosts are only eligible within the first `15` tape entries after the latest matching anchor
- Access scores decay smoothly with a 24-hour exponential time decay
- Anchor boosts decay smoothly with a 12-hour exponential time decay inside the eligible anchor window
- Multiple tool kinds on the same file add a small diversity bonus
- Initial scan window is `memoryScan[0]` hours
- If total assistant tool-call accesses in that window are fewer than `MIN_SMART_ACCESS_SAMPLES` (hardcoded `5`), expand by 24-hour steps until enough samples are found or `memoryScan[1]` is reached
- Once file selection stops, `recent focus` ranges are collected only from that same effective scan window; they are not allowed to look further back than the file-selection result
- Final ordering:
  1. final score (`weighted score + diversity bonus`)
  2. raw accumulated score
  3. last access time
- The behavior-ranked candidates are then re-ranked by BM25 intent matching before final delivery
- Falls back to directory scan if no history, except worktrees skip that fallback because their tape history is intentionally isolated

**Recent focus formatting:**
- `read` ranges come from `offset + limit`
- `edit` ranges come from the linked edit tool result (`diff` / `firstChangedLine`)
- Adjacent or overlapping ranges of the same kind are merged
- Each selected file shows at most 5 recent focus ranges, ordered from most recent to older

**Recent-only**:
- Scans memory directory directly
- Sorts files by modification time (newest first)
- Returns the top N memory files
- Does not include project file paths from tape history
- Faster but less context-aware

### Anchor Types

| Type | Behavior |
|------|----------|
| `session` | Lifecycle anchors created by tape (`session/new`, `session/resume`) |
| `handoff` | Phase-transition anchors created through `tape_handoff` and `/memory-anchor` |

`settings.tape.anchor.labelPrefix` customizes how mirrored anchor labels appear in pi `/tree` (default: `⚓ `).

## Usage Patterns

### Pattern 1: Task Phases

```typescript
// Start new task
tape_handoff(name="task/auth-api", summary="Implement authentication API")

// ... work on task ...

// Save checkpoint
tape_handoff(
  name="auth/api-endpoint",
  summary="Auth API endpoint checkpoint"
)

// Later: retrieve context
tape_read({ afterAnchor: "task/auth-api" })
```

### Pattern 2: Debugging Sessions

```typescript
// Checkpoint before changes
tape_handoff(name="debug/before-fix", summary="Investigating timeout error")

// ... attempt fix ...

// Success or failure anchor
tape_handoff(name="debug/after-fix", summary="Fixed by increasing timeout")

// Review what happened
tape_read({ betweenAnchors: { start: "debug/before-fix", end: "debug/after-fix" } })
```

### Pattern 3: Context Switching

```typescript
// Save current state
tape_handoff(name="context/save", summary="Saving migration context")

// Switch task
tape_handoff(name="task/urgent-fix", summary="Hotfix for production")

// ... fix bug ...

// Return to previous task
tape_read({ afterAnchor: "context/save" })
```

## Best Practices

### DO

✅ **Create anchors at meaningful transitions**
```typescript
tape_handoff(name="phase/design", summary="Moving to implementation")
```

✅ **Use descriptive, hierarchical names**
```typescript
// Good
tape_handoff(name="bug/auth/timeout-fix")
tape_handoff(name="task/api/phase2")

// Less useful
tape_handoff(name="checkpoint")
```

✅ **Store relevant metadata in anchors when it helps retrieval**
```typescript
tape_handoff(
  name="migration/checkpoint",
  summary="Users table migration checkpoint",
  purpose="migration"
)
```

✅ **Use targeted queries**
```typescript
// Specific and efficient
tape_read({ afterAnchor: "task/api", types: ["message"], limit: 10 })

// Instead of everything
tape_read({})
```

### DON'T

❌ **Create anchors too frequently**
❌ **Use vague anchor names**
❌ **Query without filters in large sessions**
❌ **Ignore tape_info warnings** (entriesSinceLastAnchor > 20)

## Token Costs

| Tool | Token Cost | When |
|------|------------|------|
| `tape_handoff` | ~5-10 | When called |
| `tape_list` | ~50-200 | When called |
| `tape_info` | ~50-100 | When called |
| `tape_read` | ~100-2000 | When called |
| `tape_search` | ~50-500 | When called |
| `tape_reset` | ~20 | When called |

**Key insight:** Only query tools consume tokens, and only when explicitly called.

## Troubleshooting

### Issue: No entries returned

**Check:**
1. Session file exists: `~/.pi/agent/sessions/`
2. Anchor name exists: `tape_list()`
3. Try without filters: `tape_read({ limit: 10 })`

### Issue: Keyword-triggered handoff not appearing

**Check:**
1. `settings.tape.enabled === true`
2. `settings.tape.anchor.keywords.global` or `project` contains the expected keyword
3. The user prompt length is between 10 and 300 characters
4. The keyword is actually present in the submitted user message

### Issue: Memory files not delivered

**Check:**
1. `settings.tape.enabled === true`
2. Memory repository initialized: `memory_check`
3. `core/` directory exists
4. Delivery mode behavior matches expectations:
   - `message-append` sends the main memory payload once on the first agent turn
   - `system-prompt` appends the main memory payload on every agent turn
   - keyword handoff instructions may still appear later as a separate hidden custom message

## File Structure

```
{localPath}/                    # From settings ("localPath"), default: ~/.pi/memory-md/
└── TAPE/                       # Or custom settings.tape.tapePath
    └── {projectName}__anchors.jsonl

${PI_CODING_AGENT_SESSION_DIR:-~/.pi/agent/sessions}/  # pi session storage (read-only)
└── --{cwd-path}--/
    └── *.jsonl                 # Session reader scans files here and matches by session header id
```

## Related Skills and Commands

- `memory-init` - Repository initialization through the skill workflow
- `memory-write` - Durable memory creation/update through Markdown files and frontmatter validation
- `memory-import` - Import durable knowledge from URLs, folders, or files
- `memory-digest` - Convert recent tape/session context into confirmed long-term memories
- `/memory-review` - Human-facing anchor timeline, search, delete, and jump overlay
- Native tools: `memory_check`, `memory_search`, and `memory_sync`

## Reference

- Session entry types: `@earendil-works/pi-coding-agent` (SessionEntry)
- Tape systems: https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub

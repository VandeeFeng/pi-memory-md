# Tape Design

Tape mode is an **anchor-based conversation history management system** that uses pi session as the data source and maintains only an anchor index locally. It provides on-demand context retrieval with intelligent memory file selection.

## Design Philosophy
**"On-demand memory, intelligent retrieval"**

Tape mode is inspired by:
-- **LSTM memory** - Sequential context with checkpoint gates
-- **Git workflow** - Anchors as commits, conversation as branches
-- **Letta memory** - Explicit memory operations with tools

Tape mode records all interactions from the pi session and provides on-demand, anchor-based context retrieval. Anchors act as named checkpoints that segment the conversation history, enabling efficient selective retrieval without consuming tokens on stale context.

For pi TUI compatibility, anchors are also mirrored into `/tree` as inline labels on the anchored session nodes when there is a concrete session entry to attach to. During resync, tape clears existing anchor-prefixed labels in the current session tree before rebuilding them so stale anchor labels do not remain on old nodes.

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
  kind: "session" | "handoff";
  meta?: {
    trigger?: "direct" | "keyword" | "manual";
    keywords?: string[];
    summary?: string;
  };
  sessionId: string;      // Session ID
  sessionEntryId: string; // Related session entry ID
}
```

Current JSONL write order is: `id`, `timestamp`, `name`, `kind`, `meta`, `sessionId`, `sessionEntryId`.

**Key Methods:**
- `append(entry)` - Add new anchor to store
- `findByName(name)` - Find anchor by name
- `findBySession(sessionId)` - Get anchors for session
- `findBySessionEntryId(sessionEntryId, sessionId?)` - Get anchors attached to a specific session node
- `getLastAnchor(sessionId)` - Get most recent anchor
- `search({ query, since, until })` - Search anchors

### 3. Tape Service (`tape/tape-service.ts`)

Main service combining session reading and anchor management:

```typescript
class TapeService {
  // Anchor operations
  createAnchor(name: string, kind: "session" | "handoff", meta?: TapeAnchor["meta"], syncTreeLabel?: boolean): TapeAnchor
  recordSessionStart(reason?: "startup" | "reload" | "new" | "resume" | "fork"): TapeAnchor
  deleteAnchor(id: string): TapeAnchor | null
  findAnchorByName(name: string, anchorScope?: "current-session" | "project"): TapeAnchor | null
  getLastAnchor(anchorScope?: "current-session" | "project"): TapeAnchor | null

  // Query operations (reads from pi session)
  query(options: TapeQueryOptions & { since?: string }): SessionEntry[]
  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: TapeAnchor | null;
    entriesSinceLastAnchor: number;
  }
}
```

### 4. Tape Selectors (`tape/tape-selector.ts`)

**ConversationSelector**: Helper for formatting/reducing session entries
- Token budget filtering (default: 1000 tokens, 40 entries)
- Can format selected session entries into compact context text
- Exists as an internal helper; current runtime delivery is driven by `MemoryFileSelector`

**MemoryFileSelector**: Intelligently selects memory and project files
- **Smart strategy**: Scans recent project history within a configurable time window (`memoryScan`), expands up to the max window when samples are too small, and ranks files with handoff-first weighting
- **Recent focus extraction**: After smart selection picks files, extracts up to 5 concise `recent focus` ranges per selected file from recent `read` / `memory_read` / `edit` activity within the same effective smart-scan window
- **Keyword handoff helper**: Normalizes configured keywords and builds a hidden handoff instruction when a user prompt in the `[10, 300]` character range matches a keyword
- **Recent-only strategy**: Scans memory files and returns the most recently modified files

### 5. Tape Tools (`tape/tape-tools.ts`)

Seven tools registered with pi extension API:

## Tape Tools Reference

### tape_handoff - Create Anchor Checkpoint

```typescript
tape_handoff(
  name: string,                    // Anchor name (e.g., "task/begin", "handoff")
  summary?: string,                // Optional summary
  meta?: Record<string, unknown>   // Optional metadata (for example trigger or keywords)
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

**Returns:** Anchor list with timestamps, kind, meta, and entry context

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
  query?: string,                    // Text search
  types?: SessionEntry["type"][],    // Filter by type
  limit?: number                     // Max entries (default: 20)
})
```

**Common patterns:**
```typescript
// Everything since last anchor
tape_read({ lastAnchor: true })

// Context since task started
tape_read({ afterAnchor: "task/begin" })

// Search messages
tape_read({ query: "database schema", limit: 10 })

// Date range
tape_read({ betweenDates: { start: "2026-04-01", end: "2026-04-16" } })
```

---

### tape_search - Search Entries and Anchors

```typescript
tape_search({
  kinds?: ("entry" | "anchor" | "all")[],  // What to search
  types?: SessionEntry["type"][],          // Filter entries by type
  limit?: number,                           // Max results (default: 20)
  sinceAnchor?: string,                     // Search from anchor
  lastAnchor?: boolean,                     // Search from last anchor
  betweenAnchors?: { start, end },
  betweenDates?: { start, end },
  query?: string                            // Text search
})
```

**Example:**
```typescript
// Find anchors matching query
tape_search({ kinds: ["anchor"], query: "bug" })

// Find memory tool calls
tape_search({ kinds: ["entry"], types: ["custom"], query: "memory" })
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
│ Anchor model stays active            │
│ - session/* lifecycle anchors        │
│ - handoff anchors via tape_handoff   │
└──────────────────────────────────────┘
```

```
before_agent_start event
       ↓
┌──────────────────────────────────────────────┐
│ Build delivery payload for this turn         │
│ - Select memory files (smart/recent)         │
│ - Build memory index + tape hint             │
│ - Optionally add hidden keyword handoff      │
│   instruction                                │
│ - Deliver via system-prompt or               │
│   message-append                             │
└──────────────────────────────────────────────┘
```

**Important:** `before_agent_start` runs per agent turn, not just once at session startup.
- `message-append`: tape-selected memory is delivered once on the first agent turn as a hidden custom message (`pi-memory-md-tape`)
- `system-prompt`: tape-selected memory is rebuilt and appended on every agent turn
- Keyword-triggered handoff instructions can still be delivered on later turns as a separate hidden custom message (`pi-memory-md-tape-keyword`)
- That hidden keyword message stays within the same agent turn, so it does not create a second LLM request; it only adds tokens to the current request.
- In pi, appending means returning `systemPrompt: event.systemPrompt + "..."`; returning a bare string would replace the prompt for that turn

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
| `system-prompt` | Rebuilds tape-selected memory and appends it to the current system prompt on every agent turn |

Keyword-triggered handoff instructions are independent from the main memory payload and may be delivered later as `pi-memory-md-tape-keyword` when a configured keyword matches a user prompt. This remains part of the same agent turn, so it does not trigger an extra LLM request; it only increases the current turn's token usage.

If `settings.tape.anchor.mode === "manual"`, the main tape hint tells the LLM not to create `tape_handoff` anchors proactively, and the tool layer rejects direct `tape_handoff` calls. Keyword-triggered hidden instructions and `/memory-anchor` still authorize handoff creation through runtime binding.

This means tape affects **selection**, while the delivery mode controls **delivery frequency and location**.

### Tape activation rules

Tape runtime is enabled only when all of these checks pass:
- `settings.tape.enabled !== false`
- current `cwd` does not match any absolute path in `settings.tape.excludeDirs`
- current `cwd` does not match the built-in system safety exclude list
- when `settings.tape.onlyGit !== false`, a parent `.git` can be found by walking upward from `cwd`

If any check fails, tape is skipped completely for that turn/session startup: no tape delivery, no tape keyword handoff message, and no anchor recording.

**Tape Hint:**
```
💡 Tape Context Management:
Your conversation history is recorded in tape with anchors (checkpoints).
- Use tape_info to check current tape status
- Use tape_search to query historical entries by kind or content
- Use tape_list to list all anchor checkpoints
- Use tape_handoff to create a new anchor/checkpoint when starting a new task
```

## Configuration

```json
{
  "pi-memory-md": {
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

- `onlyGit` defaults to `true`. When enabled, tape runs only inside a Git repository; otherwise tape delivery and anchor recording are skipped.
- `excludeDirs` is a list of absolute directory paths. If `cwd` is equal to or inside any excluded directory, tape is skipped.
- Built-in system safety excludes are also applied by default and merged with user-defined `excludeDirs`.

### Context Strategy

**Smart** (default):
- Counts only assistant-side tool calls recorded in tape history
- Ignores stale tape paths when the referenced file no longer exists on disk
- Tracks weighted file activity:
  - `memory_read` => base score `10`
  - `memory_write` => base score `16`
  - `read` => base score `20`
  - `edit` => base score `28`
  - `write` => base score `30`
- Repeated accesses use diminishing returns per file:
  - 1st access: `1.0x`
  - 2nd access: `0.6x`
  - 3rd access: `0.35x`
  - 4th+ access: `0.15x`
- **Boost rules** (two independent boosts, both applied if applicable):
  - Latest handoff anchor (any trigger): up to `+30`
  - Latest keyword-triggered handoff anchor: up to `+40`
- Anchor boosts are only eligible within the first `15` tape entries after the latest matching anchor
- Eligible anchor boosts also decay by anchor age:
  - within 6 hours: `100%`
  - within 24 hours: `60%`
  - within 72 hours: `30%`
  - after 72 hours: `0%`
- Recency bonus is applied from the last access time:
  - within 6 hours: `+12`
  - within 24 hours: `+8`
  - within 72 hours: `+4`
- Repeated single-file activity also gets a small repeat penalty when total accesses greatly exceed distinct tool kinds
- Initial scan window is `memoryScan[0]` hours
- If total assistant tool-call accesses in that window are fewer than `MIN_SMART_ACCESS_SAMPLES` (hardcoded `5`), expand by 24-hour steps until enough samples are found or `memoryScan[1]` is reached
- Once file selection stops, `recent focus` ranges are collected only from that same effective scan window; they are not allowed to look further back than the file-selection result
- Final ordering:
  1. final score (`weighted score + recency bonus - repeat penalty`)
  2. raw accumulated score
  3. last access time
  3. last access time
- Falls back to directory scan if no history

**Recent focus formatting:**
- `read` / `memory_read` ranges come from `offset + limit`
- `edit` ranges come from the linked edit tool result (`diff` / `firstChangedLine`)
- Adjacent or overlapping ranges of the same kind are merged
- Each selected file shows at most 5 recent focus ranges, ordered from most recent to older

**Recent-only**:
- Scans memory directory directly
- Sorts files by modification time (newest first)
- Returns the top N memory files
- Does not include project file paths from tape history
- Faster but less context-aware

### Anchor Kinds

| Kind | Behavior |
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

~/.pi/agent/sessions/           # pi session storage (read-only)
└── --{cwd-path}--/
    └── *.jsonl                 # Session reader scans files here and matches by session header id
```

## Related Skills

- `memory-management` - Memory file CRUD operations
- `memory-sync` - Git synchronization
- `memory-init` - Repository initialization
- `memory-search` - Searching memory files

## Reference

- Session entry types: `@mariozechner/pi-coding-agent` (SessionEntry)
- Tape systems: https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub

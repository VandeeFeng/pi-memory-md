---
name: tape-mode
description: This SKILL provides tape provides architecture, design philosophy, and comprehensive usage guide. Use when tape mode is enabled and the user needs tape anchors, tape search, or tape context workflows.
---

# Tape Mode

Tape mode is an **anchor-based conversation history management system** that uses pi session as the data source and maintains only an anchor index locally. It provides on-demand context retrieval with intelligent memory file selection.

## Design Philosophy
**"Record everything, retrieve on-demand"**

Tape mode is inspired by:
-- **LSTM memory** - Sequential context with checkpoint gates
-- **Git workflow** - Anchors as commits, conversation as branches
-- **Letta memory** - Explicit memory operations with tools

Tape mode records all interactions from the pi session and provides on-demand, anchor-based context retrieval. Anchors act as named checkpoints that segment the conversation history, enabling efficient selective retrieval without consuming tokens on stale context.

For pi TUI compatibility, anchors are also mirrored into `/tree` as inline labels on the anchored session nodes when there is a concrete session entry to attach to. During resync, tape clears existing anchor-prefixed labels in the current session tree before rebuilding them so stale auto-anchor labels do not remain on old nodes.

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

### 1. Session Reader (`tape/session-reader.ts`)

Reads entries directly from pi session file:

```typescript
// Session file location: ~/.pi/agent/sessions/--{cwd}--/{sessionId}.jsonl
getSessionFilePath(cwd: string, sessionId: string): string | null
parseSessionFile(filePath: string): { header: SessionHeader; entries: SessionEntry[] } | null
getEntriesAfterTimestamp(entries: SessionEntry[], timestamp: string): SessionEntry[]
```

**Entry Types** (from pi session):
- `message` - User/assistant messages
- `custom` / `custom_message` - Custom events
- `thinking_level_change` - Thinking level changes
- `model_change` - Model switches
- `compaction` - Session compactions

### 2. Anchor Store (`tape/tape-anchor.ts`)

Local store of anchor checkpoints:

```typescript
// Storage: {localPath}/TAPE/{projectName}__anchors.jsonl
// localPath comes from settings ("localPath" field), default: ~/.pi/memory-md/
interface TapeAnchor {
  name: string;           // Anchor name (e.g., "session/new", "session/resume", "task/begin")
  sessionId: string;      // Session ID
  sessionEntryId: string; // Related session entry ID
  timestamp: string;      // ISO timestamp
  state?: Record<string, unknown>;  // Optional state data
}
```

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
  createAnchor(name: string, state?: Record<string, unknown>): TapeAnchor
  recordSessionStart(): TapeAnchor  // Creates session/new or session/resume based on session_start reason
  findAnchorByName(name: string): TapeAnchor | null
  getLastAnchor(): TapeAnchor | null
  
  // Query operations (reads from pi session)
  query(options: TapeQueryOptions): SessionEntry[]
  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: TapeAnchor | null;
    entriesSinceLastAnchor: number;
  }
}
```

### 4. Tape Selectors (`tape/tape-selector.ts`)

**ConversationSelector**: Builds conversation context from session entries
- Token budget filtering (default: 1000 tokens, 40 entries)
- Formats entries as messages for context

**MemoryFileSelector**: Intelligently selects memory and project files
- **Smart strategy**: Scans recent project history within a configurable time window (`memoryScan`), expands up to the max window when samples are too small, and ranks files with handoff-first weighting
- **Recent-only strategy**: Scans memory files and returns the most recently modified files

### 5. Tape Tools (`tape/tape-tools.ts`)

Seven tools registered with pi extension API:

## Tape Tools Reference

### tape_handoff - Create Anchor Checkpoint

```typescript
tape_handoff(
  name: string,                    // Anchor name (e.g., "task/begin", "handoff")
  summary?: string,               // Optional summary (stored in state)
  state?: Record<string, unknown> // Optional state data
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

// Save state
tape_handoff(
  name="migration/checkpoint",
  state={ tablesCompleted: 5, totalTables: 10 }
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

**Returns:** Anchor list with timestamps, state, and entry context

---

### tape_delete - Delete Anchor Checkpoint

```typescript
tape_delete(
  id: string   // Anchor id from tape_list
)
```

**Use when:**
- removing a mirrored `/tree` anchor label by deleting the underlying tape anchor
- cleaning up stale manual or auto anchors

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
tape_reset(archive?: boolean)  // Archive flag (not implemented)
```

**Warning:** Clears anchor store and creates a fresh session lifecycle anchor.

---

## Runtime Flow

Tape mode has two different phases: session setup and per-turn context injection.

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
│ tool_result listener stays active    │
│ - Auto-anchor on threshold           │
└──────────────────────────────────────┘
```

```
before_agent_start event
       ↓
┌──────────────────────────────────────────────┐
│ Build injection payload for this turn        │
│ - Select memory files (smart/recent)         │
│ - Build memory index + tape hint             │
│ - Deliver via system-prompt or               │
│   message-append                             │
└──────────────────────────────────────────────┘
```

**Important:** `before_agent_start` runs per agent turn, not just once at session startup.
- `message-append`: injects once on the first agent turn
- `system-prompt`: rebuilds and appends on every agent turn
- In pi, appending means returning `systemPrompt: event.systemPrompt + "..."`; returning a bare string would replace the prompt for that turn

## Auto-Anchor Mechanism

When `settings.tape.anchor.mode === "threshold"`:

```typescript
pi.on("tool_result", () => {
  const info = tapeService.getInfo();
  if (info.entriesSinceLastAnchor >= threshold) {
    tapeService.createAnchor(`auto/threshold-${timestamp}`);
  }
});
```

**Default threshold:** 25 entries (configurable in settings)

## Memory Context Injection

Tape mode changes **which memory files are selected**, not the delivery mechanism itself.
The injected content is a memory index/summary plus the tape hint.

```typescript
// settings.tape.context
{
  strategy: "smart",           // "smart" or "recent-only"
  fileLimit: 10,                // Max memory files
  memoryScan: [72, 168],        // Smart scan range: [startHours, maxHours]
  alwaysInclude: [],            // Always include these files
}

// Injection adds:
- Memory file list with descriptions/tags
- Recently active project file paths when smart mode detects read/edit/write activity
- Tape hint with tool usage instructions
```

### Delivery behavior

| Injection mode | Tape behavior |
|----------------|---------------|
| `message-append` | Injects tape-selected memory once as a hidden custom message on the first agent turn |
| `system-prompt` | Rebuilds tape-selected memory and appends it to the current system prompt on every agent turn |

This means tape affects **selection**, while the injection mode controls **delivery frequency and location**.

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
      "enabled": true,
      "context": {
        "strategy": "smart",
        "fileLimit": 10,
        "memoryScan": [72, 168],
        "alwaysInclude": []
      },
      "anchor": {
        "mode": "threshold",
        "threshold": 25,
        "labelPrefix": "⚓ "
      }
    }
  }
}
```

### Context Strategy

**Smart** (default):
- Scans recent project history for `memory_read` / `memory_write` and core file-tool usage: `read` / `edit` / `write`
- Starts from `memoryScan[0]` hours and expands up to `memoryScan[1]` hours if the sample is too small
- Resolves `read` / `edit` / `write` paths to full project file paths
- Gives the highest boost to accesses after recent manual handoff-style anchors
- Gives higher base weight to `read` / `edit` / `write` than to `memory_read` / `memory_write`
- Prioritizes by weighted access score, then frequency, then recency
- Falls back to directory scan if no history

**Recent-only**:
- Scans memory directory directly
- Sorts files by modification time (newest first)
- Returns the top N memory files
- Does not include project file paths from tape history
- Faster but less context-aware

### Anchor Mode

| Mode | Behavior |
|------|----------|
| `threshold` | Auto-creates anchor after N entries |
| `hand` | Only manual `tape_handoff` |
| `manual` | Same as `hand` |

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
  state={ endpoint: "/api/auth/login", completed: true }
)

// Later: retrieve context
tape_read({ afterAnchor: "task/auth-api" })
```

### Pattern 2: Debugging Sessions

```typescript
// Checkpoint before changes
tape_handoff(name="debug/before-fix", state={ bug: "timeout error" })

// ... attempt fix ...

// Success or failure anchor
tape_handoff(name="debug/after-fix", summary="Fixed by increasing timeout")

// Review what happened
tape_read({ betweenAnchors: { start: "debug/before-fix", end: "debug/after-fix" } })
```

### Pattern 3: Context Switching

```typescript
// Save current state
tape_handoff(name="context/save", state={ currentTask: "migration" })

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

✅ **Store relevant state in anchors**
```typescript
tape_handoff(
  name="migration/checkpoint",
  state={ table: "users", rowsProcessed: 1500, totalRows: 5000 }
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

### Issue: Auto-anchor not working

**Check:**
1. `settings.tape.anchor.mode === "threshold"`
2. Threshold value (default: 25)
3. `settings.tape.enabled === true`

### Issue: Memory files not injected

**Check:**
1. `settings.tape.enabled === true`
2. Memory repository initialized: `memory_check`
3. `core/` directory exists
4. Delivery mode behavior matches expectations:
   - `message-append` injects once on the first agent turn
   - `system-prompt` appends on every agent turn

## File Structure

```
{localPath}/                    # From settings ("localPath"), default: ~/.pi/memory-md/
└── TAPE/
    └── {projectName}__anchors.jsonl

~/.pi/agent/sessions/           # pi session storage (read-only)
└── --{cwd-path}--/
    └── {sessionId}.jsonl
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

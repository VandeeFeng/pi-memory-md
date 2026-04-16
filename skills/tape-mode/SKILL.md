---
name: pi-memory-md-tape-mode
description: Tape mode for pi-memory-md - anchor-based conversation history and context management using pi session as data source. This SKILL provides tape provides architecture, design philosophy, and comprehensive usage guide.
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
│  - Maintains anchor index (local JSONL)                  │
│  - Provides query, search, and context selection          │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    Storage Layer                         │
│  - Session entries: pi session file (read-only)         │
│  - Anchor index: {localPath}/TAPE/anchor-index/        │
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

### 2. Anchor Index (`tape/anchor-index.ts`)

Local index of anchor checkpoints:

```typescript
// Storage: {localPath}/TAPE/anchor-index/{projectName}__anchors.jsonl
// localPath comes from settings ("localPath" field), default: ~/.pi/memory-md/
interface AnchorEntry {
  name: string;           // Anchor name (e.g., "session/start", "task/begin")
  sessionId: string;      // Session ID
  sessionEntryId: string; // Related session entry ID
  timestamp: string;      // ISO timestamp
  state?: Record<string, unknown>;  // Optional state data
}
```

**Key Methods:**
- `append(entry)` - Add new anchor to index
- `findByName(name)` - Find anchor by name
- `findBySession(sessionId)` - Get anchors for session
- `getLastAnchor(sessionId)` - Get most recent anchor
- `search({ query, since, until })` - Search anchors

### 3. Tape Service (`tape/tape-service.ts`)

Main service combining session reading and anchor management:

```typescript
class MemoryTapeService {
  // Anchor operations
  createAnchor(name: string, state?: Record<string, unknown>): string
  recordSessionStart(): string  // Creates "session/start" anchor
  findAnchorByName(name: string): AnchorEntry | null
  getLastAnchor(): AnchorEntry | null
  
  // Query operations (reads from pi session)
  query(options: TapeQueryOptions): SessionEntry[]
  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: AnchorEntry | null;
    entriesSinceLastAnchor: number;
  }
}
```

### 4. Tape Selectors (`tape/tape-selector.ts`)

**ConversationSelector**: Builds conversation context from session entries
- Token budget filtering (default: 1000 tokens, 40 entries)
- Formats entries as messages for context

**MemoryFileSelector**: Intelligently selects memory files
- **Smart strategy**: Analyzes path access from entries, prioritizes by frequency
- **Recent-only strategy**: Simply scans directory

### 5. Tape Tools (`tape/tape-tools.ts`)

Six tools registered with pi extension API:

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

### tape_anchors - List All Anchors

```typescript
tape_anchors(
  limit?: number,          // Max anchors (default: 20, max: 100)
  contextLines?: number    // Context lines before/after (default: 1)
)
```

**Returns:** Anchor list with timestamps, state, and entry context

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

### tape_reset - Reset Anchor Index

```typescript
tape_reset(archive?: boolean)  // Archive flag (not implemented)
```

**Warning:** Clears anchor index and creates new `session/start` anchor.

---

## Session Startup Flow

```
session_start event
       ↓
┌──────────────────────────────────────┐
│ Create MemoryTapeService             │
│ - Read from pi session file          │
│ - Initialize anchor index            │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ Register Tape Tools (once)            │
│ - tape_handoff, tape_anchors, etc.   │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ Create "session/start" anchor        │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ Register tool_result listener         │
│ - Auto-anchor on threshold           │
└──────────────────────────────────────┘
       ↓
before_agent_start event
       ↓
┌──────────────────────────────────────┐
│ Inject Memory Context                │
│ - Select memory files (smart/recent) │
│ - Build context with tape hint       │
│ - Inject via system-prompt or        │
│   message-append                     │
└──────────────────────────────────────┘
```

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

Tape mode injects memory files at session startup:

```typescript
// settings.tape.context
{
  strategy: "smart",           // "smart" or "recent-only"
  fileLimit: 10,               // Max memory files
  alwaysInclude: [],           // Always include these files
}

// Injection adds:
- Memory file list with descriptions/tags
- Tape hint with tool usage instructions
```

**Tape Hint:**
```
💡 Tape Context Management:
Your conversation history is recorded in tape with anchors (checkpoints).
- Use tape_info to check current tape status
- Use tape_search to query historical entries by kind or content
- Use tape_anchors to list all anchor checkpoints
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
        "alwaysInclude": [],
        "maxTapeTokens": 1000,
        "maxTapeEntries": 40,
        "includeConversationHistory": true
      },
      "anchor": {
        "mode": "threshold",
        "threshold": 25
      }
    }
  }
}
```

### Context Strategy

**Smart** (default):
- Analyzes session entries for memory tool usage
- Tracks file paths accessed
- Prioritizes by access frequency + recency
- Falls back to directory scan if no history

**Recent-only**:
- Scans memory directory directly
- Returns N most recent files
- Faster but less context-aware

### Anchor Mode

| Mode | Behavior |
|------|----------|
| `threshold` | Auto-creates anchor after N entries |
| `hand` | Only manual `tape_handoff` |
| `manual` | Same as `hand` |

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
| `tape_anchors` | ~50-200 | When called |
| `tape_info` | ~50-100 | When called |
| `tape_read` | ~100-2000 | When called |
| `tape_search` | ~50-500 | When called |
| `tape_reset` | ~20 | When called |

**Key insight:** Only query tools consume tokens, and only when explicitly called.

## Troubleshooting

### Issue: No entries returned

**Check:**
1. Session file exists: `~/.pi/agent/sessions/`
2. Anchor name exists: `tape_anchors()`
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

## File Structure

```
{localPath}/                    # From settings ("localPath"), default: ~/.pi/memory-md/
└── TAPE/
    └── anchor-index/
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

---
name: pi-memory-md-tape-mode
description: Tape mode for pi-memory-md - anchor-based conversation history and context management
---

# Tape Mode

Tape mode is a **conversation history management system** that records all interactions to a local JSONL file and provides **on-demand, anchor-based context retrieval**. Unlike traditional conversational memory that auto-injects history, tape mode puts the LLM in control of what context to retrieve.

## Design Philosophy

**"Record everything, retrieve on-demand"**

Tape mode is inspired by:
- **LSTM memory** - Sequential context with checkpoint gates
- **Git workflow** - Anchors as commits, conversation as branches
- **Letta memory** - Explicit memory operations with tools

### Key Differences from Traditional Memory

| Feature | Traditional Memory | Tape Mode |
|---------|-------------------|-----------|
| **History storage** | In-memory (session-only) | Persistent JSONL file |
| **Context injection** | Automatic (last N messages) | On-demand (LLM decides) |
| **Memory operations** | Manual (read/write files) | Auto-recorded + manual |
| **Checkpoints** | None | Anchors (named checkpoints) |
| **Token efficiency** | Wastes tokens on stale history | Only retrieve what's needed |
| **Long-term memory** | Separate memory files | Built-in with search |
| **Multi-session** | Each session isolated | Continuous across sessions |

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────────────────┐
│                     LLM Agent Layer                      │
│  - Uses tape tools to query history                      │
│  - Decides what context to retrieve                      │
│  - Creates anchors for phase transitions                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   Tape Service Layer                     │
│  - Records all events automatically                      │
│  - Manages anchors and queries                           │
│  - Provides selectors for context building               │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    Storage Layer                         │
│  - JSONL file per project/session                        │
│  - Append-only for performance                           │
│  - Indexed query support                                 │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

**Recording Path** (Automatic):
```
User Message → message_start → tape_recordUserMessage → JSONL
Tool Call    → tool_call     → tape_recordToolCall    → JSONL
Tool Result  → tool_result   → tape_recordToolResult  → JSONL
LLM Response → message_end   → tape_recordAssistantMsg → JSONL
```

**Query Path** (On-demand):
```
LLM → tape_read(anchor) → tape_query → JSONL parse → formatted messages
LLM → tape_search       → tape_query → JSONL parse → matching entries
```

## Tape Entry Types

Every interaction is recorded as a `TapeEntry`:

| Kind | Payload | Example |
|------|---------|---------|
| `session/start` | `{ sessionId }` | Session initialization |
| `message/user` | `{ content }` | User message |
| `message/assistant` | `{ content }` | LLM response |
| `tool_call` | `{ tool, args }` | Tool invocation |
| `tool_result` | `{ tool, result }` | Tool output |
| `memory/read` | `{ path }` | Memory file read |
| `memory/write` | `{ path, frontmatter }` | Memory file write |
| `memory/search` | `{ query, searchIn, count }` | Memory search |
| `memory/sync` | `{ action, result }` | Git sync operation |
| `memory/init` | `{ force }` | Memory init |
| `anchor` | `{ name, state }` | Named checkpoint |

### Turn Tracking

Entries are grouped by conversation `turn`:

```
Turn 1:
  - message/user
  - tool_call (xN)
  - tool_result (xN)
  - message/assistant

Turn 2:
  - message/user
  - tool_call (xN)
  ...
```

### Duplicate Detection

Content hashing prevents recording duplicate operations:

```typescript
hash = sha256(JSON.stringify(payload))
if (seen.has(hash)) skip
else record()
```

Resets on each anchor to allow repeated operations across phases.

## Tape Tools

### 1. tape_handoff - Create Anchor Checkpoint

Create a named checkpoint in the conversation history.

```typescript
tape_handoff(
  name: string,           // Anchor name (e.g., "task/start", "session/begin")
  summary?: string,       // Optional summary
  state?: Record<string, unknown>  // Optional state data
)
```

**When to use:**
- Starting a new task or phase
- Completing a milestone
- Before major context shifts
- After important decisions

**Best practices:**
```typescript
// Phase transition
tape_handoff(name="task/begin", summary="Starting database migration")

// Save state for later
tape_handoff(
  name="migration/checkpoint",
  state={ tablesCompleted: 5, totalTables: 10 }
)

// Session milestone
tape_handoff(name="bug/resolution", summary="Fixed connection timeout issue")
```

**Returns:** `Anchor created: {name}` (~5-10 tokens)

---

### 2. tape_anchors - List All Anchors

List all anchor checkpoints in the tape.

```typescript
tape_anchors(limit?: number)  // Max 100, default 20
```

**Example output:**
```
Found 3 anchor(s):
  - session/start (2026-04-05 14:30:00)
  - task/begin (2026-04-05 14:35:00)
    State: {"tablesCompleted": 5, "totalTables": 10}
  - bug/resolution (2026-04-05 14:42:00)
```

**Returns:** Anchor list with timestamps and state (~50-200 tokens)

---

### 3. tape_info - Get Tape Statistics

Get current tape status and statistics.

```typescript
tape_info()
```

**Example output:**
```
📊 Tape Information:
  Total entries: 42
  Anchors: 3
  Last anchor: task/begin
  Entries since last anchor: 8
  Memory operations: 5 reads, 2 writes

💡 Recommendation: Context is getting large. Consider using tape_handoff.
```

**Returns:** Statistics and recommendations (~50-100 tokens)

---

### 4. tape_read - Read Conversation History

Read tape entries as formatted messages. **Most powerful and commonly used tool.**

```typescript
tape_read({
  afterAnchor?: string,              // Anchor name to start after
  lastAnchor?: boolean,              // Read after last anchor (default: false)
  betweenAnchors?: {                 // Read between two anchors
    start: string,                   //   Start anchor name
    end: string                      //   End anchor name
  },
  betweenDates?: {                   // Read between dates (ISO format)
    start: string,                   //   Start date
    end: string                      //   End date
  },
  query?: string,                    // Text search in content
  kinds?: TapeEntryKind[],           // Filter by entry kind
  limit?: number                     // Max entries (default: 20, max 100)
})
```

**Common usage patterns:**

```typescript
// Get everything since last anchor
tape_read({ lastAnchor: true })

// Get context since task started
tape_read({ afterAnchor: "task/begin" })

// Search for specific discussion
tape_read({ query: "database schema", kinds: ["message/user", "message/assistant"] })

// Get recent messages only
tape_read({ limit: 10 })

// Get messages between two phases
tape_read({
  betweenAnchors: { start: "phase/1", end: "phase/2" }
})
```

**Returns:** Formatted message history (~100-2000 tokens depending on results)

---

### 5. tape_search - Search Tape Entries

Search tape entries by kind and content.

```typescript
tape_search({
  kinds?: TapeEntryKind[],           // Filter by entry type
  sinceAnchor?: string,              // Search after anchor
  limit?: number                     // Max results (default: 20)
})
```

**Example usage:**

```typescript
// Find all memory operations
tape_search({ kinds: ["memory/read", "memory/write", "memory/search"] })

// Search for tool calls since anchor
tape_search({ kinds: ["tool_call"], sinceAnchor: "task/start" })

// Get recent user messages
tape_search({ kinds: ["message/user"], limit: 5 })
```

**Returns:** Matching entries list (~50-500 tokens)

---

### 6. tape_reset - Reset Tape

Clear all tape entries and start fresh.

```typescript
tape_reset(archive?: boolean)  // Archive old tape first (default: false)
```

**When to use:**
- Starting a completely new session
- Testing or debugging
- Tape file corrupted

**Warning:** Cannot undo. Use with caution.

**Returns:** Confirmation message (~20 tokens)

---

## Configuration

Tape mode is configured in `settings.json`:

```json
{
  "pi-memory-md": {
    "tape": {
      "enabled": true,
      "context": {
        "strategy": "smart",           // "smart" or "recent-only"
        "fileLimit": 10,               // Max memory files to inject
        "alwaysInclude": [],           // Files to always include
        "maxTapeTokens": 1000,         // Max tokens for tape context
        "maxTapeEntries": 40,          // Max entries before token limit
        "includeConversationHistory": true
      },
      "anchor": {
        "mode": "threshold",           // "hand" or "threshold"
        "threshold": 15                // Auto-create anchor after N entries
      },
      "enableDuplicateDetection": true,
      "tapePath": "~/.pi/memory-md/TAPE"  // Optional custom path
    }
  }
}
```

### Context Strategy

**Smart Strategy** (default):
- Analyzes tape history since last anchor
- Tracks file access frequency and recency
- Selects most relevant memory files
- Falls back to filesystem scan if no history

**Recent-Only Strategy:**
- Simply gets N most recently accessed files
- Faster but less intelligent

### Anchor Mode

**Threshold Mode** (default):
- Auto-creates anchor after N entries (default: 15)
- Good for long conversations
- Prevents context from growing too large

**Hand Mode**:
- Only creates anchors when explicitly requested via `tape_handoff`
- Gives LLM full control
- Risk: context may grow indefinitely

### Tape Hint (Session Startup)

```
---
💡 Tape Context Management:
Your conversation history is recorded in tape with anchors (checkpoints).
- Use tape_info to check current tape status
- Use tape_search to query historical entries by kind or content
- Use tape_anchors to list all anchor checkpoints
- Use tape_handoff to create a new anchor/checkpoint when starting a new task
```

**Cost:** ~150 tokens (injected once per session)

## Usage Patterns

### Pattern 1: Task Phases

```typescript
// Start new task
tape_handoff(name="task/auth-api", summary="Implement authentication API")

// ... work on task ...

// Complete milestone
tape_handoff(
  name="auth/api-endpoint",
  state={ endpoint: "/api/auth/login", completed: true }
)

// Later: retrieve context
tape_read({ afterAnchor: "task/auth-api" })
```

### Pattern 2: Debugging Sessions

```typescript
// Create checkpoint before changes
tape_handoff(name="debug/before-fix", state={ bug: "timeout error" })

// ... attempt fix ...

// If successful
tape_handoff(name="debug/after-fix", summary="Fixed by increasing timeout to 30s")

// If not, revert and review
tape_read({ betweenAnchors: { start: "debug/before-fix", end: "debug/after-fix" } })
```

### Pattern 3: Long-Running Projects

```typescript
// Daily session start
tape_info()  // Check current state

// Get context since last session
tape_read({ lastAnchor: true })

// Create session anchor
tape_handoff(
  name="session/2025-04-05-morning",
  state={ focus: "API documentation" }
)
```

### Pattern 4: Context Switching

```typescript
// Save current state
tape_handoff(name="context/save", state={ currentTask: "database migration" })

// Switch to different task
tape_handoff(name="task/urgent-fix", summary="Hotfix for production bug")

// ... fix bug ...

// Return to previous task
tape_read({ afterAnchor: "context/save" })
```

## Best Practices

### DO

✅ **Create anchors at phase transitions**
```typescript
tape_handoff(name="phase/design", summary="Moving to implementation")
```

✅ **Use descriptive anchor names**
```typescript
// Good
tape_handoff(name="bug/auth/timeout-fix")

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

✅ **Use `tape_read` with specific queries**
```typescript
// Targeted query
tape_read({ afterAnchor: "task/api", kinds: ["message/user", "message/assistant"] })

// Instead of everything
tape_read()
```

✅ **Check tape status periodically**
```typescript
tape_info()  // See if you need an anchor
```

### DON'T

❌ **Create anchors too frequently**
```typescript
// Don't do this
tape_handoff(name="1")
tape_handoff(name="2")
tape_handoff(name="3")
```

❌ **Use vague anchor names**
```typescript
tape_handoff(name="stuff")  // What stuff?
```

❌ **Query entire history without filters**
```typescript
tape_read()  // May return thousands of entries
```

❌ **Forget to create anchors in long conversations**
```typescript
// 50 messages later...
tape_read({ lastAnchor: true })  // Returns too much context
```

## Advanced Features

### Turn-Based Analysis

```typescript
// Get all entries from a specific turn
tape_search({ kinds: ["tool_call", "tool_result"], sinceAnchor: "task/start" })
```

### Content Deduplication

```typescript
// Duplicate operations are automatically skipped
// This prevents redundant entries when retrying operations
// Reset happens on each anchor to allow repeats across phases
```

### Cross-Session Continuity

```typescript
// Tape persists across sessions
// Session IDs are recorded in session/start entries
// Track history across days/weeks
tape_search({ kinds: ["session/start"] })
```

## Troubleshooting

### Issue: Tape not recording events

**Symptoms:** `tape_info()` shows 0 entries

**Solutions:**
1. Check if tape mode is enabled: `"tape": { "enabled": true }`
2. Restart pi after enabling
3. Check tape path permissions

### Issue: Auto-anchor not creating

**Symptoms:** Entries since last anchor exceeds threshold

**Solutions:**
1. Check anchor mode: `"anchor": { "mode": "threshold" }`
2. Verify threshold value (default: 15)
3. Manually create anchor: `tape_handoff(name="manual/checkpoint")`

### Issue: `tape_read` returns no results

**Symptoms:** Empty result from query

**Solutions:**
1. Check anchor name exists: `tape_anchors()`
2. Try without anchor filter: `tape_read({ limit: 10 })`
3. Check kinds filter matches actual entries

### Issue: Tape file too large

**Symptoms:** Slow queries, large file size

**Solutions:**
1. Create more anchors to segment history
2. Use `tape_reset` to start fresh
3. Adjust threshold to create anchors more frequently

## Migration from Traditional Memory

### Step 1: Enable Tape Mode

```json
{
  "pi-memory-md": {
    "tape": { "enabled": true }
  }
}
```

### Step 2: Restart pi

Tape recording starts automatically.

### Step 3: Create Initial Anchor

```typescript
tape_handoff(name="migration/start", summary="Migrating from traditional memory")
```

### Step 4: Continue Using Memory Tools

Memory file operations still work:
```typescript
memory_read(path="core/user/identity.md")
memory_write(path="core/project/architecture.md", ...)
```

These are **automatically recorded** to tape.

## When to Use Tape Mode

Use tape mode when:

✅ **Long-running projects** spanning multiple days/weeks
✅ **Complex debugging** requiring decision history
✅ **Context switching** between multiple tasks/projects
✅ **Research work** needing to track exploration path
✅ **Collaborative debugging** requiring conversation replay
✅ **Token efficiency** - only retrieve what's needed

## When NOT to Use Tape Mode

Use traditional memory when:

❌ **Simple one-off tasks** not needing history
❌ **Privacy-sensitive work** (tape stores everything)
❌ **Minimal context** projects (same info every session)
❌ **Preference for simplicity** over advanced features

## Token Consumption Analysis

### Recording Costs (Zero)

| Operation | Token Cost |
|-----------|------------|
| Writing to JSONL | **0** (local only) |
| Auto-recording events | **0** (local only) |
| Creating anchor | **0** (local only) |
| Duplicate detection | **0** (local only) |

### Query Costs (On-Demand)

| Tool | Min Cost | Max Cost | When Charged |
|------|----------|----------|--------------|
| `tape_handoff` | ~5 | ~10 | When LLM calls it |
| `tape_anchors` | ~50 | ~200 | When LLM calls it |
| `tape_info` | ~50 | ~100 | When LLM calls it |
| `tape_read` | ~100 | ~2000 | When LLM calls it |
| `tape_search` | ~50 | ~500 | When LLM calls it |
| `tape_reset` | ~20 | ~20 | When LLM calls it |

**Key Insight:** **Only queries consume tokens**, and **only when LLM explicitly calls them**.

## Related Skills

- `memory-management` - Creating and managing memory files
- `memory-sync` - Git synchronization
- `memory-init` - Initial repository setup
- `memory-search` - Finding information in memory files

## Reference
- https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub

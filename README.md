# pi-memory-md

Letta-like memory management for [pi](https://github.com/badlogic/pi-mono) using GitHub-backed markdown files.

## Features

- **Persistent Memory**: Store context, preferences, and knowledge across sessions
- **Git-backed**: Version control with full history
- **Prompt append**: Memory index automatically appended to conversation at session start
- **On-demand access**: LLM reads full content via tools when needed
- **Multi-project**: Separate memory spaces per project

## Quick Start

```bash
# 1. Install
pi install npm:pi-memory-md
# Or for latest from GitHub:
pi install git:github.com/VandeeFeng/pi-memory-md

# 2. Create a GitHub repository (private recommended)

# 3. Configure pi
# Add to ~/.pi/agent/settings.json:
{
  "pi-memory-md": {
    "enabled": true,
    "repoUrl": "git@github.com:username/repo.git", // Or HTTPS format
    "localPath": "~/.pi/memory-md"
  }
}

# 4. Start a new pi session
# type /memory-init slash command to initialize the memory files
```

## How It Works

```
Session Start
    ↓
1. Git pull (sync latest changes)
    ↓
2. Scan all .md files in memory directory
    ↓
3. Build index (descriptions + tags only - NOT full content)
    ↓
4. Append index to conversation via prompt append (or system prompt)
    ↓
5. LLM reads full file content via tools when needed
```

## Slash Commands In Pi

You can also use these slash commands directly in pi:

| Command | Description |
|---------|-------------|
| `/memory-init` | Initialize memory repository (clone repo, create directory structure, generate default files) |
| `/memory-status` | Show memory repository status (project name, git status, path) |
| `/memory-refresh` | Refresh memory context from files (rebuild cache and inject into current session) |
| `/memory-check` | Check memory folder structure (display directory tree) |

## Available Tools

The LLM can use these tools to interact with memory:

### Memory Management Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `memory_init` | `{force?: boolean}` | Initialize or reinitialize repository |
| `memory_sync` | `{action: "pull" / "push" / "status"}` | Git operations |
| `memory_read` | `{path: string}` | Read a memory file |
| `memory_write` | `{path, content, description, tags?}` | Create/update memory file |
| `memory_list` | `{directory?: string}` | List all memory files |
| `memory_search` | `{query, searchIn}` | Search by content/tags/description |
| `memory_check` | `{}` | Check current project memory folder structure |

## Memory File Format

```markdown
---
description: "User identity and background"
tags: ["user", "identity"]
created: "2026-02-14"
updated: "2026-02-14"
---

# Your Content Here

Markdown content...
```

## Directory Structure

```
~/.pi/memory-md/
└── project-name/
    ├── core/
    │   ├── user/           # Your preferences
    │   │   ├── identity.md
    │   │   └── prefer.md
    │   └── project/        # Project context
    │       └── tech-stack.md
    └── reference/          # On-demand docs
```

## Configuration

```json
{
  "pi-memory-md": {
    "enabled": true,
    "repoUrl": "git@github.com:username/repo.git", // Or HTTPS format
    "injection": "message-append",
    "autoSync": {
      "onSessionStart": true
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable extension |
| `repoUrl` | Required | GitHub repository URL |
| `localPath` | `~/.pi/memory-md` | Local clone path |
| `injection` | `"message-append"` | Memory injection mode: `"message-append"`, `"system-prompt"` |
| `autoSync.onSessionStart` | `true` | Git pull on session start |
| `tape.enabled` | `false` | Enable tape mode for dynamic context selection |

### Memory Injection Modes

The extension supports two modes for injecting memory into the conversation:

#### 1. Message Append (Default)

```json
{
  "pi-memory-md": {
    ...
    "injection": "message-append"
  }
}
```

- Memory is sent as a custom message before the user's first message
- Not visible in the TUI (`display: false` in pi-tui)
- Persists in the session history
- Injected only once per session (on first agent turn)
- **Pros**: Lower token usage, memory persists naturally in conversation
- **Cons**: Only visible when the model scrolls back to earlier messages

#### 2. System Prompt

```json
{
  "pi-memory-md": {
    ...
    "injection": "system-prompt"
  }
}
```

- Memory is appended to the system prompt
- Rebuilt and injected on every agent turn
- Always visible to the model in the system context
- **Pros**: Memory always present in system context, no need to scroll back
- **Cons**: Higher token usage (repeated on every prompt)

## Usage Examples

Simply talk to pi - the LLM will automatically use memory tools when appropriate:

```
You: Save my preference for 2-space indentation in TypeScript files to memory.

Pi: [Uses memory_write tool to save your preference]
```

You can also explicitly request operations:

```
You: List all memory files for this project.
You: Search memory for "typescript" preferences.
You: Read core/user/identity.md
You: Sync my changes to the repository.
```

The LLM automatically:
- Reads memory index at session start (appended to conversation)
- Writes new information when you ask to remember something
- Syncs changes when needed

## Tape Mode (Dynamic Context Injection)

> **Experimental**: This mode is under active development. APIs and behavior may change.
> Tape mode is not yet published to npm. Install via GitHub: `pi install git:github.com/VandeeFeng/pi-memory-md`
> **Note**: This mode may consume more tokens. Adjust parameters based on your model's context window and your API quota.

### Tape vs Injection Modes

**Tape** is an independent feature that can be enabled alongside either injection mode:

- **With `injection: "message-append"`**: Tape still injects memory as a custom message (same as normal, but with smart file selection)
- **With `injection: "system-prompt"`**: Tape **overrides** the system prompt with its own context (provides full control over what the model sees)

In both cases, tape:
- Injects memory files **once per session** (not on every turn)
- Tracks all operations in an immutable tape (JSONL format): messages, tool calls, memory operations (by default)
- **Anchor-based context**: Selects entries after the last anchor, then applies token/entry limits
  - `maxTapeTokens` (default: 1000): Max tokens for context
  - `maxTapeEntries` (default: 40): Max entries to consider before token limit
- Creates checkpoints with `tape_handoff` to mark phase transitions
- **Auto-anchor**: Automatically creates anchors when context grows too large
  - `anchor.mode: "threshold"` (default): Creates anchor when entries exceed `anchor.threshold` (default: 15)
  - `anchor.mode: "hand"`: Manual only, use `tape_handoff` tool
- **Pros**: Token-efficient, automatic context management with checkpoint management
- **Cons**: Slightly more complex configuration

```json
{
  "pi-memory-md": {
    ...
    "localPath": "~/.pi/memory-md",
    "tape": {
      "enabled": true,
      "context": {
        // "smart": balances recency + frequency (default)
        // "recent-only": only recently accessed files
        "strategy": "smart",

        // Max files to inject into LLM context (tape records all operations)
        "fileLimit": 10,

        // Files to always include in context (optional, defaults to empty)
        "alwaysInclude": [
          "core/user/identity.md",
          "core/user/prefer.md"
        ],

        // Token budget for tape conversation history (default: 1000)
        // Controls how much recent conversation context to include
        "maxTapeTokens": 1000,

        // Maximum entries to consider before token limit (default: 40)
        "maxTapeEntries": 40,

        // Include conversation history in context (default: true)
        // Set to false to disable history and use memory files only
        "includeConversationHistory": false
      },
      "anchor": {
        // Auto-anchor configuration (default: { mode: "threshold", threshold: 15 })
        // - mode: "hand" - Manual only, create anchors via tape_handoff tool
        // - mode: "threshold" - Create anchor when entries exceed threshold
        // - threshold: Number of entries since last anchor before auto-creating
        "mode": "threshold",
        "threshold": 15
     },

      // Custom tape storage path (optional)
      // If not set, uses: {localPath}/TAPE or ~/.pi/memory-md/TAPE
      "tapePath": "/custom/path/to/tape"
    }
  }
}
```

Each line in the tape is a JSON record:
```json
{"id":"1234567890-abc123","kind":"tool_call","timestamp":"2026-04-04T12:00:00.000Z","payload":{"tool":"memory_search","args":{"query":"context"}}}
```

### Tape Anchors

Anchors are checkpoints that mark important transitions in your conversation. They enable efficient context reconstruction:

- **`session/start`**: Beginning of a session (auto-created on tape reset)
- **`task/begin`**: Starting a new task
- **`task/complete`**: Task completed
- **`context/switch`**: Context switching point
- **`handoff`**: Generic handoff point

Example workflow:
```
1. Create anchor: tape_handoff({name: "task/begin", summary: "Working on feature X"})
2. Work with memory files (reads/writes recorded to tape)
3. Create anchor: tape_handoff({name: "task/complete", state: {files_modified: [...]}})
4. Check status: tape_info() or tape_anchors({limit: 10})
```
more details: https://tape.systems/

### Tape Tools (Anchor-based Context)

| Tool | Parameters | Description |
|------|------------|-------------|
| `tape_handoff` | `{name, summary?, state?}` | Create an anchor checkpoint in the tape |
| `tape_anchors` | `{limit?: number}` | List all anchor checkpoints |
| `tape_info` | `{}` | Get tape statistics and information |
| `tape_search` | `{query?, kinds?, limit?, sinceAnchor?}` | Search tape entries by text or kind |
| `tape_read` | `{afterAnchor?, lastAnchor?, betweenAnchors?, betweenDates?, query?, kinds?, limit?}` | Read tape entries as formatted messages |
| `tape_reset` | `{archive?: boolean}` | Reset the tape with new session/start anchor |

> **Note**: Tape tools are automatically registered when `tape` is set to `true`. They provide anchor-based context management inspired by [bub](https://bub.build)'s tape mechanism.

## Reference
- [Introducing Context Repositories: Git-based Memory for Coding Agents | Letta](https://www.letta.com/blog/context-repositories)
- https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub


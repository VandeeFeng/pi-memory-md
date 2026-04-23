# pi-memory-md

Letta-like memory management for [pi](https://github.com/badlogic/pi-mono) using Git-backed markdown files.

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
    "repoUrl": "git@github.com:username/repo.git", // or HTTPS format
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
4. Inject memory index via `message-append` or `system-prompt`
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
| `memory_search` | `{query?, grep?, rg?}` | Search by tags/description and custom grep/ripgrep patterns |
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
    "hooks": {
      "sessionStart": ["pull"],
      "sessionEnd": ["push"]
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
| `hooks.sessionStart` | `["pull"]` | Actions to run when a session starts |
| `hooks.sessionEnd` | `[]` | Actions to run when a session ends |
| `tape.enabled` | `false` | Enable tape mode for dynamic context selection |

When settings change, run `/reload` to apply them.

### Hooks

- `sessionStart: ["pull"]`: pull latest memory before the first prompt.
- `sessionEnd: ["push"]`: commit and push memory when the session ends.

Legacy config is still supported:

```json
{
  "autoSync": {
    "onSessionStart": true
  }
}
```

But it is recommended to migrate to the new `hooks` config.

More trigger actions can be added later, even custom hooks.

### Memory Injection Modes

The extension supports two base modes for injecting memory into the conversation.
When tape mode is disabled, behavior is exactly as described below.
When tape mode is enabled, the same delivery mode still applies, but tape changes how memory files are selected.

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

> For the latest, install via GitHub: `pi install git:github.com/VandeeFeng/pi-memory-md`

> **Note**: This mode may consume more tokens. Adjust parameters based on your model's context window and your API quota.

More details [tape-design](docs/tape-design.md)

### Tape vs Injection Modes

**Tape** is an independent feature that can be enabled alongside either injection mode.
It does not change the delivery mechanism; it changes **which memory files** are selected.

#### Behavior matrix

| Tape | Injection mode | Behavior |
|------|----------------|----------|
| Disabled | `message-append` | Sends memory once as a hidden custom message on the first agent turn |
| Disabled | `system-prompt` | Rebuilds memory and appends it to the system prompt on every agent turn |
| Enabled | `message-append` | Sends tape-selected memory once as a hidden custom message on the first agent turn |
| Enabled | `system-prompt` | Rebuilds tape-selected memory and appends it to the system prompt on every agent turn |

With tape enabled, the injected content is still a memory index/summary for the model, but the file list is chosen by tape-aware selection logic instead of the basic project scan. In smart mode, the injected list can also include recently active project file paths inferred from tool usage. Stale paths from old tape history are ignored when the file no longer exists.

Tape also:
- Tracks all operations in an immutable tape (JSONL format): messages, tool calls, memory operations (by default)
- **Anchor-based context**: Selects relevant memory files and recently active project files based on recent usage and configured strategy
- Creates `session/*` lifecycle anchors automatically and `handoff` anchors via `tape_handoff`
- Can inject a hidden keyword-triggered handoff instruction before the agent starts when configured keywords match the user's message
- Mirrors anchor names into pi `/tree` labels for the anchored session nodes, with full label cleanup before resync to avoid stale labels
- **Pros**: Better context selection with checkpoint management, recent project file awareness, and handoff-aware prioritization
- **Cons**: Slightly more complex configuration

```json
{
  "pi-memory-md": {
    ...
    "localPath": "~/.pi/memory-md",
    "tape": {
      "enabled": true,
      "context": {
        // "smart": ranks memory files plus recent project file activity from session history (default)
        //          repeated accesses get diminishing returns, edit/write outrank plain reads,
        //          recent accesses get a recency bonus, missing/stale paths are ignored,
        //          and handoff boosts only apply near the latest anchors
        // "recent-only": most recently modified memory files only
        "strategy": "smart",

        // Max files to inject into LLM context
        "fileLimit": 10,

        // Smart-mode pi session history scan range: [startHours, maxHours]
        // Scans history incrementally by 24-hour steps, starting from startHours.
        // Stops and uses the result once the sample reaches MIN_SMART_ACCESS_SAMPLES (5).
        // Otherwise keeps expanding until maxHours is reached.
        "memoryScan": [72, 168],

        // Files to always include in context (optional, defaults to empty)
        "alwaysInclude": [
          "core/user/identity.md",
          "core/user/prefer.md"
        ]
      },
      "anchor": {
        // Prefix mirrored into pi /tree labels for anchor nodes
        "labelPrefix": "⚓ ",

        "keywords": {
          // Match against user prompts with length in [10, 300]
          // When matched, inject a hidden instruction telling the model to call tape_handoff, then create an anchor
          "global": ["refactor", "migration"],
          "project": ["tape", "Emacs"]
        }
      },

      // Custom tape path (optional)
      // If not set, default is {localPath}/TAPE: ~/.pi/memory-md/TAPE
      // Anchor index files (.jsonl) will be stored directly under this path
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

- **`session/new`**: First anchor of a new session, including startup into an empty session
- **`session/resume`**: Session continued from an existing context, including `/resume`, `pi -r`, `pi -c`, `/reload`, `/fork`, or startup into an existing session
- **`task/begin`**: Starting a new task
- **`task/complete`**: Task completed
- **`context/switch`**: Context switching point
- **`handoff`**: Generic handoff point

Example workflow:
```
1. Create anchor: tape_handoff({name: "task/begin", summary: "Working on feature X"})
2. Work with memory files and project files (reads/edits/writes recorded to tape)
3. Create anchor: tape_handoff({name: "task/complete", meta: {summary: "Feature X complete"}})
4. Check status: tape_info() or tape_list({limit: 10})
```
more details: https://tape.systems/

### Tape Tools (Anchor-based Context)

| Tool | Parameters | Description |
|------|------------|-------------|
| `tape_handoff` | `{name, summary?, meta?}` | Create a handoff anchor checkpoint in the tape |
| `tape_list` | `{limit?: number}` | List all anchor checkpoints |
| `tape_delete` | `{id}` | Delete an anchor checkpoint by id |
| `tape_info` | `{}` | Get tape statistics and information |
| `tape_search` | `{query?, kinds?, limit?, sinceAnchor?, anchorName?, anchorKind?, anchorSummary?, anchorPurpose?, anchorKeywords?}` | Search tape entries by text or kind, with structured anchor-field filters |
| `tape_read` | `{afterAnchor?, lastAnchor?, betweenAnchors?, betweenDates?, query?, kinds?, limit?}` | Read tape entries as formatted messages |
| `tape_reset` | `{archive?: boolean}` | Reset the tape with a new session lifecycle anchor |

> **Note**: Tape tools are automatically registered when `tape` is set to `true`. They provide anchor-based context management inspired by [bub](https://bub.build)'s tape mechanism.

## Reference
- [Introducing Context Repositories: Git-based Memory for Coding Agents | Letta](https://www.letta.com/blog/context-repositories)
- https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub


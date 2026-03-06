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
    "repoUrl": "git@github.com:username/repo.git",
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

| Tool | Parameters | Description |
|------|------------|-------------|
| `memory_init` | `{force?: boolean}` | Initialize or reinitialize repository |
| `memory_sync` | `{action: "pull" / "push" / "status"}` | Git operations |
| `memory_read` | `{path: string}` | Read a memory file |
| `memory_write` | `{path, content, description, tags?}` | Create/update memory file |
| `memory_list` | `{directory?: string}` | List all memory files |
| `memory_search` | `{query, searchIn}` | Search by content/tags/description |
| `memory_check` | `{}` | Check current project memory | folder structure |

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
    "repoUrl": "git@github.com:username/repo.git",
    "localPath": "~/.pi/memory-md",
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
| `injection` | `"message-append"` | Memory injection mode: `"message-append"` or `"system-prompt"` |
| `autoSync.onSessionStart` | `true` | Git pull on session start |

### Memory Injection Modes

The extension supports two modes for injecting memory into the conversation:

#### 1. Message Append (Default)

```json
{
  "pi-memory-md": {
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

## Reference
- [Introducing Context Repositories: Git-based Memory for Coding Agents | Letta](https://www.letta.com/blog/context-repositories)

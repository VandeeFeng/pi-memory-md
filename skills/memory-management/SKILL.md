---
name: memory-management
description: Core memory operations for pi-memory-md - create, read, update, and delete memory files
---

# Memory Management

Use this skill when working with pi-memory-md memory files. Memory is stored as markdown files with YAML frontmatter in a git repository.

## Design Philosophy

Inspired by Letta memory filesystem:

- **File-based memory**: Each memory is a `.md` file with YAML frontmatter
- **Git-backed**: Full version control and cross-device sync
- **Auto-injection**: Files in `core/` are automatically injected into context based on the active injection mode
- **Organized by purpose**: Fixed structure for core info, flexible for everything else

## Directory Structure

**Base path**: Configured via `settings["pi-memory-md"].localPath` (default: `~/.pi/memory-md`)

```
{localPath}/
└── {project-name}/                  # Project memory root
    ├── core/                        # Auto-injected into context (selection may be tape-aware)
    │   ├── user/                    # 【FIXED】User information
    │   │   ├── identity.md          # Who the user is
    │   │   └── prefer.md            # User habits and code style preferences
    │   │
    │   └── project/                 # 【FIXED】Project information (pre-created)
    │       ├── overview.md          # Project overview
    │       ├── architecture.md      # Architecture and design
    │       ├── conventions.md       # Code conventions
    │       └── commands.md          # Common commands
    │
    ├── docs/                        # 【AGENT-CREATED】Reference documentation
    ├── archive/                     # 【AGENT-CREATED】Historical information
    ├── research/                    # 【AGENT-CREATED】Research findings
    └── notes/                       # 【AGENT-CREATED】Standalone notes
```

**Important:** `core/project/` is a pre-defined folder under `core/`. Do NOT create another `project/` folder at the project root level.

## Core Design: Fixed vs Flexible

### 【FIXED】core/user/ and core/project/

These are **pre-defined** and **auto-injected** as core context:

**core/user/** - User information (2 fixed files)
- `identity.md` - Who the user is (name, role, background)
- `prefer.md` - User habits and code style preferences

**core/project/** - Project information
- `overview.md` - Project overview
- `architecture.md` - Architecture and design
- `conventions.md` - Code conventions
- `commands.md` - Common commands
- `changelog.md` - Development history

**Why fixed?**
- Always part of the memory injection flow, no need to remember to load
- Core identity that defines every interaction
- Project context needed for all decisions

**Rule:** ONLY `user/` and `project/` exist under `core/`. No other folders.

## Decision Tree

### Does this need to be in EVERY conversation?

**Yes** → Place under `core/`
- User-related → `core/user/`
- Project-related → `core/project/`

**No** → Place at project root level (same level as `core/`)
- Reference docs → `docs/`
- Historical → `archive/`
- Research → `research/`
- Notes → `notes/`
- Other? → Create appropriate folder

**Important:** `core/project/` is a FIXED subdirectory under `core/`. Always use `core/project/` for project-specific memory files, NEVER create a `project/` folder at the root level.

## YAML Frontmatter Schema

Every memory file MUST have YAML frontmatter:

```yaml
---
description: "Human-readable description of this memory file"
tags: ["user", "identity"]
created: "2026-02-14"
updated: "2026-02-14"
---
```

**Required fields:**
- `description` (string) - Human-readable description

**Optional fields:**
- `tags` (array of strings) - For searching and categorization
- `created` (date) - File creation date (auto-added on create)
- `updated` (date) - Last modification date (auto-updated on update)

## Examples

### Example 1: User Identity (core/user/identity.md)

```bash
memory_write(
  path="core/user/identity.md",
  description="User identity and background",
  tags=["user", "identity"],
  content="# User Identity\n\nName: Vandee\nRole: Developer..."
)
```

### Example 2: User Preferences (core/user/prefer.md)

```bash
memory_write(
  path="core/user/prefer.md",
  description="User habits and code style preferences",
  tags=["user", "preferences"],
  content="# User Preferences\n\n## Communication Style\n- Be concise\n- Show code examples\n\n## Code Style\n- 2 space indentation\n- Prefer const over var\n- Functional programming"
)
```

### Example 3: Project Architecture (core/project/)

```bash
memory_write(
  path="core/project/architecture.md",
  description="Project architecture and design",
  tags=["project", "architecture"],
  content="# Architecture\n\n..."
)
```

### Example 3: Reference Docs (root level)

```bash
memory_write(
  path="docs/api/rest-endpoints.md",
  description="REST API reference documentation",
  tags=["docs", "api"],
  content="# REST Endpoints\n\n..."
)
```

### Example 4: Archived Decision (root level)

```bash
memory_write(
  path="archive/decisions/2024-01-15-auth-redesign.md",
  description="Auth redesign decision from January 2024",
  tags=["archive", "decision"],
  content="# Auth Redesign\n\n..."
)
```

## Reading Memory Files

Use the `memory_read` tool:

```bash
memory_read(path="core/user/identity.md")
```

## Listing Memory Files

Use the `memory_list` tool:

```bash
# List all files
memory_list()

# List files in specific directory
memory_list(directory="core/project")

# List only core/ files
memory_list(directory="system")
```

## Updating Memory Files

To update a file, use `memory_write` with the same path:

```bash
memory_write(
  path="core/user/identity.md",
  description="Updated user identity",
  content="New content..."
)
```

The extension preserves existing `created` date and updates `updated` automatically.

## Folder Creation Guidelines

### core/ directory - FIXED structure

**Only two folders exist under `core/`:**
- `user/` - User identity and preferences
- `project/` - Project-specific information

**Do NOT create any other folders under `core/`.**

### Root level (same level as core/) - COMPLETE freedom

**Agent can create any folder structure at project root level (same level as `core/`):**

- `docs/` - Reference documentation
- `archive/` - Historical information
- `research/` - Research findings
- `notes/` - Standalone notes
- `examples/` - Code examples
- `guides/` - How-to guides

**Rule:** Organize root level in a way that makes sense for the project.

**WARNING:** Do NOT create a `project/` folder at root level. Use `core/project/` instead.

## Best Practices

### DO:
- Use `core/user/identity.md` for user identity
- Use `core/user/prefer.md` for user habits and code style
- Use `core/project/` for project-specific information
- Use root level for reference, historical, and research content
- Keep files focused on a single topic
- Organize root level folders by content type

### DON'T:
- Create folders under `core/` other than `user/` and `project/`
- Create other files under `core/user/` (only `identity.md` and `prefer.md`)
- Create a `project/` folder at root level (use `core/project/` instead)
- Put reference docs in `core/` (use root `docs/`)
- Create giant files (split into focused topics)
- Mix unrelated content in same file

## Maintenance

### Session Wrap-up

After completing work, archive to root level:

```bash
memory_write(
  path="archive/sessions/2025-02-14-bug-fix.md",
  description="Session summary: fixed database connection bug",
  tags=["archive", "session"],
  content="..."
)
```

### Regular Cleanup

- Consolidate duplicate information
- Update descriptions to stay accurate
- Remove information that's no longer relevant
- Archive old content to appropriate root level folders

## When to Use This Skill

Use `memory-management` when:
- User asks to remember something for future sessions
- Creating or updating project documentation
- Setting preferences or guidelines
- Storing reference material
- Building knowledge base about the project
- Organizing information by type or domain
- Creating reusable patterns and solutions
- Documenting troubleshooting steps

## Related Skills

- `memory-sync` - Git synchronization operations
- `memory-init` - Initial repository setup
- `memory-search` - Finding specific information
- `memory-check` - Validate folder structure before syncing

## Before Syncing

**IMPORTANT**: Before running `memory_sync(action="push")`, ALWAYS run `memory_check()` first to verify the folder structure is correct:

```bash
# Check structure first
memory_check()

# Then push if structure is correct
memory_sync(action="push")
```

This prevents accidentally pushing files in wrong locations (e.g., root `project/` instead of `core/project/`).

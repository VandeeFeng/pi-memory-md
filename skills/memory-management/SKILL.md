---
name: memory-management
description: Core memory operations guide for pi-memory-md - create, read, update, and delete memory files. Use when managing pi-memory-md memory files.
---

## Design Philosophy

- **File-based memory**: Each memory is a `.md` file with YAML frontmatter
- **Git-backed**: Full version control and cross-device sync
- **Auto-delivery**: Files in `core/` are automatically delivered into context based on the active delivery mode
- **Minimal fixed core**: `memory-init` now only guarantees `core/project/`
- **Organized by purpose**: Fixed structure for core info, flexible for everything else

## Directory Structure

**Base path**: Configured via `settings["pi-memory-md"].localPath` (default: `~/.pi/memory-md`)

```
{localPath}/
├── {globalMemory}/                # Optional shared memory root when globalMemory is enabled
│   ├── USER.md                    # Optional shared user profile and preferences
│   ├── MEMORY.md                  # Optional shared durable notes, conventions, and lessons learned
│   └── TASK.md                    # Optional shared task template
└── {project-name}/                # Project memory root
    ├── core/                      # Auto-delivered into context (selection may be tape-aware)
    │   ├── USER.md                # Optional project user profile and preferences
    │   ├── MEMORY.md              # Optional project durable notes, conventions, and lessons learned
    │   ├── TASK.md                # Optional project task template
    │   └── project/               # Project-specific memory folder (pre-created)
    ├── docs/                      # Agent-created reference documentation
    ├── archive/                   # Agent-created historical information
    ├── research/                  # Agent-created research findings
    └── notes/                     # Agent-created standalone notes
```

**Important:** `core/project/` is a pre-defined folder under `core/`. Do NOT create another `project/` folder at the project root level.

## Core Design: Fixed vs Flexible

### Fixed by `memory-init`

These are the only directories `memory-init` guarantees for a project:
- `core/project/`

If `globalMemory` is enabled, it also ensures:
- `{globalMemory}/`

### Common optional files

These files are common, but created only if the user chooses templates or imports preferences:
- `core/USER.md`
- `core/MEMORY.md`
- `core/TASK.md`
- `{globalMemory}/USER.md`
- `{globalMemory}/MEMORY.md`
- `{globalMemory}/TASK.md`

### Flexible root-level organization

Everything outside `core/` is flexible. Common examples:
- `docs/`
- `archive/`
- `research/`
- `notes/`
- any other project-specific folders

## Decision Tree

### Does this need to be in EVERY conversation?

**Yes** → Place under `core/`
- User profile and preferences → `core/USER.md`
- Durable project notes, conventions, and lessons learned → `core/MEMORY.md`
- Project tasks/plans → `core/TASK.md`
- General project knowledge → `core/project/`

**Maybe shared across ALL projects?** → Place under `{globalMemory}/` when `globalMemory` is enabled
- Shared user profile and preferences → `{globalMemory}/USER.md`
- Shared durable notes, conventions, and lessons learned → `{globalMemory}/MEMORY.md`
- Shared tasks/plans → `{globalMemory}/TASK.md`

**No** → Place at project root level (same level as `core/`)
- Reference docs → `docs/`
- Historical → `archive/`
- Research → `research/`
- Notes → `notes/`
- Other? → Create appropriate folder

**Important:** `core/project/` is a fixed subdirectory under `core/`. Always use `core/project/` for project-specific memory files, never create a `project/` folder at the root level.

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

### Example 1: User Profile and Preferences (core/USER.md)

```bash
memory_write(
  path="core/USER.md",
  description="User profile and working preferences",
  tags=["user", "profile", "preferences"],
  content="# User Profile\n\n## Communication Style\n- Be concise\n- Show concrete code changes\n\n## Code Style\n- Prefer simple solutions\n- Keep files focused"
)
```

### Example 2: Project Task Memory (core/TASK.md)

```bash
memory_write(
  path="core/TASK.md",
  description="Current project task tracking",
  tags=["task", "planning"],
  content="# Current Tasks\n\n- Fix sync issue\n- Update docs"
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

### Example 4: Reference Docs (root level)

```bash
memory_write(
  path="docs/api/rest-endpoints.md",
  description="REST API reference documentation",
  tags=["docs", "api"],
  content="# REST Endpoints\n\n..."
)
```

### Example 5: Archived Decision (root level)

```bash
memory_write(
  path="archive/decisions/2024-01-15-auth-redesign.md",
  description="Auth redesign decision from January 2024",
  tags=["archive", "decision"],
  content="# Auth Redesign\n\n..."
)
```

## Listing Memory Files

Use the `memory_list` tool:

```bash
# List all files
memory_list()

# List files in specific directory
memory_list(directory="core/project")

# List only core/ files
memory_list(directory="core")
```

## Updating Memory Files

To update a file, use `memory_write` with the same path:

```bash
memory_write(
  path="core/USER.md",
  description="Updated user profile and preferences",
  content="New content..."
)
```

The extension preserves existing `created` date and updates `updated` automatically.

## Folder Creation Guidelines

### core/ directory - partially fixed structure

**Directories guaranteed by `memory-init`:**
- `project/` - Project-specific information
- `TASK.md` - Task and planning file

**Common optional files at `core/` root:**
- `USER.md` - User profile and preferences
- `MEMORY.md` - Durable notes, conventions, and lessons learned

Avoid inventing extra `core/` subfolders unless there is a clear reason and the structure is intentionally being extended.

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
- Use `core/USER.md` for user profile and preferences
- Use `core/MEMORY.md` for durable notes, conventions, and lessons learned
- Use `core/TASK.md` for task and planning memory
- Use `core/project/` for project-specific knowledge meant for regular delivery
- Use `{globalMemory}/` only for truly cross-project memory
- Use root level for reference, historical, and research content
- Keep files focused on a single topic
- Organize root level folders by content type

### DON'T:
- Create a `project/` folder at root level (use `core/project/` instead)
- Assume `core/USER.md`, `core/MEMORY.md`, or task files already exist unless templates were created
- Put reference docs in `core/` when they are not part of recurring context
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

## Before Syncing

**IMPORTANT**: Before running `memory_sync(action="push")`, ALWAYS run `memory_check()` first to verify the folder structure is correct:

```bash
# Check structure first
memory_check()

# Then push if structure is correct
memory_sync(action="push")
```

## Related Skills

- `memory-sync` - Git synchronization operations
- `memory-init` - Initial repository setup
- `memory-search` - Finding specific information
- `memory-check` - Validate folder structure before syncing


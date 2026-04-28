---
name: memory-init
description: Initialize memory repository - clone git repo and create directory structure. Use when you need to set up pi-memory-md for the first time or initalize project's memory files.
---

## Overview

1. Run [scripts/memory-init.sh](scripts/memory-init.sh) to clone/sync repo and create directories
2. Read and copy template files from [templates/](templates/) (user decides which)

## Prerequisites

Before running this skill, ensure:
- Package installed: `pi install npm:pi-memory-md`
- Settings configured with `repoUrl` in your settings file
- Git repository created and accessible

## Execution Steps

### Step 1: Run Initialization Script

Execute the initialization script: [scripts/memory-init.sh](scripts/memory-init.sh)

The script will:
1. Read settings from `.pi/settings.json` or `$PI_CODING_AGENT_DIR/settings.json`
2. Calculate memory directories
3. Clone or sync the git repository
4. Create `core/project/`, `reference/`

### Step 2: Configure globalMemory (if applicable)

Read settings from `.pi/settings.json` or `$PI_CODING_AGENT_DIR/settings.json` and check for `globalMemory` configuration.

If `globalMemory` config block exists:

1. **Ask user**: Should I also create `identity-template.md` and `prefer-template.md` in `global/core/user/`?
   - If YES, copy templates to `global/core/user/`
   - If NO, skip

### Step 3: Copy Template Files for Project Memory (Optional)

Ask user which templates to create in [templates/](templates/):

```
Which template files would you like to create? (select all that apply)
1. identity-template.md - User identity template
2. prefer-template.md - User preferences template
3. Both
4. None (skip templates)
```

If user selects templates, copy them from `templates/` to the `{projectMemoryDir}/core/user` directory:

```bash
cp templates/identity-template.md {projectMemoryDir}/core/user
cp templates/prefer-template.md {projectMemoryDir}/core/user
```

### Step 4: Import Preferences from AGENTS.md (Optional)

This step extracts preferences from AGENTS.md to populate prefer.md.

1. **Find AGENTS.md** (check in order):
   - Project root: `{cwd}/AGENTS.md`
   - Project: `{cwd}/.pi/agent/AGENTS.md`
   - Global: `~/.pi/agent/AGENTS.md`

2. **Ask user**: Do you want to import preferences from AGENTS.md?
   - If NO, skip to Step 4
   - If YES, continue

3. **Read AGENTS.md** and extract relevant sections:
   - IMPORTANT Rules
   - Code Quality Principles
   - Coding Style Preferences
   - Architecture Principles
   - Development Workflow
   - Technical Preferences

4. **Summarize and confirm**:
   ```
   Found these preferences in AGENTS.md:
   - IMPORTANT Rules: [1-2 sentence summary]
   - Code Quality Principles: [1-2 sentence summary]
   - Coding Style: [1-2 sentence summary]

   Include these in core/user/prefer.md? (yes/no)
   ```

5. **If confirmed**, update or create `core/user/prefer.md` with:
   - Extracted content from AGENTS.md
   - Keep the existing frontmatter (description, tags, created)

6. **Ask for additional preferences**:
   ```
   Any additional preferences to add to prefer.md? (e.g., communication style, specific tools)
   ```

### Step 5: Verify Setup

Call `memory_check` tool to verify setup is correct.

## Memory Repository Structure

```
{localPath}/
├── global/                    # (if globalMemory config block exists)
│   ├── core/
│   │   ├── user/              # User memory files (identity.md, prefer.md)
│   │   └── project/           # Project memory files
│   └── reference/
└── {project-name}/
    ├── core/
    │   ├── user/              # User memory files (identity.md, prefer.md)
    │   └── project/           # Project memory files
    └── reference/
```

## Workflow Guide

```
START
  │
  ▼
Run scripts/memory-init.sh
  │
  ▼
Clone/sync git repository
  │
  ▼
Create directories (core/user, core/project, reference)
  │
  ▼
Check: globalMemory config exists?
  │
  ├─ NO ──► Skip to templates
  │
  └─ YES
      │
      ▼
  Ask: Create global/core/user templates?
      │
  ├─ NO ──► Skip
  │
  └─ YES
      │
      ▼
  Copy identity/prefer to global/core/user/
      │
      ▼
Ask: Which templates for project memory?
  │
  ├─ None ──► Skip templates
  │
  └─ Select templates
      │
      ▼
  Copy selected templates
      ▼
Ask: Import preferences from AGENTS.md?
  │
  ├─ NO ──► Skip to verify
  │
  └─ YES
      │
      ▼
  Read AGENTS.md and extract preferences
      │
      ▼
  Ask: Confirm import to prefer.md?
      │
  ├─ NO ──► Ask for additional preferences
  │
  └─ YES
      │
      ▼
  Update core/user/prefer.md
      │
      ▼
  Ask: Additional preferences?
      │
      ▼
  Verify with /memory-status
      │
      ▼
DONE
```

## Error Handling

| Error | Solution |
|-------|----------|
| `settings not found` | Configure `pi-memory-md` in settings file |
| `repoUrl not configured` | Add `repoUrl` to settings |
| `Permission denied` | Check SSH keys: `ssh -T git@github.com` |
| `Directory exists but not git` | Remove directory manually and retry |
| `Connection timeout` | Check network, try again |

## Templates

Copy these templates to start:

- [templates/identity-template.md](templates/identity-template.md) — User identity template
- [templates/prefer-template.md](templates/prefer-template.md) — User preferences template

## Scripts

- [scripts/memory-init.sh](scripts/memory-init.sh) — Initialize memory repository (clone repo, create directories)

## Related Skills

- `memory-management` - Create and manage memory files
- `memory-sync` - Git synchronization
- `memory-search` - Find information in memory

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
4. Create `core/project/` and `core/task/`

### Step 2: Configure globalMemory (if applicable)

Read settings from `.pi/settings.json` or `$PI_CODING_AGENT_DIR/settings.json` and check for `globalMemory` configuration.

Then ask user whether they also want to create default global files under the configured `globalMemory` directory:
- `{globalMemory}/core/prefer.md` from `prefer-template.md`
- `{globalMemory}/core/task/task.md` from `task-template.md`

### Step 3: Copy Template Files for Project Memory (Optional)

Ask user which templates to create in [templates/](templates/):

```
Which template files would you like to create? (select all that apply)
1. task-template.md - Project tasks and planning template
2. prefer-template.md - User preferences template
3. Both
4. None (skip templates)
```

If user selects templates, copy them from `templates/` to the target paths:

```bash
cp templates/task-template.md {projectMemoryDir}/core/task/task.md
cp templates/prefer-template.md {projectMemoryDir}/core/prefer.md
```

### Step 4: Import Preferences from AGENTS.md (Optional)

This step extracts preferences from AGENTS.md to populate project `core/prefer.md` and, if global memory is enabled, `{globalMemory}/core/prefer.md`.

1. **Find AGENTS.md** (check in order):
   - Project root: `{cwd}/AGENTS.md`
   - Project: `{cwd}/.pi/agent/AGENTS.md`
   - Global: `~/.pi/agent/AGENTS.md`

2. **Ask user**: Do you want to import preferences from AGENTS.md?
   - If NO, skip to "Summarize and confirm"
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

   Include these in project core/prefer.md and, if available, {globalMemory}/core/prefer.md? (yes/no)
   ```

5. **If confirmed**, update or create the target preference files with:
   - `core/prefer.md`
   - `{globalMemory}/core/prefer.md` if global memory is enabled
   - Extracted content from AGENTS.md
   - Keep the existing frontmatter (description, tags, created)

6. **Ask for additional preferences**:
   ```
   Any additional preferences to add to prefer.md? (e.g., communication style, specific tools)
   ```

### Step 5: Create Additional Folders (Optional)

Ask user whether they want to create any additional folders beyond `core/project` and `core/task`.

Examples:
- `reference/`
- `archive/`
- Any custom project-specific folder

If YES, ask for the folder names and create them under the project memory directory.

### Step 6: Verify Setup

Call `memory_check` tool to verify setup is correct.

## Memory Repository Structure

```
{localPath}/
├── {globalMemory}/            # (if globalMemory config block exists)
│   └── core/
│       ├── prefer.md          # Shared preferences file
│       └── task/              # Task and planning files
└── {project-name}/
    └── core/
        ├── prefer.md          # Project preferences file
        ├── project/           # Project memory files
        └── task/              # Task and planning files
```

## Workflow Guide

```
START
  │
  ▼
Run scripts/memory-init.sh
  │
  ▼
Script reads settings, clones/syncs repo, and creates project directories
  │
  ▼
Check script result: globalMemory enabled?
  │
  ├─ NO ──► Continue with project setup
  │
  └─ YES
      │
      ▼
  Ensure global task directory exists
      │
      ▼
  Ask: Create {globalMemory}/core/prefer.md and {globalMemory}/core/task/task.md?
      │
      ├─ NO ──► Skip global files
      │
      └─ YES
          │
          ▼
      Copy prefer-template.md to {globalMemory}/core/prefer.md
          │
          ▼
      Copy task-template.md to {globalMemory}/core/task/task.md
          │
          ▼
Continue with project setup
  │
  ▼
Ask: Which project templates to create?
  │
  ├─ None ──► Skip templates
  │
  └─ Select templates
      │
      ▼
  Copy selected templates
      │
      ▼
Ask: Import preferences from AGENTS.md?
      │
  ├─ NO ──► Skip import
  │
  └─ YES
      │
      ▼
  Read AGENTS.md and extract preferences
      │
      ▼
  Ask: Confirm import to project core/prefer.md and, if available, {globalMemory}/core/prefer.md?
      │
      ├─ NO ──► Ask for additional preferences
      │
      └─ YES
          │
          ▼
      Update project core/prefer.md and, if available, {globalMemory}/core/prefer.md
          │
          ▼
      Ask: Additional preferences?
          │
          ▼
Ask: Create any additional folders?
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

- [templates/task-template.md](templates/task-template.md) — Project tasks and planning template
- [templates/prefer-template.md](templates/prefer-template.md) — Preferences template

## Scripts

- [scripts/memory-init.sh](scripts/memory-init.sh) — Initialize memory repository (clone repo, create directories)

## Related Skills

- `memory-management` - Create and manage memory files
- `memory-sync` - Git synchronization
- `memory-search` - Find information in memory

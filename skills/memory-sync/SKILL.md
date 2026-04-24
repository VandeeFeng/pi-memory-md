---
name: memory-sync
description: Git synchronization operations for pi-memory-md repository. Use when you need to sync memory.
---

# Memory Sync

Git synchronization for pi-memory-md repository.

## Configuration

Configure `pi-memory-md.repoUrl` in settings file (global: `~/.pi/agent/settings.json`, project: `.pi/settings.json`)

## Sync Operations

### Pull

Fetch latest changes from GitHub:

```
memory_sync(action="pull")
```

Use before starting work or switching machines.

### Push

Upload local changes to GitHub:

```
memory_sync(action="push")
```

Auto-commits changes before pushing.

**Before pushing, ALWAYS run memory_check first:**

```
memory_check()
```

This verifies that the folder structure is correct (e.g., files are in `core/project/` not in a root `project/` folder).

### Status

Check uncommitted changes:

```
memory_sync(action="status")
```

Shows modified/added/deleted files.

## Typical Workflow

| Action | Command |
|--------|---------|
| Get updates | `memory_sync(action="pull")` |
| Check changes | `memory_sync(action="status")` |
| Upload changes | `memory_sync(action="push")` |

## Troubleshooting

| Error | Solution |
|--------|----------|
| Non-fast-forward | Pull first, then push |
| Conflicts | Manual resolution via bash git commands |
| Not a git repo | Run `memory_init(force=true)` |
| Permission denied | Check SSH keys or repo URL |

## Related Skills

- `memory-management` - Read and write files
- `memory-init` - Setup repository

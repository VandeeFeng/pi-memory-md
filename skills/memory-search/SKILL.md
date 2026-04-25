---
name: memory-search
description: Search and retrieve information from pi-memory-md memory files. Use when you need to search memory.
---

# Memory Search

Search memory files with **multi-mode** search capability.

## Hot tier vs. cold tier

`pi-memory-md` organizes every project (and `_shared/`) into two tiers:

| Tier | Location | Auto-delivered to model? | Searched by `memory_search`? | Listed by `memory_list` (default)? |
|------|----------|--------------------------|------------------------------|------------------------------------|
| **Hot** | `core/` | ✅ every turn | ✅ yes | ✅ yes |
| **Cold / warehouse** | `docs/`, `notes/`, `archive/`, `research/`, `tools/`, `techniques/`, `reference/`, … | ❌ no | ❌ no | ❌ no (opt in) |

Cold-tier files are still git-synced and readable, but they only enter the
conversation when explicitly loaded.

### Listing the cold tier

- `memory_list` (default) — hot tier only.
- `memory_list includeCold=true` — hot + cold across project, `_shared/`, and included projects.
- `memory_list directory="notes"` — explicit directory drills into the warehouse without flipping the flag.
- `/memory-shared-list` (default) — `_shared/core/` only.
- `/memory-shared-list --all` — also lists warehouse files under `_shared/`.

### Reading cold files

`memory_read` works on any path (hot or cold) that exists, including the three forms:
1. Project-relative: `notes/meeting.md`
2. Shared: `_shared/techniques/pattern.md`
3. Included project: `<project>/archive/design.md`

All paths are validated against traversal and symlink escapes.

## Search Scope

Searches automatically include:
- **Current project** files
- **`_shared/` files** (cross-project memory)
- **Included project files** (from `includeProjects` config)

No extra flags needed — shared files are always searched.

## Cross-Project Sharing

### Folder layout
- `<localPath>/<project>/core/...` — per-project files (default scope).
- `<localPath>/_shared/core/...` — cross-project files, loaded in every project.
- `<localPath>/<other-project>/core/...` — loaded when `other-project` is listed in `includeProjects`.

Project files override shared files at the same path. Conflicts are flagged in the delivered memory context.

### Settings (`.pi/settings.json` → `pi-memory-md`)
```jsonc
{
  "pi-memory-md": {
    "includeProjects": ["other-project-name"]
  }
}
```
`_shared` and the current project are handled automatically and never need to be listed.

### Tools & commands
| Tool / command | Purpose |
|----------------|---------|
| `memory_write path=... shared=true` | Write into `_shared/` |
| `memory_delete path=... shared=true` | Delete from project or `_shared/` |
| `memory_move from=... to=... fromShared=true toShared=true` | Move across scopes |
| `memory_read path="_shared/core/..."` | Read a shared or included-project file directly |
| `/memory-shared-list` | List `_shared/core/` (pass `--all` for warehouse too) |
| `/memory-share <relative path>` | Copy a project file into `_shared/` |

See the **Hot tier vs. cold tier** section above for `memory_read` path forms
and auto-delivery rules.

### Scope-prefix guard

When writing with `shared=true` (or using `/memory-share`), **do not** prefix
the path with `_shared/`. The scope is implied by the flag, and prefixing
would create a nested `_shared/_shared/` directory on disk.

```text
# ✅ Correct
memory_write path="core/user/prefer.md" shared=true
/memory-share core/user/prefer.md

# ❌ Rejected
memory_write path="_shared/core/user/prefer.md" shared=true
/memory-share _shared/core/user/prefer.md
```

The same guard applies to `memory_move` when `toShared=true`. The guard is
*not* applied to `fromShared` sources so legacy orphan files in
`_shared/_shared/...` can still be moved out for cleanup.

## Search Modes

### 1. Tags & Description (Built-in)
Automatically searches tags and descriptions based on query:

```
memory_search(query="typescript")
```

### 2. Custom Grep Pattern (grep)
For complex content search with standard grep:

```
memory_search({
  query: "project",
  grep: "typescript|javascript"
})
```

### 3. Custom Ripgrep Pattern (rg)
For smarter search with ripgrep (smart case, better regex):

```
memory_search({
  query: "project",
  rg: "typescript|javascript"
})
```

## Tool Selection

| Parameter | Tool | Best For |
|-----------|------|----------|
| `grep` | GNU grep | Portable, universal |
| `rg` | ripgrep | Smart case, faster, better regex |

## Examples

### Find files by tag
```
memory_search(query="user")
```

### Grep: OR patterns
```
memory_search({
  query: "project",
  grep: "architecture|component|module"
})
```

### Ripgrep: Smart case
```
memory_search({
  query: "typescript",
  rg: "typescript|javascript"
})
```

### Grep: Word boundary
```
memory_search({
  query: "api",
  grep: "\\bAPI\\b"
})
```

### Both: Compare results
```
memory_search({
  query: "project",
  grep: "pattern1",
  rg: "pattern2"
})
```

## Search Priority

1. **Tags** - Exact tag matches (grep)
2. **Description** - Description keyword matches (grep)
3. **Custom grep** - Optional grep pattern
4. **Custom rg** - Optional ripgrep pattern

## Related Skills

- `memory-management` - Read and write files
- `memory-sync` - Git synchronization
- `memory-init` - Initial repository setup
- `tape-mode` - Conversation history search

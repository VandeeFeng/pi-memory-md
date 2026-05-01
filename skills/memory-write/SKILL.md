---
name: memory-write
description: Create or update pi-memory-md memory files using the native write/edit tools plus the bundled template script. Use whenever writing, creating, or updating memory files.
---

# Memory Write

Use this skill to safely create or update pi-memory-md memory files while preserving valid frontmatter.

## Workflow

### 1. Find the memory directory

Use [scripts/memory-write.sh](scripts/memory-write.sh) to resolve the project memory directory. Use the printed path as `<memory-dir>`.

**Critical:** DO NOT CREATE, UPDATE, or WRITE any memory file until `<memory-dir>` has been resolved and verified by [scripts/memory-write.sh](scripts/memory-write.sh).

### 2. Create a new memory file

Before creating a memory file, infer a proposed relative path, description, and tags from the user's request, then ask the user to confirm them unless they already provided these values explicitly.

Use [scripts/memory-write.sh](scripts/memory-write.sh) to create the file template. The script prints the created absolute file path. Read or edit that file next.

### 3. Update an existing memory file

1. Use `read` on the existing file.
2. Use `edit` for targeted body changes when possible.
3. Preserve existing YAML frontmatter.
4. Refresh `updated` with [scripts/memory-write.sh](scripts/memory-write.sh).

If a full rewrite is necessary, include the complete frontmatter and body in native `write`, then refresh `updated`.

## Placement rules

- Put always-needed context under `core/`.
- Put project-specific auto-delivered memories under `core/project/`.
- Use root-level folders like `docs/`, `archive/`, `research/`, or `references/` for non-core references.
- Never create a root-level `project/` folder; use `core/project/`.

## Frontmatter shape

The script creates:

```yaml
---
description: "Human-readable description"
tags:
  - "tag"
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
---
```

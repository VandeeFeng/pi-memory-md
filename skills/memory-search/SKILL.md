---
name: memory-search
description: Search and retrieve information from pi-memory-md memory files
---

# Memory Search

Use this skill to find information stored in pi-memory-md memory files.

## Search Types

### Search by Content

Search within markdown content:

```
memory_search(query="typescript", searchIn="content")
```

Returns matching files with content excerpts.

### Search by Tags

Find files with specific tags:

```
memory_search(query="user", searchIn="tags")
```

Best for finding files by category or topic.

### Search by Description

Find files by their frontmatter description:

```
memory_search(query="identity", searchIn="description")
```

Best for discovering files by purpose.

## Common Search Patterns

| Goal | Command |
|------|---------|
| User preferences | `memory_search(query="user", searchIn="tags")` |
| Project info | `memory_search(query="architecture", searchIn="description")` |
| Code style | `memory_search(query="typescript", searchIn="content")` |
| Reference docs | `memory_search(query="reference", searchIn="tags")` |

## Search Tips

- **Case insensitive**: `typescript` and `TYPESCRIPT` work the same
- **Partial matches**: `auth` matches "auth", "authentication", "author"
- **Be specific**: "JWT token validation" > "token"
- **Try different types**: If content search fails, try tags or description

## When Results Are Empty

1. Check query spelling
2. Try different `searchIn` type
3. List all files: `memory_list()`
4. Sync repository: `memory_sync(action="pull")`

## Related Skills

- `memory-management` - Read and write files
- `memory-sync` - Ensure latest data
- `memory-init` - Setup repository

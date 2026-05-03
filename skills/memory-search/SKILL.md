---
name: memory-search
description: Search and retrieve information from pi-memory-md memory files. Use when you need to search memory.
---

# Memory Search

Search memory files with **multi-mode** search capability.

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

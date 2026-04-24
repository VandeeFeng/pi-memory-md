---
name: memory-init
description: Initial setup and bootstrap guide for pi-memory-md repository. Use when you need to set up pi-memory-md for the first time or reinitialize an existing installation.
---

## Prerequisites

1. **GitHub repository** - Create a new empty repository on GitHub
2. **Git access** - Configure SSH keys or personal access token
3. **Node.js & npm** - For installing the package

## Step 1: Install Package

```bash
pi install npm:pi-memory-md
```

## Step 2: Create GitHub Repository

Create a new repository on GitHub:
- Name it something like `memory-md` or `pi-memory`
- Make it private (recommended)
- Don't initialize with README (we'll do that)

**Clone URL will be:** `git@github.com:username/repo-name.git`

## Step 3: Configure Settings

Add to your settings file (global: `~/.pi/agent/settings.json`, project: `.pi/settings.json`):

```json
{
  "pi-memory-md": {
    "enabled": true,
    "repoUrl": "git@github.com:username/repo-name.git",
    "localPath": "~/.pi/memory-md",
    "hooks": {
      "sessionStart": ["pull"],
      "sessionEnd": []
    }
  }
}
```

**Settings explained:**

| Setting | Purpose | Default |
|---------|---------|----------|
| `enabled` | Enable/disable extension | `true` |
| `repoUrl` | GitHub repository URL | Required |
| `localPath` | Local clone location (supports `~`) | `~/.pi/memory-md` |
| `hooks.sessionStart` | Actions run at session start | `["pull"]` |
| `hooks.sessionEnd` | Actions run at session end | `[]` |

## Step 4: Initialize Repository

Start pi and run:

```
memory_init()
```

**This does:**
1. Clones the GitHub repository
2. Creates directory structure:
   - `core/user/` - Your identity and preferences
   - `core/project/` - Project-specific info
3. Creates default files:
   - `core/user/identity.md` - User identity template
   - `core/user/prefer.md` - User preferences template

**Example output:**
```
Memory repository initialized:
Cloned repository successfully

Created directory structure:
  - core/user
  - core/project
  - reference
```

## Step 5: Import Preferences from AGENTS.md

After initialization, extract relevant preferences from your `AGENTS.md` file to populate `prefer.md`:

1. **Read AGENTS.md** (typically at `.pi/agent/AGENTS.md` or project root)

2. **Extract relevant sections** such as:
   - IMPORTANT Rules
   - Code Quality Principles
   - Coding Style Preferences
   - Architecture Principles
   - Development Workflow
   - Technical Preferences

3. **Present extracted content** to the user in a summarized format

4. **Ask first confirmation**: Include these extracted preferences in `prefer.md`?
   ```
   Found these preferences in AGENTS.md:
   - IMPORTANT Rules: [summary]
   - Code Quality Principles: [summary]
   - Coding Style: [summary]

   Include these in core/user/prefer.md? (yes/no)
   ```

5. **Ask for additional content**: Is there anything else you want to add to your preferences?
   ```
   Any additional preferences you'd like to include? (e.g., communication style, specific tools, workflows)
   ```

6. **Update prefer.md** with:
   - Extracted content from AGENTS.md (if user confirmed)
   - Any additional preferences provided by user

## Step 6: Verify Setup

Check status with command:

```
/memory-status
```

Should show: `Memory: project-name | Repo: Clean | Path: {localPath}/project-name`

List files:

```
memory_list()
```

Should show: `core/user/identity.md`, `core/user/prefer.md`

## Project Structure

**Base path**: Configured via `settings["pi-memory-md"].localPath` (default: `~/.pi/memory-md`)

Each project gets its own folder in the repository:

```
{localPath}/
├── project-a/
│   ├── core/
│   │   ├── user/
│   │   │   ├── identity.md
│   │   │   └── prefer.md
│   │   └── project/
│   └── reference/
├── project-b/
│   └── ...
└── project-c/
    └── ...
```

Project name is derived from:
- Git repository name (if in a git repo)
- Or current directory name

## First-Time Setup Script

Automate setup with this script:

```bash
#!/bin/bash
# setup-memory-md.sh

REPO_URL="git@github.com:username/memory-repo.git"
SETTINGS_FILE="$HOME/.pi/agent/settings.json"

# Backup existing settings
cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"

# Add pi-memory-md configuration
node -e "
const fs = require('fs');
const path = require('path');
const settingsPath = '$SETTINGS_FILE';
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings['pi-memory-md'] = {
  enabled: true,
  repoUrl: '$REPO_URL',
  localPath: path.join(require('os').homedir(), '.pi', 'memory-md'),
  hooks: {
    sessionStart: ["pull"],
    sessionEnd: []
  }
};
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
"

echo "Settings configured. Now run: memory_init()"
```

## Reinitializing

To reset everything:

```
memory_init(force=true)
```

**Warning:** This will re-clone the repository, potentially losing local uncommitted changes.

## Troubleshooting

### Clone Failed

**Error:** `Clone failed: Permission denied`

**Solution:**
1. Verify SSH keys are configured: `ssh -T git@github.com`
2. Check repo URL is correct in settings
3. Ensure repo exists on GitHub

### Settings Not Found

**Error:** `GitHub repo URL not configured in settings["pi-memory-md"].repoUrl`

**Solution:**
1. Edit settings file (global or project)
2. Add `pi-memory-md` section (see Step 3)
3. Run `/reload` in pi

### Directory Already Exists

**Error:** `Directory exists but is not a git repo`

**Solution:**
1. Remove existing directory: `rm -rf {localPath}` (use your configured path)
2. Run `memory_init()` again

### No Write Permission

**Error:** `EACCES: permission denied`

**Solution:**
1. Check directory permissions: `ls -la {localPath}/..` (use your configured path)
2. Fix ownership: `sudo chown -R $USER:$USER {localPath}` (use your configured path)

## Verification Checklist

After setup, verify:

- [ ] Package installed: `pi install npm:pi-memory-md`
- [ ] Settings configured in settings file
- [ ] GitHub repository exists and is accessible
- [ ] Repository cloned to configured `localPath`
- [ ] Directory structure created
- [ ] `/memory-status` shows correct info
- [ ] `memory_list()` returns files
- [ ] `prefer.md` populated (either from AGENTS.md or default template)

## Next Steps

After initialization:

1. **Import preferences** - Agent will prompt to extract from AGENTS.md
2. Edit your identity: `memory_read(path="core/user/identity.md")` then `memory_write(...)` to update
3. Review preferences: `memory_read(path="core/user/prefer.md")`
4. Add project context: `memory_write(path="core/project/overview.md", ...)`
5. Learn more: See `memory-management` skill

## Related Skills

- `memory-management` - Creating and managing memory files
- `memory-sync` - Git synchronization
- `memory-search` - Finding information

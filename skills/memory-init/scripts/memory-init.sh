#!/bin/bash
# memory-init.sh
# Initializes the memory repository

set -e

# ============================================================================
# Helper Functions
# ============================================================================

log() { echo "[memory-init] $1"; }
error() { echo "[memory-init] Error: $1" >&2; }

find_settings() {
  local project_settings="$(pwd)/.pi/settings.json"
  # Check PI_CODING_AGENT_DIR env var first, then fallback to default
  local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  local global_settings="$agent_dir/settings.json"
  
  if [ -f "$project_settings" ] && grep -q '"pi-memory-md"' "$project_settings" 2>/dev/null; then
    echo "$project_settings"
  elif [ -f "$global_settings" ] && grep -q '"pi-memory-md"' "$global_settings" 2>/dev/null; then
    echo "$global_settings"
  fi
}

get_project_name() {
  if git rev-parse --show-toplevel &>/dev/null; then
    git rev-parse --show-toplevel | xargs basename
  else
    basename "$(pwd)"
  fi
}

# ============================================================================
# Main Logic
# ============================================================================

main() {
  log "Starting memory initialization..."
  
  # 1. Read settings
  SETTINGS_FILE=$(find_settings)
  if [ -z "$SETTINGS_FILE" ]; then
    error "pi-memory-md settings not found. Configure settings first."
    exit 1
  fi
  
  log "Using settings: $SETTINGS_FILE"
  
  # Extract values (support memoryDir structure with fallback to top-level)
  if command -v jq &> /dev/null; then
    # Check memoryDir first, then fallback to top-level
    REPO_URL=$(jq -r '.["pi-memory-md"].memoryDir.repoUrl // .["pi-memory-md"].repoUrl // empty' "$SETTINGS_FILE")
    LOCAL_PATH=$(jq -r '.["pi-memory-md"].memoryDir.localPath // .["pi-memory-md"].localPath // empty' "$SETTINGS_FILE")
    GLOBAL_MEMORY=$(jq -r '.["pi-memory-md"].memoryDir.globalMemory // .["pi-memory-md"].globalMemory // empty' "$SETTINGS_FILE")
  else
    REPO_URL=$(grep -o '"repoUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | sed 's/.*:[[:space:]]*"\([^"]*\)"/\1/')
    LOCAL_PATH=$(grep -o '"localPath"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | sed 's/.*:[[:space:]]*"\([^"]*\)"/\1/')
    GLOBAL_MEMORY=$(grep -o '"globalMemory"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | sed 's/.*:[[:space:]]*"\([^"]*\)"/\1/')
  fi
  
  LOCAL_PATH="${LOCAL_PATH:-$HOME/.pi/memory-md}"
  LOCAL_PATH=$(eval echo "$LOCAL_PATH")
  
  if [ -z "$REPO_URL" ]; then
    error "repoUrl not configured in settings"
    exit 1
  fi
  
  # 2. Calculate directories
  PROJECT_NAME=$(get_project_name)
  PROJECT_DIR="$LOCAL_PATH/$PROJECT_NAME"
  GLOBAL_ENABLED=$([ -n "$GLOBAL_MEMORY" ] && echo "true" || echo "false")
  GLOBAL_DIR="$LOCAL_PATH/$GLOBAL_MEMORY"
  
  log "Project: $PROJECT_DIR"
  [ "$GLOBAL_ENABLED" = "true" ] && log "Global: $GLOBAL_DIR"
  
  # 3. Check if already initialized
  if [ -d "$PROJECT_DIR/core/project" ] || [ -d "$PROJECT_DIR/core/task" ] || [ -f "$PROJECT_DIR/core/prefer.md" ]; then
    log "Memory already initialized at $PROJECT_DIR"
    log "Remove the existing core entries manually if you want to re-initialize"
    exit 0
  fi
  
  # 4. Sync git repository
  if [ ! -d "$LOCAL_PATH" ]; then
    log "Cloning repository..."
    git clone "$REPO_URL" "$LOCAL_PATH"
  elif [ ! -d "$LOCAL_PATH/.git" ]; then
    error "Directory exists but is not a git repository: $LOCAL_PATH"
    exit 1
  else
    log "Syncing repository..."
    cd "$LOCAL_PATH"
    git fetch origin
    git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || log "No remote changes"
  fi
  
  # 5. Create directory structure
  log "Creating directories..."
  mkdir -p "$PROJECT_DIR/core/project"
  mkdir -p "$PROJECT_DIR/core/task"
  
  if [ "$GLOBAL_ENABLED" = "true" ]; then
    mkdir -p "$GLOBAL_DIR/core/task"
  fi
  
  log "Memory initialized successfully!"
  log "  Project: $PROJECT_DIR"
  [ "$GLOBAL_ENABLED" = "true" ] && log "  Global: $GLOBAL_DIR"
}

main "$@"

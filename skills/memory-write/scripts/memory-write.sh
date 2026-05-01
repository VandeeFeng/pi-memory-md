#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  memory-write.sh project-dir
  memory-write.sh create <memory-dir> <relative-path> <description> [comma-tags]
  memory-write.sh touch  <memory-dir> <relative-path>

Get the current project memory directory, creates a Markdown memory template
with required YAML frontmatter, or updates the frontmatter updated date for an
existing memory file.
USAGE
}

fail() {
  echo "memory-write.sh: $*" >&2
  exit 1
}

current_date() {
  date +%F
}

find_settings() {
  local project_settings="$(pwd)/.pi/settings.json"
  local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  local global_settings="$agent_dir/settings.json"

  if [[ -f "$project_settings" ]] && grep -q '"pi-memory-md"' "$project_settings" 2>/dev/null; then
    echo "$project_settings"
  elif [[ -f "$global_settings" ]] && grep -q '"pi-memory-md"' "$global_settings" 2>/dev/null; then
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

resolve_project_dir() {
  local settings_file local_path project_name

  settings_file="$(find_settings)"
  [[ -n "$settings_file" ]] || fail "pi-memory-md settings not found"

  if command -v jq &>/dev/null; then
    local_path="$(jq -r '."pi-memory-md".memoryDir.localPath // ."pi-memory-md".localPath // empty' "$settings_file")"
  else
    local_path="$(grep -o '"localPath"[[:space:]]*:[[:space:]]*"[^"]*"' "$settings_file" | sed 's/.*:[[:space:]]*"\([^"]*\)"/\1/' | head -n 1)"
  fi

  local_path="${local_path:-$HOME/.pi/memory-md}"
  local_path="$(eval echo "$local_path")"
  project_name="$(get_project_name)"

  echo "$local_path/$project_name"
}

validate_relative_path() {
  local rel_path="$1"

  [[ -n "$rel_path" ]] || fail "relative path is required"
  [[ "$rel_path" != /* ]] || fail "path must be relative to memory dir"
  [[ "$rel_path" == *.md ]] || fail "memory file path must end with .md"

  IFS='/' read -r -a parts <<< "$rel_path"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != "." && "$part" != ".." ]] || fail "path must not contain empty, ., or .. components"
  done
}

assert_no_symlink_path() {
  local base_dir="$1"
  local rel_path="$2"
  local current="$base_dir"

  [[ ! -L "$base_dir" ]] || fail "memory dir must not be a symlink: $base_dir"

  IFS='/' read -r -a parts <<< "$rel_path"
  for part in "${parts[@]}"; do
    current="$current/$part"
    [[ ! -L "$current" ]] || fail "refusing to write through symlink: $current"
  done
}

escape_yaml_string() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//"/\\"}
  printf '"%s"' "$value"
}

write_tags() {
  local tags="${1:-}"
  if [[ -z "$tags" ]]; then
    echo "tags: []"
    return
  fi

  echo "tags:"
  IFS=',' read -r -a tag_parts <<< "$tags"
  for raw_tag in "${tag_parts[@]}"; do
    local tag
    tag="$(printf '%s' "$raw_tag" | xargs)"
    [[ -n "$tag" ]] || continue
    printf '  - %s\n' "$(escape_yaml_string "$tag")"
  done
}

create_file() {
  local memory_dir="$1"
  local rel_path="$2"
  local description="$3"
  local tags="${4:-}"
  local today target target_dir title tmp

  [[ -d "$memory_dir" ]] || fail "memory dir does not exist: $memory_dir"
  validate_relative_path "$rel_path"
  assert_no_symlink_path "$memory_dir" "$rel_path"
  [[ -n "$description" ]] || fail "description is required"

  target="$memory_dir/$rel_path"
  target_dir="$(dirname "$target")"
  [[ ! -e "$target" ]] || fail "file already exists: $target"

  mkdir -p "$target_dir"
  assert_no_symlink_path "$memory_dir" "$rel_path"

  tmp="$(mktemp)"
  today="$(current_date)"
  title="$(basename "$rel_path" .md | tr '_-' '  ')"

  {
    echo "---"
    printf 'description: %s\n' "$(escape_yaml_string "$description")"
    write_tags "$tags"
    printf 'created: "%s"\n' "$today"
    printf 'updated: "%s"\n' "$today"
    echo "---"
    echo
    printf '# %s\n' "$title"
    echo
  } > "$tmp"

  mv -n "$tmp" "$target"
  [[ ! -e "$tmp" ]] || {
    rm -f "$tmp"
    fail "file already exists: $target"
  }
  echo "$target"
}

touch_file() {
  local memory_dir="$1"
  local rel_path="$2"
  local target today tmp

  [[ -d "$memory_dir" ]] || fail "memory dir does not exist: $memory_dir"
  validate_relative_path "$rel_path"
  assert_no_symlink_path "$memory_dir" "$rel_path"

  target="$memory_dir/$rel_path"
  [[ -f "$target" ]] || fail "file does not exist: $target"

  today="$(current_date)"
  tmp="$(mktemp)"

  awk -v today="$today" '
    BEGIN { in_fm=0; done=0; saw_updated=0 }
    NR == 1 && $0 == "---" { in_fm=1; print; next }
    in_fm && $0 == "---" {
      if (!saw_updated) print "updated: \"" today "\""
      in_fm=0; done=1; print; next
    }
    in_fm && $0 ~ /^updated:[[:space:]]*/ {
      print "updated: \"" today "\""
      saw_updated=1
      next
    }
    { print }
    END { if (!done) exit 2 }
  ' "$target" > "$tmp" || {
    rm -f "$tmp"
    fail "file must start with YAML frontmatter delimited by ---"
  }

  mv "$tmp" "$target"
  echo "$target"
}

main() {
  local command="${1:-}"
  case "$command" in
    project-dir)
      [[ $# -eq 1 ]] || { usage; exit 2; }
      resolve_project_dir
      ;;
    create)
      [[ $# -ge 4 && $# -le 5 ]] || { usage; exit 2; }
      create_file "$2" "$3" "$4" "${5:-}"
      ;;
    touch)
      [[ $# -eq 3 ]] || { usage; exit 2; }
      touch_file "$2" "$3"
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"

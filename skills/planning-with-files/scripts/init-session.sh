#!/usr/bin/env bash
# Usage: init-session.sh <session-id> <plan-description>

set -euo pipefail
set -C

if [[ $# -ne 2 || -z ${1:-} || -z ${2:-} ]]; then
  echo "Usage: $0 <session-id> <plan-description>" >&2
  exit 1
fi

session_id=$1
plan_description=$2
if [[ $plan_description == *'/'* || $plan_description == '.' || $plan_description == '..' ]]; then
  echo 'Plan description must be a single directory name' >&2
  exit 1
fi

project_root=$(git rev-parse --show-toplevel) || {
  echo 'Run this script inside a Git project' >&2
  exit 1
}
project_name=$(basename -- "$project_root")
settings_file="$HOME/.pi/agent/settings.json"
if [[ ! -f $settings_file ]]; then
  echo "Pi settings not found: $settings_file" >&2
  exit 1
fi
if ! memory_path=$(jq -er '.["pi-memory-md"] | (.memoryDir.localPath // .localPath) | select(type == "string" and length > 0)' "$settings_file"); then
  echo "pi-memory-md.memoryDir.localPath (or legacy pi-memory-md.localPath) missing or invalid in $settings_file" >&2
  exit 1
fi

case $memory_path in
  '~/'*) memory_path="$HOME/${memory_path:2}" ;;
  /*) ;;
  *) echo 'Memory localPath must be absolute or start with ~/' >&2; exit 1 ;;
esac

session_date=$(date +%Y%m%d)
session_folder="$memory_path/$project_name/plan/$(date +%Y%m%d-%H%M%S)-$plan_description"
template_folder=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../templates" && pwd)
mkdir -p -- "$session_folder"

if [[ ! -e $session_folder/findings.md ]]; then
  cp -- "$template_folder/findings.md" "$session_folder/findings.md"
  echo 'Created findings.md'
fi

if [[ ! -e $session_folder/progress.md ]]; then
  {
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == '## Session: '* ]]; then
        printf '## Session: %s/[%s]-[%s]\n' "$session_date" "$plan_description" "$session_id"
      else
        printf '%s\n' "$line"
      fi
    done < "$template_folder/progress.md"
  } > "$session_folder/progress.md"
  echo 'Created progress.md'
fi

echo "Session folder: $session_folder"

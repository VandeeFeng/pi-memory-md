#!/usr/bin/env bash
# Usage: plan.sh <init|context|check> [arguments]

set -euo pipefail

usage() {
  printf '%s\n' \
    "Usage:" \
    "  $0 init <session-id> <plan-description>" \
    "  $0 context <plan-directory>" \
    "  $0 check <plan-directory>"
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

command=$1
shift
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

case $command in
  init)
    if [[ $# -ne 2 || -z ${1:-} || -z ${2:-} ]]; then
      usage >&2
      exit 2
    fi
    exec bash "$script_directory/init-session.sh" "$@"
    ;;
  context|check)
    if [[ $# -ne 1 || -z ${1:-} ]]; then
      usage >&2
      exit 2
    fi
    if [[ $command == check ]]; then
      exec uv run --script "$script_directory/plan-context.py" --check "$1"
    fi
    exec uv run --script "$script_directory/plan-context.py" "$1"
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

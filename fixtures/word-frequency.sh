#!/usr/bin/env bash
# Count word frequency in a file (or stdin) and print the top N words.
set -euo pipefail

top="${2:-10}"

input() {
  if (($# > 0)) && [[ -n "${1:-}" ]]; then
    cat "$1"
  else
    cat
  fi
}

input "${1:-}" |
  tr '[:upper:]' '[:lower:]' |
  tr -cs '[:alnum:]' '\n' |
  grep -v '^$' |
  sort |
  uniq -c |
  sort -rn |
  head -n "$top" |
  while read -r count word; do
    printf '%-20s %s\n' "$word" "$count"
  done

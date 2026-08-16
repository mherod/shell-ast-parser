#!/usr/bin/env bash
# Sort numbers given as arguments (or read from stdin, one per line)
# using an in-shell bubble sort.
set -euo pipefail

if (($# > 0)); then
  nums=("$@")
else
  nums=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && nums+=("$line")
  done
fi

n=${#nums[@]}
for ((i = 0; i < n - 1; i++)); do
  for ((j = 0; j < n - i - 1; j++)); do
    if ((nums[j] > nums[j + 1])); then
      tmp=${nums[j]}
      nums[j]=${nums[j + 1]}
      nums[j + 1]=$tmp
    fi
  done
done

printf '%s\n' "${nums[@]}"

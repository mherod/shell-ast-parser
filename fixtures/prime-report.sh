#!/usr/bin/env bash
# Find every prime up to a limit, track the largest gap, and render text or JSON.
set -euo pipefail

limit="${1:-100}"
format="${2:-text}"

if [[ ! "$limit" =~ ^[0-9]+$ ]] || ((limit < 2)); then
  printf 'limit must be an integer greater than or equal to 2\n' >&2
  exit 2
fi

if [[ "$format" != "text" && "$format" != "json" ]]; then
  printf 'format must be text or json\n' >&2
  exit 2
fi

is_prime() {
  local n="$1"

  if ((n < 2)); then
    return 1
  fi
  if ((n == 2)); then
    return 0
  fi
  if ((n % 2 == 0)); then
    return 1
  fi

  local divisor=3
  while ((divisor <= n / divisor)); do
    if ((n % divisor == 0)); then
      return 1
    fi
    ((divisor += 2))
  done

  return 0
}

primes=()
max_gap=0
previous=0

for ((candidate = 2; candidate <= limit; candidate++)); do
  if is_prime "$candidate"; then
    primes+=("$candidate")

    if ((previous > 0)); then
      gap=$((candidate - previous))
      if ((gap > max_gap)); then
        max_gap=$gap
      fi
    fi

    previous=$candidate
  fi
done

case "$format" in
  text)
    printf 'Primes up to %d: %s\n' "$limit" "${primes[*]}"
    printf 'Count: %d; largest gap: %d\n' "${#primes[@]}" "$max_gap"
    ;;
  json)
    printf '{"limit":%d,"count":%d,"largestGap":%d,"primes":[' \
      "$limit" "${#primes[@]}" "$max_gap"
    for ((i = 0; i < ${#primes[@]}; i++)); do
      ((i > 0)) && printf ','
      printf '%d' "${primes[i]}"
    done
    printf ']}\n'
    ;;
esac

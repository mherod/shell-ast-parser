#!/usr/bin/env bash
# FizzBuzz: print 1..N, substituting Fizz/Buzz/FizzBuzz for multiples of 3/5/15.
set -euo pipefail

limit="${1:-100}"

for ((i = 1; i <= limit; i++)); do
  if ((i % 15 == 0)); then
    echo "FizzBuzz"
  elif ((i % 3 == 0)); then
    echo "Fizz"
  elif ((i % 5 == 0)); then
    echo "Buzz"
  else
    echo "$i"
  fi
done

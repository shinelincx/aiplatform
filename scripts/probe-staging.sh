#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || $1 != https://* ]]; then
  echo 'Usage: bash scripts/probe-staging.sh https://staging.example.com[:port]' >&2
  exit 2
fi

for path in /health /; do
  status=$(curl --disable --proto '=https' --silent --show-error --connect-timeout 5 \
    --max-time 10 --output /dev/null --write-out '%{http_code}' -- "${1%/}$path")
  if [[ $status != 200 ]]; then
    printf 'Staging probe %s returned HTTP %s\n' "$path" "$status" >&2
    exit 1
  fi
done

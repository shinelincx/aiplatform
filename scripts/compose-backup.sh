#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 3 ]] || fail "Usage: bash scripts/compose-backup.sh backup|restore COMPOSE_PROJECT ABSOLUTE_DIRECTORY"
operation=$1
project=$2
directory=$3
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Invalid Compose project name"
[[ "$directory" == /* ]] || fail "Specify an absolute backup directory"

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo"
compose=(docker compose --project-name "$project")
if [[ -n ${ADO_COMPOSE_WRAPPER:-} ]]; then
  [[ $operation == backup && $project == ado-staging && $ADO_COMPOSE_WRAPPER == /* ]] || fail "Invalid staging backup launcher"
  compose=("$ADO_COMPOSE_WRAPPER")
fi
storage_volume="${project}_s3data"
archive_image=postgres:16-alpine

verify_storage_volume() {
  local label
  label=$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.volume"}}' "$storage_volume")
  [[ "$label" == "$project/s3data" ]] || fail "The object storage volume does not belong to $project"
}

backup() {
  verify_storage_volume
  [[ -n "$("${compose[@]}" ps --status running --quiet postgres)" ]] || fail "PostgreSQL must be running"
  mkdir -m 700 -- "$directory"
  local service
  paused=()
  for service in web api storage; do
    if [[ -n "$("${compose[@]}" ps --status running --quiet "$service")" ]]; then
      paused+=("$service")
    fi
  done
  if (( ${#paused[@]} )); then
    trap resume_services EXIT
    "${compose[@]}" stop --timeout 30 "${paused[@]}"
  fi

  "${compose[@]}" exec -T postgres pg_dump --format=custom --username=ado ado > "$directory/database.dump"
  "${compose[@]}" exec -T postgres pg_restore --list < "$directory/database.dump" > /dev/null
  docker run --rm --network none \
    --mount "type=volume,source=$storage_volume,target=/backup-volume,readonly" \
    "$archive_image" tar -czf - -C /backup-volume . > "$directory/storage.tar.gz"
  (cd -- "$directory" && sha256sum database.dump storage.tar.gz > SHA256SUMS)
  printf 'Backup saved to %s\n' "$directory"
}

resume_services() {
  local original_exit=$?
  trap - EXIT
  "${compose[@]}" up --no-build --no-deps --no-recreate --wait --wait-timeout 120 "${paused[@]}" || exit 1
  exit "$original_exit"
}

restore() {
  [[ -f "$directory/SHA256SUMS" ]] || fail "Backup checksum manifest is missing"
  (cd -- "$directory" && cmp -s SHA256SUMS <(sha256sum database.dump storage.tar.gz)) || fail "Backup checksum verification failed"

  local resources volume
  resources=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
  [[ -z "$resources" ]] || fail "Restore requires a fresh Compose project name"
  resources=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")
  [[ -z "$resources" ]] || fail "Restore target already has volumes"
  for volume in pgdata s3data redisdata; do
    if docker volume inspect "${project}_$volume" > /dev/null 2>&1; then
      fail "Restore target volume already exists"
    fi
  done

  "${compose[@]}" create postgres storage
  verify_storage_volume
  docker run --rm --interactive --network none \
    --mount "type=volume,source=$storage_volume,target=/backup-volume" \
    "$archive_image" tar -xzf - -C /backup-volume < "$directory/storage.tar.gz"
  "${compose[@]}" up --wait --wait-timeout 120 postgres
  "${compose[@]}" exec -T postgres pg_restore --exit-on-error --single-transaction \
    --no-owner --no-privileges --username=ado --dbname=ado < "$directory/database.dump"
  ADO_BOOTSTRAP_EMAIL= ADO_BOOTSTRAP_PASSWORD= ADO_AGENT_API_KEY= GITHUB_APP_ID= GITHUB_APP_PRIVATE_KEY= GITHUB_WEBHOOK_SECRET= \
    ADO_STAGING_RELEASE_SECRET= ADO_STAGING_WORKFLOW_TOKEN= \
    "${compose[@]}" up --no-build --wait --wait-timeout 180
  printf 'Restored Compose project %s\n' "$project"
}

case "$operation" in
  backup) backup ;;
  restore) restore ;;
  *) fail "Unknown backup operation" ;;
esac

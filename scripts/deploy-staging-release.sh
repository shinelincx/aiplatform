#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

mode=${ADO_STAGING_DEPLOY_MODE:-standard}
case "$mode:${SSH_ORIGINAL_COMMAND:-}" in
  standard:deploy-ado|migration:deploy-ado-migrate) ;;
  *) exit 1 ;;
esac
IFS= read -r -n 2048 payload
mapfile -t request < <(printf '%s' "$payload" | python3 -c '
import json, os, re, sys
data = json.load(sys.stdin)
for key, pattern in {
  "sha": "[a-f0-9]{40}", "image": r"ghcr\.io/shinelincx/aiplatform@sha256:[a-f0-9]{64}",
  "user": "[A-Za-z0-9_\\[\\]-]{1,80}", "token": "[A-Za-z0-9_.-]{20,1024}"
}.items():
    value = data.get(key)
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        sys.exit("Invalid deployment request")
    print(value)
size = data.get("archive_size")
archive_sha = data.get("archive_sha")
migration = os.environ.get("ADO_STAGING_DEPLOY_MODE") == "migration"
if type(size) is not int or not 0 <= size <= 2 * 1024**3:
    sys.exit("Invalid deployment archive size")
if size:
    if not isinstance(archive_sha, str) or not re.fullmatch("[a-f0-9]{64}", archive_sha):
        sys.exit("Invalid deployment archive digest")
elif migration or archive_sha != "":
    sys.exit("Invalid deployment archive")
print(archive_sha)
print(size)
if migration:
    base = data.get("base_sha")
    if not isinstance(base, str) or not re.fullmatch("[a-f0-9]{40}", base) or base == data["sha"]:
        sys.exit("Invalid approved base revision")
    print(base)
')
unset payload
if [[ $mode == migration ]]; then
  [[ ${#request[@]} == 7 ]]
else
  [[ ${#request[@]} == 6 ]]
fi
revision=${request[0]} image=${request[1]}
root=/opt/ado-staging
compose="$root/compose.sh"
release="$root/releases/$revision"
domain=ado.thinkfiter.com
exec 9>"$root/.release.lock"
flock -w 180 9 || { printf '::error title=ADO staging release::ADO_STAGING_BUSY\n'; exit 1; }
current=$(readlink -f "$root/current")
[[ $current =~ ^/opt/ado-staging/releases/[a-f0-9]{40}$ ]]
scratch=$(mktemp -d "$root/.cd.XXXXXXXX")
export DOCKER_CONFIG="$scratch/registry"
temp_release=
switched=0
migration_applied=0
backup=
failure_code=ADO_STAGING_PREFLIGHT_FAILED

db() { docker exec -i ado-staging-postgres-1 psql -XqAt -v ON_ERROR_STOP=1 -U ado -d ado "$@"; }
stateful() { docker inspect --format '{{.Id}}' ado-staging-postgres-1 ado-staging-redis-1 ado-staging-storage-1; }
queue() {
  db -c "SELECT (SELECT count(*) FROM task_agent_plans WHERE state IN ('queued','running')) +
    (SELECT count(*) FROM execution_runs WHERE status IN ('queued','running')) +
    (SELECT count(*) FROM execution_qa WHERE state IN ('queued','running')) +
    (SELECT count(*) FROM execution_deliveries WHERE state IN ('queued','publishing'))"
}
select_release() {
  ln -s -- "$1" "$scratch/link"
  mv -Tf -- "$scratch/link" "$root/current"
}
recreate() { "$compose" up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 85 "$@"; }
public() { curl -fsS --noproxy '*' --resolve "$domain:443:127.0.0.1" --max-time 12 "$@"; }
assert_main() {
  curl -fsS --max-time 15 https://api.github.com/repos/shinelincx/aiplatform/git/ref/heads/main |
    python3 -c 'import json,sys; assert json.load(sys.stdin)["object"]["sha"] == sys.argv[1], "Revision is no longer main"' "$revision"
}
finish() {
  local status=$?
  trap - EXIT
  if (( status )); then printf '::error title=ADO staging release::%s\n' "$failure_code"; fi
  if (( status && switched )); then
    if [[ $mode == migration ]] && { (( migration_applied )) || [[ $(db -c 'SELECT max(version) FROM schema_migrations') != "$schema" ]]; }; then
      printf 'Database migration may have taken effect. Coordinate recovery using backup %s and previous release %s.\n' "$backup" "$current" >&2
    elif select_release "$current" && recreate api && recreate web && public "https://$domain/health" -o /dev/null; then
      printf 'Rolled back to %s.\n' "${current##*/}"
    else
      printf 'Rollback requires inspection.\n' >&2
    fi
  fi
  if [[ $temp_release == "$root/releases/.cd-"* ]]; then rm -rf -- "$temp_release"; fi
  rm -rf -- "$scratch"
  exit "$status"
}
trap finish EXIT

assert_main
public "https://$domain/health" -o /dev/null
failure_code=ADO_STAGING_IMAGE_FAILED
archive="$scratch/image.tar.gz"
loaded_id=
if (( request[5] > 0 )); then
  timeout 27m head -c "${request[5]}" > "$archive"
  test "$(stat -c %s "$archive")" = "${request[5]}"
  printf '%s  %s\n' "${request[4]}" "$archive" | sha256sum -c -
fi
if [[ $current == "$release" ]] && [[ $(docker inspect -f '{{.Config.Image}}' ado-staging-api-1) == "$image" &&
  $(docker inspect -f '{{.Config.Image}}' ado-staging-web-1) == "$image" ]]; then
  printf 'Release %s is already active.\n' "$revision"
  exit 0
fi
if [[ $mode == migration && ${current##*/} != "${request[6]}" ]]; then
  failure_code=ADO_STAGING_BASELINE_DIVERGED
  printf 'Staging is no longer on the approved base.\n' >&2
  exit 1
fi
local_image="ado-platform-release:$revision"
if (( request[5] > 0 )); then
  docker load --input "$archive"
  test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$local_image")" = "$revision"
  loaded_id=$(docker image inspect -f '{{.Id}}' "$local_image")
  rm -- "$archive"
fi
printf '%s' "${request[3]}" | docker login ghcr.io --username "${request[2]}" --password-stdin >/dev/null
unset request
docker pull "$image"
docker logout ghcr.io >/dev/null
if [[ -n $loaded_id ]]; then
  test "$(docker image inspect -f '{{.Id}}' "$image")" = "$loaded_id"
fi
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$revision"
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image")" = https://github.com/shinelincx/aiplatform
if [[ -n $loaded_id ]]; then docker image rm --no-prune "$local_image" >/dev/null; fi

candidate=$release
if [[ ! -d $release ]]; then
  temp_release=$(mktemp -d "$root/releases/.cd-XXXXXXXX")
  candidate=$temp_release
  docker run --rm --network none --read-only --entrypoint tar "$image" -C /app \
    --exclude=node_modules --exclude=.next --exclude=dist -cf - . | tar --no-same-owner -xf - -C "$candidate"
fi
failure_code=ADO_STAGING_COORDINATED_REQUIRED
for path in compose.staging.yaml deploy/staging-nginx.conf; do
  cmp -s "$current/$path" "$candidate/$path" || { printf '%s requires a manual coordinated release.\n' "$path" >&2; exit 1; }
done
diff -qr "$current/apps/worker/src" "$candidate/apps/worker/src" || { printf 'Worker source changed.\n' >&2; exit 1; }
changed=0
for path in apps/api/src/database.ts apps/api/src/migrate.ts apps/api/src/project-isolation.ts; do
  test -f "$current/$path" && test -f "$candidate/$path"
  if ! cmp -s "$current/$path" "$candidate/$path"; then
    [[ $mode == migration ]] || { printf '%s requires a coordinated release.\n' "$path" >&2; exit 1; }
    changed=1
  fi
done
if [[ $mode == migration ]]; then
  (( changed )) || { printf 'Release has no database changes.\n' >&2; exit 1; }
fi
if [[ -n $temp_release ]]; then
  cat > "$temp_release/compose.web-production.yaml" <<YAML
services:
  migrate:
    image: $image
    volumes: !reset []
  api:
    image: $image
    command: [node, apps/api/dist/main.js]
    volumes: !reset []
    environment:
      ADO_RELEASE_SHA: $revision
  web:
    image: $image
    command: [npm, run, start, -w, '@ado/web', --, --hostname, 0.0.0.0]
    volumes: !reset []
YAML
  mv -T -- "$temp_release" "$release"
  temp_release=
fi
grep -Fq "image: $image" "$release/compose.web-production.yaml"
failure_code=ADO_STAGING_BUSY
deadline=$((SECONDS + 180))
until [[ $(queue) == 0 ]]; do
  (( SECONDS < deadline )) || { printf 'ADO work is still in flight.\n' >&2; exit 1; }
  sleep 10
done
assert_main
workers=$(db -c "SELECT id FROM workers WHERE NOT disabled AND connection_id IS NOT NULL
  AND last_heartbeat_at > now()-interval '50 seconds' ORDER BY id")
state=$(stateful)
schema=$(db -c 'SELECT max(version) FROM schema_migrations')
started=$(date -u +%FT%TZ)
switched=1
if [[ $mode == migration ]]; then
  "$compose" stop --timeout 25 web api
else
  docker stop --time 25 ado-staging-api-1 >/dev/null
fi
test "$(queue)" = 0
if [[ $mode == migration ]]; then
  install -d -m 700 "$root/backups"
  backup="$root/backups/pre-${revision}-$(date -u +%Y%m%dT%H%M%SZ)"
  ADO_COMPOSE_WRAPPER="$compose" bash "$release/scripts/compose-backup.sh" backup ado-staging "$backup"
  (cd -- "$backup" && sha256sum -c SHA256SUMS)
  assert_main
fi
failure_code=ADO_STAGING_HEALTH_FAILED
select_release "$release"
if [[ $mode == migration ]]; then
  "$compose" run --rm --no-deps -T migrate
  migration_applied=1
  schema_after=$(db -c 'SELECT max(version) FROM schema_migrations')
  [[ $schema_after =~ ^[0-9]+$ ]] && (( schema_after >= schema ))
else
  schema_after=$schema
fi
recreate api
recreate web
test "$(stateful)" = "$state"
test "$(db -c 'SELECT max(version) FROM schema_migrations')" = "$schema_after"
public "https://$domain/health" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("revision") == sys.argv[1]' "$revision"
public "https://$domain/" -o "$scratch/workbench.html"
grep -q 'AI DEVELOPMENT ORGANIZATION' "$scratch/workbench.html"
if [[ -n $workers ]]; then
  deadline=$((SECONDS + 80))
  while :; do
    online=$(db -c "SELECT id FROM workers WHERE NOT disabled AND connection_id IS NOT NULL
      AND last_heartbeat_at >= '$started'::timestamptz ORDER BY id")
    if [[ -z $(comm -23 <(printf '%s\n' "$workers") <(printf '%s\n' "$online")) ]]; then break; fi
    (( SECONDS < deadline )) || { printf 'A previously online Worker did not reconnect.\n' >&2; exit 1; }
    sleep 5
  done
fi
switched=0
printf 'Staging is healthy on %s (%s).\n' "$revision" "$image"

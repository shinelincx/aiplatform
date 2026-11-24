
#!/usr/bin/env bash
set -euo pipefail

[[ $RELEASE_IMAGE =~ ^ghcr\.io/shinelincx/aiplatform@sha256:[a-f0-9]{64}$ ]]
[[ $RELEASE_SHA =~ ^[a-f0-9]{40}$ ]]
command=deploy-ado
if [[ -n ${RELEASE_BASE_SHA:-} ]]; then
  [[ $RELEASE_BASE_SHA =~ ^[a-f0-9]{40}$ ]]
  command=deploy-ado-migrate
fi
RELEASE_ARCHIVE_SHA=
RELEASE_ARCHIVE_SIZE=0
if [[ ${RELEASE_DIRECT_PULL:-false} != true ]]; then
  sha256sum -c SHA256SUMS
  read -r RELEASE_ARCHIVE_SHA _ < SHA256SUMS
  RELEASE_ARCHIVE_SIZE=$(stat -c %s image.tar.gz)
fi
export RELEASE_ARCHIVE_SHA RELEASE_ARCHIVE_SIZE
umask 077
printf '%s\n' "$STAGING_KEY" > "$RUNNER_TEMP/staging-key"
printf '%s\n' "$STAGING_HOST_KEY" > "$RUNNER_TEMP/staging-host"
trap 'rm -f "$RUNNER_TEMP/staging-key" "$RUNNER_TEMP/staging-host"' EXIT
{
  jq -nc '{sha:env.RELEASE_SHA,image:env.RELEASE_IMAGE,user:env.GITHUB_ACTOR,token:env.GH_TOKEN,
    base_sha:(env.RELEASE_BASE_SHA // ""),archive_sha:env.RELEASE_ARCHIVE_SHA,
    archive_size:(env.RELEASE_ARCHIVE_SIZE | tonumber)}'
  if (( RELEASE_ARCHIVE_SIZE > 0 )); then cat image.tar.gz; fi
} |
  ssh -T -i "$RUNNER_TEMP/staging-key" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$RUNNER_TEMP/staging-host" \
    -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 root@ado.thinkfiter.com "$command"

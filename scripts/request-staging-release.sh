
#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error title=ADO staging release::%s\n' "$1"
  printf '%s\n' "$2" >&2
  exit 1
}

# Compare to the deployed version so a later merge cannot skip a previously blocked migration.
base=$(curl --fail --silent --show-error --max-time 15 https://ado.thinkfiter.com/health | jq -er .revision) ||
  fail ADO_STAGING_BASELINE_UNAVAILABLE 'Cannot read the current staging revision.'
[[ $base =~ ^[a-f0-9]{40}$ ]] ||
  fail ADO_STAGING_BASELINE_UNAVAILABLE 'Staging did not report a valid revision.'
git merge-base --is-ancestor "$base" "$GITHUB_SHA" ||
  fail ADO_STAGING_BASELINE_DIVERGED "Staging revision $base is outside the history of $GITHUB_SHA."
files=$(git diff --name-only "$base" "$GITHUB_SHA" -- \
  apps/api/src/database.ts apps/api/src/migrate.ts apps/api/src/project-isolation.ts)
if [[ -z $files ]]; then
  printf 'migration=false\n' >> "$GITHUB_OUTPUT"
  exit 0
fi

manual=$(git diff --name-only "$base" "$GITHUB_SHA" -- compose.staging.yaml deploy/staging-nginx.conf apps/worker/src)
[[ -z $manual ]] || fail ADO_STAGING_COORDINATED_REQUIRED "These changes need a manual coordinated release: $manual"
pulls=$(git log --first-parent --format=%s "$base..$GITHUB_SHA" |
  sed -nE 's/^Merge pull request #([0-9]+) .*/\1/p;s/.* \(#([0-9]+)\)$/\1/p' | sort -nu | jq -sc .)
jq -nc --arg baseSha "$base" --argjson pulls "$pulls" --arg files "$files" \
  '{sha:env.GITHUB_SHA,$baseSha,image:env.RELEASE_IMAGE,sourceRun:env.GITHUB_RUN_ID,$pulls,files:($files|split("\n"))}' |
  curl --fail --silent --show-error --retry 2 --max-time 15 --header "Authorization: Bearer $STAGING_RELEASE_SECRET" \
    --json @- https://ado.thinkfiter.com/github/staging-releases ||
  fail ADO_STAGING_REGISTRATION_FAILED 'Could not register the staging approval request.'
printf 'migration=true\n' >> "$GITHUB_OUTPUT"

#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo 'Usage: bash scripts/install-wsl-worker.sh NAME [--offline]' >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 && $1 =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || usage
npm_options=(--no-audit --no-fund)
if [[ $# == 2 ]]; then
  [[ $2 == --offline ]] || usage
  npm_options+=(--offline)
fi
if [[ $(id -u) == 0 || $(uname -s) != Linux || $HOME == /mnt/* ]]; then
  echo 'Run as a non-root Linux user with a home directory on the Linux filesystem.' >&2
  exit 1
fi

node_bin=$(command -v node) && command -v npm >/dev/null || {
  echo 'Install Linux Node.js and npm, then make them available on PATH.' >&2
  exit 1
}
node_bin=$(realpath -- "$node_bin")
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
commit=$(git -C "$repo" rev-parse HEAD)
major=$(git -C "$repo" show "$commit:.nvmrc")
if [[ $("$node_bin" -p 'process.versions.node.split(".")[0]') != "$major" ]]; then
  echo "Install Node.js $major and npm, then make them available on PATH." >&2
  exit 1
fi
arch=$("$node_bin" -p 'process.arch')
case $arch in
  x64) target=x86_64-unknown-linux-musl ;;
  arm64) target=aarch64-unknown-linux-musl ;;
  *) echo "Unsupported Codex architecture: $arch" >&2; exit 1 ;;
esac

instance="$HOME/.local/share/ado-workers/$1"
release="$instance/releases/$commit"
binary_rel="node_modules/@openai/codex-linux-$arch/vendor/$target/bin/codex"
install -d -m 700 -- "$instance" "$instance/releases" "$instance/jobs" "$instance/codex" \
  "$instance/cache/npm" "$instance/cache/maven"
exec 9>"$instance/install.lock"
flock 9

if [[ ! -d $release ]]; then
  build=$(mktemp -d -- "$instance/releases/.build.XXXXXXXX")
  trap 'rm -rf -- "$build"' EXIT
  git -C "$repo" archive "$commit" | tar -x -C "$build"
  (
    cd -- "$build"
    npm ci "${npm_options[@]}"
    npm run build:shared
    npm run build -w @ado/worker
    "./$binary_rel" --version
  )
  mv -T -- "$build" "$release"
  trap - EXIT
fi
[[ -x $release/$binary_rel && -f $release/apps/worker/dist/main.js ]] || {
  echo 'The release is incomplete. Select a valid release before starting the Worker.' >&2
  exit 1
}

if [[ ! -e $instance/worker.env && ! -L $instance/worker.env ]]; then
  cat >"$instance/worker.env" <<'ENV'
API_BASE_URL=http://127.0.0.1:3101
ADO_WORKER_ID=
ADO_WORKER_TOKEN=
# ADO_CODEX_API_KEY=
# ADO_CODEX_HTTPS_PROXY=http://proxy.example:7897
# ADO_NPM_CACHE_ROOT=/absolute/path/to/cache/npm
# ADO_MAVEN_CACHE_ROOT=/absolute/path/to/cache/maven
ENV
fi
[[ -f $instance/worker.env && ! -L $instance/worker.env ]] || {
  echo 'Use a regular worker.env file in the Worker instance directory.' >&2
  exit 1
}
chmod 600 -- "$instance/worker.env"

launcher=$(mktemp -- "$instance/.run.XXXXXXXX")
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\numask 077\nnode_bin=%q\nbinary_rel=%q\n' "$node_bin" "$binary_rel"
  cat <<'LAUNCHER'
instance=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$instance/runtime"
export PATH=/usr/local/bin:/usr/bin:/bin
export ADO_EXECUTION_ROOT="$instance/jobs"
export ADO_CODEX_STATE_DIR="$instance/codex"
export ADO_CODEX_BIN="$PWD/$binary_rel"
unset API_BASE_URL ADO_WORKER_ID ADO_WORKER_TOKEN ADO_CODEX_API_KEY ADO_CODEX_HTTPS_PROXY \
  ADO_NPM_CACHE_ROOT ADO_MAVEN_CACHE_ROOT ADO_MIN_FREE_DISK_MIB
case ${1:-start} in
  start)
    exec >>"$instance/worker.log" 2>&1
    exec flock --nonblock --no-fork "$instance/worker.lock" "$node_bin" \
      --env-file="$instance/worker.env" --input-type=module -e '
        if (!process.env.ADO_WORKER_ID || !process.env.ADO_WORKER_TOKEN) {
          throw new Error("Set ADO_WORKER_ID and ADO_WORKER_TOKEN in worker.env");
        }
        await import("./apps/worker/dist/main.js");
      '
    ;;
  login)
    shift
    exec "$node_bin" --env-file="$instance/worker.env" --input-type=commonjs -e '
      const { spawnSync } = require("node:child_process");
      const { PATH, HOME, ADO_CODEX_STATE_DIR, ADO_CODEX_BIN, ADO_CODEX_HTTPS_PROXY } = process.env;
      const env = { PATH, HOME, CODEX_HOME: ADO_CODEX_STATE_DIR };
      if (ADO_CODEX_HTTPS_PROXY) env.HTTPS_PROXY = ADO_CODEX_HTTPS_PROXY;
      const args = ["-c", "cli_auth_credentials_store=\"file\"", "login", ...process.argv.slice(1)];
      const result = spawnSync(ADO_CODEX_BIN, args, { env, stdio: "inherit" });
      process.exitCode = result.status ?? 1;
    ' -- "$@"
    ;;
  *) echo 'Usage: run [start | login [--device-auth | status]]' >&2; exit 2 ;;
esac
LAUNCHER
} >"$launcher"
chmod 700 -- "$launcher"
mv -fT -- "$launcher" "$instance/run"
link=$(mktemp -d -- "$instance/.link.XXXXXXXX")
ln -s -- "$release" "$link/runtime"
mv -fT -- "$link/runtime" "$instance/runtime"
rmdir -- "$link"

printf 'Installed %s at %s\nSet Worker credentials in %s/worker.env.\n' "$commit" "$instance" "$instance"

#!/usr/bin/env bash
# Serves Jellyfin Web with this checkout's WebGPU Player add-on, live, against a Jellyfin server of your own.
#
# Run it from the folder to work in, which keeps its files:
#   serve_jellyfin_web_client.json  the settings: the server's address, the local port, and live reload
#   jellyfin-web/                   a clone of the Jellyfin Web commit the add-on builds against, built once per commit
#   webgpu-player-addon/            the add-on, built in development mode, and again on every change of its sources
#
# The browser opens http://127.0.0.1:<port>/web/, which serves Jellyfin Web from the clone, with the bootstrap the plugin
# adds to it, and the add-on. Every other request, the API, media, and the WebSocket, goes to the server, so the browser
# sees one origin, as when the server serves Jellyfin Web, and plays the server's library through the add-on.
# The server needs no plugin; with the plugin installed, its decoders, passes, and client defaults reach the add-on too.
#
# Needs Git, Node.js, and npm, and a checkout built once with ./build.sh, for the add-on's npm packages and the engine's
# WebAssembly modules and decoder packages. Works in Git Bash on Windows and in bash on Linux and macOS.

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
client_directory="$script_directory/jellyfin-webgpu-client"
serve_script="$client_directory/scripts/serve-jellyfin-web-client.js"
jellyfin_web_submodule_path='jellyfin-webgpu-client/vendor/jellyfin-web'
# The submodule's name in .gitmodules, whose URL the clone fetches from
jellyfin_web_submodule_name='jellyfin-web'
workspace_directory="$(pwd)"
config_file="$workspace_directory/serve_jellyfin_web_client.json"
web_directory="$workspace_directory/jellyfin-web"
addon_output_directory="$workspace_directory/webgpu-player-addon"
readonly script_directory client_directory serve_script jellyfin_web_submodule_path jellyfin_web_submodule_name \
    workspace_directory config_file web_directory addon_output_directory

configure_arguments=()

print_usage() {
    cat <<'USAGE'
Usage: serve_jellyfin_web_client.sh [options]

Run it from the folder to work in. The first run there needs --server. The options are stored in
serve_jellyfin_web_client.json there, which later runs read, so they need none.

Options:
  --server <url>  The Jellyfin server's address, with its base URL when it has one,
                  such as http://<host>:8096 or https://<host>/jellyfin.
  --port <port>   The port to serve on, on 127.0.0.1 only, stored as "dev_client_port" (default: 5173).
  -h, --help      Show this help.

serve_jellyfin_web_client.json also holds "liveReload" (default: true): whether open pages reload
after each successful add-on build.

Examples:
  ../jellyfin-plugin-webgpu-player/serve_jellyfin_web_client.sh --server http://<host>:8096
  ../jellyfin-plugin-webgpu-player/serve_jellyfin_web_client.sh
USAGE
}

fail() {
    printf 'serve_jellyfin_web_client.sh: %s\n' "$*" >&2
    exit 1
}

# Native Windows tools (node) need Windows paths when this runs under Git Bash
native_path() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1"
        return
    fi
    printf '%s\n' "$1"
}

# The clone's own Git configuration records that this script made it, and the commit its build is of
clone_config() {
    git -C "$web_directory" config --local "$@"
}

# Options
while [ "$#" -gt 0 ]; do
    case "$1" in
        --server | --port)
            [ "$#" -ge 2 ] || fail "$1 needs a value"
            configure_arguments+=("$1" "$2")
            shift 2
            ;;
        --server=* | --port=*)
            configure_arguments+=("${1%%=*}" "${1#*=}")
            shift
            ;;
        -h | --help)
            print_usage
            exit 0
            ;;
        *)
            fail "Unknown option: $1 (see --help)"
            ;;
    esac
done

for command_name in git node npm; do
    command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
[ -d "$client_directory/node_modules" ] \
    || fail "The add-on's npm packages are missing; run ./build.sh in $script_directory once first"

# The settings come first, so a missing or wrong server address shows before the first clone and build
node "$(native_path "$serve_script")" configure --config "$(native_path "$config_file")" \
    ${configure_arguments[@]+"${configure_arguments[@]}"}

# The Jellyfin Web commit the add-on builds against, which the plugin pins as a submodule
pinned_commit="$(git -C "$script_directory" rev-parse ":$jellyfin_web_submodule_path")" \
    || fail "Cannot read the Jellyfin Web commit $jellyfin_web_submodule_path pins"
jellyfin_web_url="$(git -C "$script_directory" config --file .gitmodules --get "submodule.$jellyfin_web_submodule_name.url")" \
    || fail "Cannot read the Jellyfin Web URL from .gitmodules"
readonly pinned_commit jellyfin_web_url

# A folder of that name this script did not clone is left alone
if [ -e "$web_directory" ]; then
    { [ -d "$web_directory/.git" ] && [ "$(clone_config --get webgpu-player.clone || true)" = true ]; } \
        || fail "$web_directory is not a clone this script made; move it away, or run from another folder"
else
    git init --quiet "$web_directory"
    git -C "$web_directory" remote add origin "$jellyfin_web_url"
    clone_config webgpu-player.clone true
fi
if [ "$(git -C "$web_directory" rev-parse --quiet --verify 'HEAD^{commit}' || true)" != "$pinned_commit" ]; then
    printf 'Fetching Jellyfin Web %s from %s\n' "$pinned_commit" "$jellyfin_web_url"
    git -C "$web_directory" fetch --quiet --depth 1 origin "$pinned_commit" \
        || fail "Cannot fetch Jellyfin Web $pinned_commit"
    git -C "$web_directory" checkout --quiet --detach "$pinned_commit" \
        || fail "Cannot check out Jellyfin Web $pinned_commit in $web_directory"
fi

# Built once per commit; the built commit is recorded only after its build succeeds, so a failed build runs again
if [ "$(clone_config --get webgpu-player.built-commit || true)" != "$pinned_commit" ] \
    || [ ! -f "$web_directory/dist/index.html" ]; then
    printf 'Building Jellyfin Web %s in %s\n' "$pinned_commit" "$web_directory"
    (cd "$web_directory" && npm ci --ignore-scripts --no-audit --no-fund && npm run build:development) \
        || fail 'The Jellyfin Web build failed'
    clone_config webgpu-player.built-commit "$pinned_commit"
fi

exec node "$(native_path "$serve_script")" serve \
    --config "$(native_path "$config_file")" \
    --web-client "$(native_path "$web_directory/dist")" \
    --addon-output "$(native_path "$addon_output_directory")"

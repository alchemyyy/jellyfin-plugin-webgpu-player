#!/usr/bin/env bash
# Serves Jellyfin Web with this checkout's WebGPU Player add-on and plugin, live, against a Jellyfin server of your own.
#
# Run it from the folder to work in, which keeps its files:
#   serve_jellyfin_web_client.json  the settings: the server's address, the local port, and live reload
#   webgpu-player-addon/            the add-on, built in development mode, and again on every change of its sources
#   webgpu-player-plugin/           the plugin, in a host of its own, built with that add-on embedded, and again on every change
#                                   of its sources; its data/ is the plugin's data folder: uploads and client defaults
#
# Jellyfin Web is built once per pinned commit in the submodule jellyfin-webgpu-client/vendor/jellyfin-web, into its own
# node_modules/ and dist/, which its .gitignore covers, so the submodule stays clean and the add-on's tooling never reads them.
#
# The browser opens http://127.0.0.1:<port>/web/, which serves Jellyfin Web from that build, with the bootstrap the plugin
# adds to it, and the add-on. The plugin's routes, /WebGPUPlayer/..., go to this checkout's plugin, which signs each request
# in as the server's user whose credentials it carries, and the settings page and its controller come from
# Jellyfin.Plugin.WebGPUPlayer/Configuration, read on every request. Every other request, the API, media, and the WebSocket,
# goes to the server, so the browser sees one origin, as when the server serves Jellyfin Web, and plays the server's library
# through the add-on. A read the server redirects to another origin, such as a split tunnel's media host, is followed here too.
# The server needs no plugin; an installed one, and its data, stay as they are.
#
# Needs Git, Node.js, npm, and the .NET SDK, and a checkout built once with ./build.sh, for the add-on's npm packages, the
# engine's WebAssembly modules, and its pinned decoder packages and pass files. Works in Git Bash on Windows and in bash
# on Linux and macOS.

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
client_directory="$script_directory/jellyfin-webgpu-client"
serve_script="$client_directory/scripts/serve-jellyfin-web-client.js"
web_directory="$script_directory/jellyfin-webgpu-client/vendor/jellyfin-web"
workspace_directory="$(pwd)"
config_file="$workspace_directory/serve_jellyfin_web_client.json"
addon_output_directory="$workspace_directory/webgpu-player-addon"
plugin_output_directory="$workspace_directory/webgpu-player-plugin"
readonly script_directory client_directory serve_script web_directory workspace_directory config_file \
    addon_output_directory plugin_output_directory

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
after each successful add-on or plugin build, and each edit of the plugin's settings page.

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

# The submodule's own Git configuration records the commit its build is of
web_config() {
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

for command_name in git node npm dotnet; do
    command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
[ -d "$client_directory/node_modules" ] \
    || fail "The add-on's npm packages are missing; run ./build.sh in $script_directory once first"

# The settings come first, so a missing or wrong server address shows before the first build
node "$(native_path "$serve_script")" configure --config "$(native_path "$config_file")" \
    ${configure_arguments[@]+"${configure_arguments[@]}"}

# The Jellyfin Web commit the add-on builds against, which the plugin pins as a submodule
pinned_commit="$(git -C "$script_directory" rev-parse ':jellyfin-webgpu-client/vendor/jellyfin-web')" \
    || fail 'Cannot read the Jellyfin Web commit the submodule pins'
readonly pinned_commit

# The submodule must be checked out at that commit; a checkout of another commit is left alone
if [ "$(git -C "$web_directory" rev-parse --quiet --verify 'HEAD^{commit}' 2>/dev/null || true)" != "$pinned_commit" ]; then
    fail "$web_directory is not checked out at the pinned Jellyfin Web $pinned_commit; run git submodule update --init in $script_directory"
fi

# Built once per commit; the built commit is recorded only after its build succeeds, so a failed build runs again
if [ "$(web_config --get webgpu-player.built-commit || true)" != "$pinned_commit" ] \
    || [ ! -f "$web_directory/dist/index.html" ]; then
    printf 'Building Jellyfin Web %s in %s\n' "$pinned_commit" "$web_directory"
    (cd "$web_directory" && npm ci --ignore-scripts --no-audit --no-fund && npm run build:development) \
        || fail 'The Jellyfin Web build failed'
    web_config webgpu-player.built-commit "$pinned_commit"
fi

exec node "$(native_path "$serve_script")" serve \
    --config "$(native_path "$config_file")" \
    --web-client "$(native_path "$web_directory/dist")" \
    --addon-output "$(native_path "$addon_output_directory")" \
    --plugin-output "$(native_path "$plugin_output_directory")"

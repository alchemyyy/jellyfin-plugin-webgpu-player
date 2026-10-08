#!/usr/bin/env bash
# Builds the client add-on, embeds it in the plugin, and builds or publishes the plugin.
#
# Initializes the client's two submodules when needed (not recursively), builds the engine's WebAssembly decoders
# when they are missing (make, with Emscripten and rustup), runs `npm ci` in jellyfin-webgpu-client/ when its
# node_modules is missing, and runs `npm run build` there against a read-only Jellyfin Web source tree.
# Then it runs dotnet build or dotnet publish, which embeds the add-on build in bin/jellyfin-webgpu-client/ in the
# plugin. Works in Git Bash on Windows and in bash on Linux and macOS.

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$script_directory/Jellyfin.Plugin.WebGPUPlayer"
project_file="$project_directory/Jellyfin.Plugin.WebGPUPlayer.csproj"
manifest_file_name='addon-manifest.json'
client_directory="$script_directory/jellyfin-webgpu-client"
engine_directory="$client_directory/vendor/webgpu-player"
addon_output_directory="$script_directory/bin/jellyfin-webgpu-client"
submodule_paths=('jellyfin-webgpu-client/vendor/webgpu-player' 'jellyfin-webgpu-client/vendor/webgpu-player-hls')
readonly script_directory project_directory project_file manifest_file_name client_directory engine_directory \
    addon_output_directory

jellyfin_web_path="$script_directory/../jellyfin-web"
skip_npm=false
configuration='Release'
publish=false

print_usage() {
    cat <<'USAGE'
Usage: ./build.sh [options]

Options:
  --jellyfin-web-path <path>  The Jellyfin Web checkout whose src/ the add-on build reads, passed to npm as
                              JELLYFIN_WEB_DIR. Nothing is written to it. Defaults to ../jellyfin-web next to
                              this repository.
  --skip-npm                  Reuse the existing add-on build in bin/jellyfin-webgpu-client/ instead of running
                              the decoder and npm builds.
  --configuration <name>      The dotnet build configuration: Debug or Release (default).
  --publish                   Run dotnet publish instead of dotnet build.
  -h, --help                  Show this help.

The first build of a checkout also builds the engine's WebAssembly decoders. That needs GNU Make, Emscripten 4.0.13
(activated with emsdk_env, or EMSDK naming the emsdk directory), and rustup; see the engine's docs/src/decoders.md.

Examples:
  ./build.sh
  EMSDK=~/emsdk ./build.sh --jellyfin-web-path ~/src/jellyfin-web --configuration Debug
  ./build.sh --skip-npm --publish
USAGE
}

fail() {
    printf 'build.sh: %s\n' "$*" >&2
    exit 1
}

# Native Windows tools (node, dotnet, make) need Windows paths when this runs under Git Bash
native_path() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1"
        return
    fi
    printf '%s\n' "$1"
}

# Reads a folder of the engine from its tools/constants.json, the one place that names them
engine_layout() {
    node -p 'require(process.argv[1])[process.argv[2]]' "$(native_path "$engine_directory/tools/constants.json")" "$1"
}

# Options
while [ "$#" -gt 0 ]; do
    case "$1" in
        --jellyfin-web-path)
            [ "$#" -ge 2 ] || fail '--jellyfin-web-path needs a value'
            jellyfin_web_path="$2"
            shift 2
            ;;
        --jellyfin-web-path=*)
            jellyfin_web_path="${1#*=}"
            shift
            ;;
        --skip-npm)
            skip_npm=true
            shift
            ;;
        --configuration)
            [ "$#" -ge 2 ] || fail '--configuration needs a value'
            configuration="$2"
            shift 2
            ;;
        --configuration=*)
            configuration="${1#*=}"
            shift
            ;;
        --publish)
            publish=true
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

case "$configuration" in
    Debug | Release) ;;
    *) fail "--configuration must be Debug or Release, not $configuration" ;;
esac

# Client add-on build
if [ "$skip_npm" = false ]; then
    jellyfin_web_directory="$(cd "$jellyfin_web_path" 2>/dev/null && pwd)" \
        || fail "No Jellyfin Web checkout at $jellyfin_web_path"
    [ -d "$jellyfin_web_directory/src" ] \
        || fail "No Jellyfin Web source tree at $jellyfin_web_directory (src is missing)"

    # Not recursive: the decoder build fetches the engine's codec source submodules itself, shallow and pinned
    for submodule_path in "${submodule_paths[@]}"; do
        if [ ! -e "$script_directory/$submodule_path/.git" ]; then
            git -C "$script_directory" submodule update --init -- "$submodule_path" \
                || fail "git submodule update --init $submodule_path failed"
        fi
    done

    # The decoders are build outputs of their own toolchain, so only a checkout without them builds them
    wasm_output_directory="$engine_directory/$(engine_layout wasmOutputDirectory)" \
        || fail 'Cannot read the engine layout (Node.js is required)'
    if [ ! -d "$wasm_output_directory" ]; then
        printf 'Building the engine WebAssembly decoders into %s\n' "$wasm_output_directory"
        # The sources first, then one job per decoder kit
        make -C "$(native_path "$engine_directory/wasm")" sources \
            && make -C "$(native_path "$engine_directory/wasm")" -j5 all \
            || fail "The engine decoder build failed; see the engine's docs/src/decoders.md for the toolchain"
    fi

    if [ ! -d "$client_directory/node_modules" ]; then
        (cd "$client_directory" && npm ci) || fail 'npm ci failed'
    fi

    # The variable is scoped to the build command, so the caller's environment is left as it was
    (cd "$client_directory" && JELLYFIN_WEB_DIR="$(native_path "$jellyfin_web_directory")" npm run build) \
        || fail 'npm run build failed'
fi

[ -f "$addon_output_directory/$manifest_file_name" ] \
    || fail "No client add-on at $addon_output_directory ($manifest_file_name is missing)"

# File Transformation rewrites every URL that contains /web/ or ends in /web, so no add-on path may have a web segment
web_named_item="$(find "$addon_output_directory" -iname web -print -quit)"
[ -z "$web_named_item" ] \
    || fail "File Transformation would intercept $web_named_item; rename it in the add-on build"

# The plugin project embeds bin/jellyfin-webgpu-client directly
file_count="$(find "$addon_output_directory" -type f | wc -l | tr -d '[:space:]')"
printf 'Embedding %s add-on files from %s\n' "$file_count" "$addon_output_directory"

# Plugin build
verb='build'
if [ "$publish" = true ]; then
    verb='publish'
fi
dotnet "$verb" "$(native_path "$project_file")" --configuration "$configuration" \
    || fail "dotnet $verb failed"

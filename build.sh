#!/usr/bin/env bash
# Builds the client add-on, embeds it in the plugin, and builds or publishes the plugin.
#
# Initializes the client's submodules when needed (not recursively): the engine, the hls.js fork, and the pinned
# Jellyfin Web, unless --jellyfin-web-path names another checkout, and of the engine's own only its Mediabunny fork.
# Builds the engine's WebAssembly modules in the background when they are missing (make, with Emscripten and rustup).
# Meanwhile it runs `npm ci` in jellyfin-webgpu-client/ when its node_modules is missing, and builds the hls.js fork.
# The engine's decoder packages, which the plugin offers to every client, build in the background once npm ci is done,
# when they are missing; their build fetches the engine's codec source submodules itself.
# Before either of those builds starts, without EMSDK, a failed Emscripten check installs the engine's own emsdk.
# Once both builds are done, it runs `npm run build` there against a read-only Jellyfin Web source tree.
# Then it runs dotnet build or dotnet publish, which embeds the add-on build in bin/jellyfin-webgpu-client/ in the plugin.
# Works in Git Bash on Windows and in bash on Linux and macOS.

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$script_directory/Jellyfin.Plugin.WebGPUPlayer"
project_file="$project_directory/Jellyfin.Plugin.WebGPUPlayer.csproj"
manifest_file_name='addon-manifest.json'
client_directory="$script_directory/jellyfin-webgpu-client"
engine_directory="$client_directory/vendor/webgpu-player"
addon_output_directory="$script_directory/bin/jellyfin-webgpu-client"
submodule_paths=('jellyfin-webgpu-client/vendor/webgpu-player' 'jellyfin-webgpu-client/vendor/webgpu-player-hls')
jellyfin_web_submodule_path='jellyfin-webgpu-client/vendor/jellyfin-web'
readonly script_directory project_directory project_file manifest_file_name client_directory engine_directory \
    addon_output_directory jellyfin_web_submodule_path

# Empty for the pinned Jellyfin Web submodule
jellyfin_web_path=''
skip_npm=false
configuration='Release'
publish=false

print_usage() {
    cat <<'USAGE'
Usage: ./build.sh [options]

Options:
  --jellyfin-web-path <path>  The Jellyfin Web checkout whose src/ the add-on build reads, passed to npm as
                              JELLYFIN_WEB_DIR. Nothing is written to it. Defaults to the pinned submodule in
                              jellyfin-webgpu-client/vendor/jellyfin-web/.
  --skip-npm                  Reuse the existing add-on build in bin/jellyfin-webgpu-client/ instead of running
                              the WebAssembly, decoder package, and npm builds.
  --configuration <name>      The dotnet build configuration: Debug or Release (default).
  --publish                   Run dotnet publish instead of dotnet build.
  -h, --help                  Show this help.

The first build of a checkout also builds the engine's WebAssembly modules and decoder packages. That needs GNU Make,
Emscripten 4.0.13, rustup, CMake, Perl, and GNU patch; see the engine's docs/src/decoders.md and
docs/src/decoder-packages.md.
Emscripten comes from the emsdk that EMSDK names, as emsdk_env sets it. Without EMSDK, a build whose Emscripten check
fails installs the pinned version into the engine's own emsdk first, about 2 GB with Python 3 to run the installer,
and the engine's Makefiles use it from then on.

Examples:
  ./build.sh
  EMSDK=~/emsdk ./build.sh --jellyfin-web-path ~/src/jellyfin-web --configuration Debug
  ./build.sh --skip-npm --publish
USAGE
}

fail() {
    # A background decoder build finishes first, so it never outlives this script and this message prints last
    wait
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

# Runs the Emscripten check each engine Makefile pins; a failed check prints the version it needs
check_emscripten() {
    local makefile_path
    for makefile_path in "$wasm_path" "$decoders_path"; do
        make --no-print-directory -C "$(native_path "$engine_directory/$makefile_path")" toolchain || return 1
    done
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
    if [ -z "$jellyfin_web_path" ]; then
        submodule_paths+=("$jellyfin_web_submodule_path")
        jellyfin_web_path="$script_directory/$jellyfin_web_submodule_path"
    fi

    # Not recursive: the engine's codec source submodules serve only its decoder projects, whose build fetches them
    for submodule_path in "${submodule_paths[@]}"; do
        if [ ! -e "$script_directory/$submodule_path/.git" ]; then
            git -C "$script_directory" submodule update --init -- "$submodule_path" \
                || fail "git submodule update --init $submodule_path failed"
        fi
    done

    # The one engine submodule the add-on build needs: the Mediabunny fork, which the engine's build compiles
    mediabunny_path="$(engine_layout mediabunnySourceDirectory)" || fail 'Cannot read the engine layout (Node.js is required)'
    if [ ! -e "$engine_directory/$mediabunny_path/.git" ]; then
        git -C "$engine_directory" submodule update --init --depth 1 -- "$mediabunny_path" \
            || fail "git submodule update --init $mediabunny_path failed in the engine"
    fi

    jellyfin_web_directory="$(cd "$jellyfin_web_path" 2>/dev/null && pwd)" \
        || fail "No Jellyfin Web checkout at $jellyfin_web_path"
    [ -d "$jellyfin_web_directory/src" ] \
        || fail "No Jellyfin Web source tree at $jellyfin_web_directory (src is missing)"

    # The engine's WebAssembly modules and decoder packages are build outputs of their own toolchains,
    # so only a checkout without them builds them
    wasm_path="$(engine_layout wasmDirectory)" || fail 'Cannot read the engine layout (Node.js is required)'
    decoders_path="$(engine_layout decodersDirectory)" || fail 'Cannot read the engine layout (Node.js is required)'
    wasm_output_directory="$engine_directory/$(engine_layout wasmOutputDirectory)" \
        || fail 'Cannot read the engine layout (Node.js is required)'
    decoder_package_directory="$engine_directory/$(engine_layout decoderOutputDirectory)" \
        || fail 'Cannot read the engine layout (Node.js is required)'

    # Emscripten, which both builds need
    # Without EMSDK, the engine's Makefiles use the engine's own emsdk,
    # so a failed check installs it at the pinned version before either build starts
    if [ ! -d "$wasm_output_directory" ] || [ ! -d "$decoder_package_directory" ]; then
        if [ -z "${EMSDK:-}" ] && ! check_emscripten 2>/dev/null; then
            command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 \
                || fail 'Python 3 is required to install the engine emsdk'
            printf 'Installing the pinned Emscripten into the engine emsdk\n'
            make --no-print-directory -C "$(native_path "$engine_directory/$wasm_path")" emsdk \
                || fail 'The engine emsdk install failed'
        fi
        if ! check_emscripten; then
            [ -z "${EMSDK:-}" ] \
                || fail "The Emscripten check failed for EMSDK=$EMSDK; name an emsdk with the pinned version active, or unset EMSDK to use the engine's own"
            fail "The Emscripten check failed for the engine emsdk; make -C $(native_path "$engine_directory/$wasm_path") emsdk reinstalls it"
        fi
    fi

    # Only npm run build reads the WebAssembly modules, so they build in the background while npm ci and the hls.js fork build run
    wasm_build_process_id=''
    if [ ! -d "$wasm_output_directory" ]; then
        printf 'Building the engine WebAssembly modules into %s\n' "$wasm_output_directory"
        # One job per module
        make -C "$(native_path "$engine_directory/$wasm_path")" -j2 all &
        wasm_build_process_id=$!
    fi

    if [ ! -d "$client_directory/node_modules" ]; then
        (cd "$client_directory" && npm ci) || fail 'npm ci failed'
    fi

    # The decoder packages are build outputs of the same toolchains, and the add-on build carries them.
    # Their build checks each package with the engine's own loader through esbuild, which npm ci installed
    decoder_package_build_process_id=''
    if [ ! -d "$decoder_package_directory" ]; then
        printf 'Building the engine decoder packages into %s\n' "$decoder_package_directory"
        decoders_directory="$(native_path "$engine_directory/$decoders_path")"
        decoder_package_script="$(native_path "$engine_directory/$(engine_layout scriptsDirectory)/decoder-packages.mjs")"
        { make -C "$decoders_directory" sources && node "$decoder_package_script"; } &
        decoder_package_build_process_id=$!
    fi

    # npm run build builds the fork too, but only after the decoders; it finds the bundle built here and skips it
    (cd "$client_directory" && node scripts/build-hls.js) || fail 'The hls.js fork build failed'

    if [ -n "$wasm_build_process_id" ]; then
        wait "$wasm_build_process_id" \
            || fail "The engine WebAssembly build failed; see the engine's docs/src/decoders.md for the toolchain"
    fi
    if [ -n "$decoder_package_build_process_id" ]; then
        wait "$decoder_package_build_process_id" \
            || fail "The engine decoder package build failed; see the engine's docs/src/decoder-packages.md for the toolchain"
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

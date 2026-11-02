#!/usr/bin/env bash
# Builds the plugin, packages it, and installs it on a Jellyfin server over SSH, replacing every installed version.
#
# The server needs key-based SSH access as a user that can write its plugin folder and restart Jellyfin.
# The defaults match a Debian package install: /var/lib/jellyfin/plugins, and the jellyfin service and user.
# The server needs unzip, python3, and systemd; it waits for /health when curl is present.
# Works in Git Bash on Windows and in bash on Linux and macOS.

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_directory="$script_directory/bin/package"
release_script='.github/scripts/release.py'
# The release script names a package webgpu-player_<version>.zip
package_pattern='webgpu-player_*.zip'
readonly script_directory package_directory release_script package_pattern

server="${JELLYFIN_DEPLOY_SERVER:-root@192.168.4.4}"
plugins_directory='/var/lib/jellyfin/plugins'
service='jellyfin'
service_user='jellyfin'
health_url='http://localhost:8096/health'
# Seconds the server may take to report healthy after it starts
health_timeout_seconds=90
skip_build=false
build_arguments=('--publish')

print_usage() {
    cat <<'USAGE'
Usage: ./deploy.sh [options]

Builds the plugin with ./build.sh --publish, packages it with the release script into bin/package/, copies the
package to the server, and installs it there: the service stops, every installed version of the plugin (found by
its GUID) is removed, the package unpacks into <plugins>/<Name>_<version>/, and the service starts again.

Options:
  --server <user@host>         The SSH destination (default: $JELLYFIN_DEPLOY_SERVER, or root@192.168.4.4).
  --plugins-directory <path>   The server's plugin folder (default: /var/lib/jellyfin/plugins).
  --service <name>             The systemd service to restart (default: jellyfin).
  --service-user <name>        The user that owns the installed files (default: jellyfin).
  --health-url <url>           The URL the server answers once started, checked on the server
                               (default: http://localhost:8096/health).
  --skip-build                 Package the existing dotnet publish output instead of running ./build.sh.
  --skip-npm                   Pass --skip-npm to ./build.sh: reuse the add-on build and rebuild only the plugin.
  -h, --help                   Show this help.

Examples:
  ./deploy.sh
  ./deploy.sh --skip-npm
  ./deploy.sh --server root@jellyfin.local
USAGE
}

fail() {
    printf 'deploy.sh: %s\n' "$*" >&2
    exit 1
}

# Options
while [ "$#" -gt 0 ]; do
    case "$1" in
        --server)
            [ "$#" -ge 2 ] || fail '--server needs a value'
            server="$2"
            shift 2
            ;;
        --plugins-directory)
            [ "$#" -ge 2 ] || fail '--plugins-directory needs a value'
            plugins_directory="$2"
            shift 2
            ;;
        --service)
            [ "$#" -ge 2 ] || fail '--service needs a value'
            service="$2"
            shift 2
            ;;
        --service-user)
            [ "$#" -ge 2 ] || fail '--service-user needs a value'
            service_user="$2"
            shift 2
            ;;
        --health-url)
            [ "$#" -ge 2 ] || fail '--health-url needs a value'
            health_url="$2"
            shift 2
            ;;
        --skip-build)
            skip_build=true
            shift
            ;;
        --skip-npm)
            build_arguments+=('--skip-npm')
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

command -v ssh >/dev/null 2>&1 || fail 'ssh is required'
command -v scp >/dev/null 2>&1 || fail 'scp is required'
command -v uv >/dev/null 2>&1 || fail 'uv is required to run the release script'

# Fails early, before a long build, when the server does not accept the key
ssh -o BatchMode=yes -o ConnectTimeout=10 "$server" true \
    || fail "ssh $server failed; key-based SSH access is required"

# Build
if [ "$skip_build" = false ]; then
    "$script_directory/build.sh" "${build_arguments[@]}" || fail "build.sh ${build_arguments[*]} failed"
fi

# Package: the zip holds the plugin, its image, and the meta.json Jellyfin reads from the plugin folder
rm -f "$package_directory"/$package_pattern
(cd "$script_directory" && uv run "$release_script" package) || fail 'Packaging failed'
package_files=("$package_directory"/$package_pattern)
[ "${#package_files[@]}" -eq 1 ] && [ -f "${package_files[0]}" ] \
    || fail "Expected one $package_pattern in $package_directory"
package_file="${package_files[0]}"
package_name="$(basename "$package_file")"
remote_package="/tmp/$package_name"

# Upload
printf 'Copying %s to %s\n' "$package_name" "$server"
scp -q -o BatchMode=yes "$package_file" "$server:$remote_package" || fail "scp to $server failed"

# Install: the remote script takes its values as arguments, quoted for the remote shell
remote_arguments="$(printf '%q ' "$remote_package" "$plugins_directory" "$service" "$service_user" "$health_url" "$health_timeout_seconds")"
printf 'Installing on %s\n' "$server"
ssh -o BatchMode=yes "$server" "bash -s -- $remote_arguments" <<'REMOTE' || fail "Installing on $server failed"
set -euo pipefail
package_file="$1"
plugins_directory="$2"
service="$3"
service_user="$4"
health_url="$5"
health_timeout_seconds="$6"

fail() {
    printf 'server: %s\n' "$*" >&2
    exit 1
}

[ -d "$plugins_directory" ] || fail "no plugin folder at $plugins_directory"

# The package's meta.json names the plugin: its GUID finds installed versions, and its name and version name the folder
plugin_identity="$(unzip -p "$package_file" meta.json | python3 -c '
import json
import sys
metadata = json.load(sys.stdin)
print(metadata["guid"])
print(metadata["name"] + "_" + metadata["version"])
')" || fail "cannot read meta.json from $package_file"
plugin_guid="$(printf '%s\n' "$plugin_identity" | sed -n 1p)"
plugin_folder="$(printf '%s\n' "$plugin_identity" | sed -n 2p)"
[ -n "$plugin_guid" ] && [ -n "$plugin_folder" ] || fail "meta.json in $package_file names no GUID, name, or version"
install_directory="$plugins_directory/$plugin_folder"

# The service starts again however the install ends, once it was stopped
systemctl stop "$service" || fail "systemctl stop $service failed"
trap 'systemctl start "$service" || true' EXIT

# Every installed version of the plugin goes, so the server loads only the new one
for metadata_file in "$plugins_directory"/*/meta.json; do
    [ -f "$metadata_file" ] || continue
    if python3 -c '
import json
import sys
with open(sys.argv[1], encoding="utf-8") as metadata_stream:
    guid = str(json.load(metadata_stream).get("guid", ""))
sys.exit(0 if guid.lower() == sys.argv[2].lower() else 1)
' "$metadata_file" "$plugin_guid"; then
        installed_directory="$(dirname "$metadata_file")"
        printf 'Removing %s\n' "$installed_directory"
        rm -rf -- "$installed_directory"
    fi
done

mkdir -p -- "$install_directory"
unzip -oq "$package_file" -d "$install_directory" || fail "unzip into $install_directory failed"
chown -R "$service_user:$service_user" "$install_directory" || fail "chown $service_user failed"
rm -f -- "$package_file"
printf 'Installed %s\n' "$install_directory"

trap - EXIT
systemctl start "$service" || fail "systemctl start $service failed"
if ! command -v curl >/dev/null 2>&1; then
    systemctl is-active --quiet "$service" || fail "$service is not active"
    printf '%s is active (no curl to check %s)\n' "$service" "$health_url"
    exit 0
fi
for ((elapsed_seconds = 0; elapsed_seconds < health_timeout_seconds; elapsed_seconds += 1)); do
    if curl -fsS -m 2 "$health_url" >/dev/null 2>&1; then
        printf '%s is healthy\n' "$service"
        exit 0
    fi
    sleep 1
done
fail "$service did not answer $health_url within $health_timeout_seconds s"
REMOTE

printf 'Deployed %s to %s\n' "$package_name" "$server"

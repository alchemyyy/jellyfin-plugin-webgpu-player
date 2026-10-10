# /// script
# requires-python = ">=3.10"
# dependencies = ["ruamel.yaml>=0.18"]
# ///
"""Sets the plugin version, and packages the published plugin for a Jellyfin plugin repository.

build.yaml holds the plugin metadata, including the version and its changelog. Directory.Build.props stamps the same
version on the assembly.

    uv run .github/scripts/release.py set-version 1.1.0.0 --changelog "Fix seeking"
    uv run .github/scripts/release.py package
    uv run .github/scripts/release.py package --source-url-base http://192.168.1.10:8000
    uv run .github/scripts/release.py release-notes v1.3.0.0 --repository alchemyyy/jellyfin-plugin-webgpu-player

set-version writes the version into both files and the changelog into build.yaml; build the plugin after it. package
zips the artifacts of the dotnet publish output (./build.sh --publish) with a meta.json and the plugin image, and inserts
or replaces that version in a plugin repository manifest whose imageUrl names the image committed on main. Both land in
bin/package/ by default, a repository to serve over HTTP for test installs. The release workflow writes the committed
manifest.json instead, with the GitHub release as the download source.

release-notes writes the GitHub release body: the install steps, the merged pull requests, and the commits since the
previous release tag. It reads the history from git and the pull requests through the GitHub CLI.
"""

import argparse
import datetime
import hashlib
import html
import io
import json
import re
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ElementTree
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

from ruamel.yaml import YAML
from ruamel.yaml.scalarstring import DoubleQuotedScalarString, FoldedScalarString

REPOSITORY_DIRECTORY: Path = Path(__file__).resolve().parents[2]
BUILD_CONFIGURATION_FILE: Path = REPOSITORY_DIRECTORY / "build.yaml"
BUILD_PROPERTIES_FILE: Path = REPOSITORY_DIRECTORY / "Directory.Build.props"
PUBLISH_DIRECTORY: Path = REPOSITORY_DIRECTORY / "bin" / "Jellyfin.Plugin.WebGPUPlayer" / "Release" / "publish"
DEFAULT_OUTPUT_DIRECTORY: Path = REPOSITORY_DIRECTORY / "bin" / "package"
# The catalog and plugin page image; the source SVG sits beside it
IMAGE_FILE: Path = REPOSITORY_DIRECTORY / "images" / "jellyfin-plugin-webgpu-player-banner.png"
# The repository whose main branch serves the image to the catalog, unless package names another
DEFAULT_REPOSITORY: str = "alchemyyy/jellyfin-plugin-webgpu-player"
MANIFEST_FILE_NAME: str = "manifest.json"
METADATA_FILE_NAME: str = "meta.json"
PACKAGE_SLUG: str = "webgpu-player"
# The default port of python -m http.server, which serves bin/package/ to a server on the same machine
DEFAULT_SOURCE_URL_BASE: str = "http://localhost:8000"
# Directory.Build.props sets each of these, and they must agree with build.yaml
VERSION_PROPERTY_NAMES: tuple[str, ...] = ("Version", "AssemblyVersion", "FileVersion")
# Four parts without leading zeros, so the text matches the parsed version
VERSION_PATTERN: re.Pattern[str] = re.compile(r"(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}")
# AssemblyVersion parts are 16-bit, and 65535 is reserved
MAXIMUM_VERSION_PART: int = 65534
# Wide enough that the YAML emitter never refolds a changelog
YAML_LINE_WIDTH: int = 4096
# Release tags are v and the four-part version
RELEASE_TAG_PREFIX: str = "v"
# The release workflow commits the version and manifest.json as this author, which is not a change worth listing
RELEASE_BOT_EMAIL: str = "41898282+github-actions[bot]@users.noreply.github.com"
GITHUB_URL: str = "https://github.com"
GITHUB_RAW_URL: str = "https://raw.githubusercontent.com"
GITHUB_API_VERSION: str = "2022-11-28"
# GitHub rejects a release body above 125000 characters
MAXIMUM_RELEASE_NOTES_LENGTH: int = 120_000
RELEASE_NOTES_TRUNCATION_NOTICE: str = "Release notes truncated because they exceed GitHub's release body limit."
# Commit fields joined by the unit separator, one record per line
COMMIT_LOG_FORMAT: str = "%H%x1f%h%x1f%ae%x1f%s"
COMMIT_FIELD_SEPARATOR: str = "\x1f"
REQUIRED_KEYS: tuple[str, ...] = (
    "name", "guid", "version", "targetAbi", "overview", "description", "category", "owner", "artifacts", "changelog",
)


@dataclass(frozen=True)
class CommitEntry:
    full_hash: str
    short_hash: str
    subject: str


@dataclass(frozen=True)
class PullRequestEntry:
    number: int
    title: str
    author_login: str
    url: str


def fail(message: str) -> NoReturn:
    """Prints an error and exits."""
    print(f"release.py: {message}", file=sys.stderr)
    sys.exit(1)


def parse_version(version: str) -> tuple[int, ...]:
    """Parses a four-part version such as 1.1.0.0, the form both Jellyfin and AssemblyVersion accept."""
    if VERSION_PATTERN.fullmatch(version) is None:
        fail(f"{version} is not a four-part version such as 1.1.0.0")
    version_parts: tuple[int, ...] = tuple(int(part) for part in version.split("."))
    if max(version_parts) > MAXIMUM_VERSION_PART:
        fail(f"{version} has a part above {MAXIMUM_VERSION_PART}, the AssemblyVersion limit")
    return version_parts


def read_newline(source_bytes: bytes) -> str:
    """Returns the line ending a file uses, so a rewrite keeps it."""
    return "\r\n" if b"\r\n" in source_bytes else "\n"


def create_round_trip_yaml() -> YAML:
    """Creates a YAML handler that rewrites build.yaml without changing its quoting, folding, or document marker."""
    round_trip_yaml: YAML = YAML()
    round_trip_yaml.preserve_quotes = True
    round_trip_yaml.explicit_start = True
    round_trip_yaml.width = YAML_LINE_WIDTH
    return round_trip_yaml


def read_build_configuration() -> dict:
    """Reads build.yaml and checks that it has every key the manifest needs."""
    configuration: dict = YAML(typ="safe").load(BUILD_CONFIGURATION_FILE.read_text(encoding="utf-8"))
    missing_keys: list[str] = [key for key in REQUIRED_KEYS if key not in configuration]
    if missing_keys:
        fail(f"build.yaml is missing {', '.join(missing_keys)}")
    parse_version(configuration["version"])
    return configuration


def write_build_configuration(version: str, changelog: str | None) -> None:
    """Writes the version, and the changelog when given, into build.yaml."""
    source_bytes: bytes = BUILD_CONFIGURATION_FILE.read_bytes()
    round_trip_yaml: YAML = create_round_trip_yaml()
    configuration: dict = round_trip_yaml.load(source_bytes.decode("utf-8"))
    configuration["version"] = DoubleQuotedScalarString(version)
    if changelog is not None:
        # A folded block, like the other long texts in build.yaml, needs no quoting or escaping
        configuration["changelog"] = FoldedScalarString(changelog + "\n")
    configuration_stream: io.StringIO = io.StringIO()
    round_trip_yaml.dump(configuration, configuration_stream)
    configuration_text: str = configuration_stream.getvalue()

    # The text a plain loader reads back must be exactly what was written
    written_configuration: dict = YAML(typ="safe").load(configuration_text)
    if written_configuration["version"] != version:
        fail(f"build.yaml would read back version {written_configuration['version']} instead of {version}")
    if changelog is not None and written_configuration["changelog"].strip() != changelog:
        fail("build.yaml would read back a different changelog; use a single-line changelog")
    BUILD_CONFIGURATION_FILE.write_text(configuration_text, encoding="utf-8", newline=read_newline(source_bytes))


def find_version_property(project: ElementTree.Element, property_name: str) -> ElementTree.Element:
    """Returns the one element that sets a version property in Directory.Build.props."""
    property_elements: list[ElementTree.Element] = project.findall(f"./PropertyGroup/{property_name}")
    if len(property_elements) != 1:
        fail(f"Directory.Build.props sets {property_name} {len(property_elements)} times instead of once")
    return property_elements[0]


def check_build_properties_version(version: str) -> None:
    """Checks that every version property of Directory.Build.props is the build.yaml version."""
    project: ElementTree.Element = ElementTree.parse(BUILD_PROPERTIES_FILE).getroot()
    for property_name in VERSION_PROPERTY_NAMES:
        property_version: str = (find_version_property(project, property_name).text or "").strip()
        if property_version != version:
            fail(f"Directory.Build.props sets {property_name} {property_version}, but build.yaml has {version}")


def write_build_properties(version: str) -> None:
    """Writes the version into every version property of Directory.Build.props."""
    source_bytes: bytes = BUILD_PROPERTIES_FILE.read_bytes()
    # Keeping comments makes the rewrite identical to the source apart from the versions
    parser: ElementTree.XMLParser = ElementTree.XMLParser(target=ElementTree.TreeBuilder(insert_comments=True))
    project: ElementTree.Element = ElementTree.fromstring(source_bytes.decode("utf-8"), parser=parser)
    for property_name in VERSION_PROPERTY_NAMES:
        find_version_property(project, property_name).text = version
    # NOTE: The serializer drops the newline after the root element
    project_text: str = ElementTree.tostring(project, encoding="unicode") + "\n"
    BUILD_PROPERTIES_FILE.write_text(project_text, encoding="utf-8", newline=read_newline(source_bytes))


def set_version(version: str, changelog: str | None) -> None:
    """Writes the version into build.yaml and Directory.Build.props, and the changelog into build.yaml."""
    parse_version(version)
    if changelog is not None:
        changelog = changelog.strip()
        if not changelog:
            fail("The changelog is empty")
    write_build_configuration(version, changelog)
    write_build_properties(version)
    print(f"Set the version to {version} in {BUILD_CONFIGURATION_FILE.name} and {BUILD_PROPERTIES_FILE.name}")


def build_metadata(configuration: dict, timestamp: str) -> dict:
    """Builds the meta.json that Jellyfin reads from the installed plugin folder."""
    return {
        "guid": str(uuid.UUID(configuration["guid"])),
        "name": configuration["name"],
        "description": configuration["description"].strip(),
        "overview": configuration["overview"],
        "owner": configuration["owner"],
        "category": configuration["category"],
        "version": configuration["version"],
        "changelog": configuration["changelog"].strip(),
        "targetAbi": configuration["targetAbi"],
        "timestamp": timestamp,
        # Relative to the plugin folder, for a plugin installed from the zip alone
        "imagePath": IMAGE_FILE.name,
    }


def write_package(configuration: dict, metadata: dict, package_file: Path) -> str:
    """Zips the artifacts and meta.json at the archive root and returns the zip's MD5."""
    package_file.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(package_file, "w", compression=zipfile.ZIP_DEFLATED) as package_archive:
        for artifact_name in configuration["artifacts"]:
            artifact_file: Path = PUBLISH_DIRECTORY / artifact_name
            if not artifact_file.is_file():
                fail(f"No {artifact_name} in {PUBLISH_DIRECTORY}; run ./build.sh --publish first")
            package_archive.write(artifact_file, artifact_name)
        # NOTE: Jellyfin downloads a repository's imageUrl only when no file of that name is in the plugin folder
        package_archive.write(IMAGE_FILE, IMAGE_FILE.name)
        package_archive.writestr(METADATA_FILE_NAME, json.dumps(metadata, indent=4, sort_keys=True) + "\n")
    return hashlib.md5(package_file.read_bytes()).hexdigest()


def update_manifest(manifest_file: Path, metadata: dict, source_url: str, checksum: str, image_url: str) -> None:
    """Inserts or replaces this version in the manifest, keeping the other versions, newest first."""
    manifest: list[dict] = []
    if manifest_file.is_file():
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))

    version_entry: dict = {
        "version": metadata["version"],
        "changelog": metadata["changelog"],
        "targetAbi": metadata["targetAbi"],
        "sourceUrl": source_url,
        "checksum": checksum,
        "timestamp": metadata["timestamp"],
    }

    existing_versions: list[dict] = []
    for package_entry in manifest:
        if package_entry.get("guid") == metadata["guid"]:
            existing_versions = package_entry.get("versions", [])
    versions: list[dict] = [entry for entry in existing_versions if entry.get("version") != metadata["version"]]
    versions.append(version_entry)
    versions.sort(key=lambda entry: parse_version(entry["version"]), reverse=True)

    package_entry: dict = {
        "guid": metadata["guid"],
        "name": metadata["name"],
        "description": metadata["description"],
        "overview": metadata["overview"],
        "owner": metadata["owner"],
        "category": metadata["category"],
        # Jellyfin rewrites an installed plugin's meta.json from the catalog, taking its image from here only
        "imageUrl": image_url,
        "versions": versions,
    }
    packages: list[dict] = [entry for entry in manifest if entry.get("guid") != metadata["guid"]]
    packages.append(package_entry)
    manifest_file.parent.mkdir(parents=True, exist_ok=True)
    manifest_file.write_text(json.dumps(packages, indent=4) + "\n", encoding="utf-8", newline="\n")


def package(source_url_base: str, output_directory: Path, manifest_file: Path, repository: str) -> None:
    """Packages the published plugin and records it in the manifest."""
    configuration: dict = read_build_configuration()
    check_build_properties_version(configuration["version"])
    timestamp: str = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    metadata: dict = build_metadata(configuration, timestamp)

    package_file_name: str = f"{PACKAGE_SLUG}_{metadata['version']}.zip"
    package_file: Path = output_directory / package_file_name
    checksum: str = write_package(configuration, metadata, package_file)

    source_url: str = f"{source_url_base.rstrip('/')}/{package_file_name}"
    # The catalog fetches the image committed on main, as it fetches manifest.json, so a release carries no image asset
    image_url: str = f"{GITHUB_RAW_URL}/{repository}/main/{IMAGE_FILE.relative_to(REPOSITORY_DIRECTORY).as_posix()}"
    update_manifest(manifest_file, metadata, source_url, checksum, image_url)
    print(f"Packaged {package_file} (MD5 {checksum})")
    print(f"Recorded {metadata['version']} in {manifest_file}, downloaded from {source_url}")


def run_command(command: list[str]) -> str:
    """Runs a command in the repository and returns its output, failing with its error output."""
    result: subprocess.CompletedProcess[str] = subprocess.run(
        command, cwd=REPOSITORY_DIRECTORY, capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode != 0:
        fail(f"{' '.join(command)} failed: {result.stderr.strip()}")
    return result.stdout


def parse_release_tag(tag: str) -> tuple[int, ...]:
    """Parses a release tag such as v1.1.0.0 into its version parts."""
    if not tag.startswith(RELEASE_TAG_PREFIX):
        fail(f"{tag} is not a release tag such as {RELEASE_TAG_PREFIX}1.1.0.0")
    return parse_version(tag.removeprefix(RELEASE_TAG_PREFIX))


def find_previous_release_tag(tag: str) -> str | None:
    """Returns the release tag with the highest version below the tag's, or None for the first release."""
    version_parts: tuple[int, ...] = parse_release_tag(tag)
    candidates: list[tuple[tuple[int, ...], str]] = []
    for candidate_tag in run_command(["git", "tag", "--list", f"{RELEASE_TAG_PREFIX}*"]).split():
        candidate_version: str = candidate_tag.removeprefix(RELEASE_TAG_PREFIX)
        if VERSION_PATTERN.fullmatch(candidate_version) is None:
            continue
        candidate_parts: tuple[int, ...] = tuple(int(part) for part in candidate_version.split("."))
        if candidate_parts < version_parts:
            candidates.append((candidate_parts, candidate_tag))
    if not candidates:
        return None
    return max(candidates)[1]


def read_commits(previous_tag: str | None, target: str) -> list[CommitEntry]:
    """Reads the commits on the target since the previous release tag, newest first, without merges or release commits."""
    # NOTE: The released commit is rebased onto main afterwards, so the tag may not be an ancestor; the range still
    # excludes everything the tag reached
    revision_range: str = f"{previous_tag}..{target}" if previous_tag else target
    log_output: str = run_command(["git", "log", "--no-merges", f"--format={COMMIT_LOG_FORMAT}", revision_range])
    commits: list[CommitEntry] = []
    for log_line in log_output.splitlines():
        if not log_line:
            continue
        full_hash, short_hash, author_email, subject = log_line.split(COMMIT_FIELD_SEPARATOR, 3)
        if author_email == RELEASE_BOT_EMAIL:
            continue
        commits.append(CommitEntry(full_hash, short_hash, subject))
    return commits


def read_pull_requests(repository: str, commits: list[CommitEntry]) -> list[PullRequestEntry]:
    """Looks up the merged pull requests that carried the commits, oldest first."""
    pull_requests_by_number: dict[int, PullRequestEntry] = {}
    for commit in commits:
        response: str = run_command([
            "gh", "api", "--header", f"X-GitHub-Api-Version: {GITHUB_API_VERSION}",
            f"repos/{repository}/commits/{commit.full_hash}/pulls",
        ])
        for pull_request in json.loads(response):
            if not pull_request.get("merged_at"):
                continue
            number: int = int(pull_request["number"])
            title: str = " ".join(str(pull_request.get("title", "")).split())
            author: dict = pull_request.get("user") or {}
            pull_requests_by_number[number] = PullRequestEntry(
                number=number,
                title=title or f"Pull request #{number}",
                author_login=str(author.get("login", "ghost")),
                url=str(pull_request["html_url"]),
            )
    return [pull_requests_by_number[number] for number in sorted(pull_requests_by_number)]


def format_pull_request_lines(pull_requests: list[PullRequestEntry]) -> list[str]:
    """Formats the pull requests as a Markdown list."""
    if not pull_requests:
        return ["- No pull requests found."]
    return [
        f"- {pull_request.title} by {pull_request.author_login} in {pull_request.url}"
        for pull_request in pull_requests
    ]


def format_commit_lines(repository: str, commits: list[CommitEntry]) -> list[str]:
    """Formats the commits as an HTML list, each linked by its short hash."""
    lines: list[str] = ["<ul>"]
    if not commits:
        lines.append("  <li>No commits.</li>")
    escaped_repository: str = html.escape(repository, quote=True)
    for commit in commits:
        commit_url: str = f"{GITHUB_URL}/{escaped_repository}/commit/{html.escape(commit.full_hash, quote=True)}"
        lines.append(
            f'  <li><a href="{commit_url}"><code>{html.escape(commit.short_hash)}</code></a>'
            f" {html.escape(commit.subject)}</li>"
        )
    lines.append("</ul>")
    return lines


def truncate_release_notes(release_notes: str) -> str:
    """Cuts the notes at a line boundary under GitHub's limit, closing the commit list and appending a notice."""
    if len(release_notes) <= MAXIMUM_RELEASE_NOTES_LENGTH:
        return release_notes
    suffix: str = f"\n\n{RELEASE_NOTES_TRUNCATION_NOTICE}"
    prefix: str = release_notes[:MAXIMUM_RELEASE_NOTES_LENGTH - len(suffix)]
    # Leave room to close the list, then drop the partial last line
    prefix = prefix[:prefix.rfind("\n", 0, len(prefix) - len("\n</ul>"))].rstrip()
    if prefix.count("<ul>") > prefix.count("</ul>"):
        prefix += "\n</ul>"
    return prefix + suffix


def release_notes(tag: str, repository: str, changelog: str | None, target: str, output_file: Path | None) -> None:
    """Writes the release body for the tag: the install steps, then the pull requests and commits since the last release."""
    configuration: dict = read_build_configuration()
    previous_tag: str | None = find_previous_release_tag(tag)
    commits: list[CommitEntry] = read_commits(previous_tag, target)
    pull_requests: list[PullRequestEntry] = read_pull_requests(repository, commits)
    manifest_url: str = f"{GITHUB_RAW_URL}/{repository}/main/{MANIFEST_FILE_NAME}"

    lines: list[str] = []
    if changelog and changelog.strip():
        lines.extend([changelog.strip(), ""])
    lines.extend([
        f"To install, add {manifest_url} as a plugin repository (Dashboard > Plugins),"
        f" then install {configuration['name']} from the catalog.",
        "",
        "The tarballs are the corresponding source of the LGPL decoders built into the plugin.",
        "",
        "## Pull Requests",
        "",
        *format_pull_request_lines(pull_requests),
        "",
        f"## Commits since {previous_tag or 'the first commit'}",
        "",
        *format_commit_lines(repository, commits),
    ])
    notes: str = truncate_release_notes("\n".join(lines)) + "\n"
    if output_file is None:
        sys.stdout.write(notes)
        return
    output_file.write_text(notes, encoding="utf-8")
    print(f"Wrote the {tag} release notes to {output_file}: {len(commits)} commits and {len(pull_requests)} pull requests")


def main() -> None:
    """Runs the set-version, package, or release-notes command."""
    argument_parser: argparse.ArgumentParser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands: argparse._SubParsersAction = argument_parser.add_subparsers(dest="command", required=True)

    set_version_parser: argparse.ArgumentParser = commands.add_parser(
        "set-version", help="Write the version into build.yaml and Directory.Build.props.",
    )
    set_version_parser.add_argument("version", help="A four-part version such as 1.1.0.0.")
    set_version_parser.add_argument("--changelog", help="The changelog of the version, written into build.yaml.")

    package_parser: argparse.ArgumentParser = commands.add_parser(
        "package", help="Zip the published plugin and record it in a plugin repository manifest.",
    )
    package_parser.add_argument(
        "--source-url-base",
        default=DEFAULT_SOURCE_URL_BASE,
        help="The URL the server downloads the zip from, without the file name (default: %(default)s).",
    )
    package_parser.add_argument(
        "--output-directory",
        type=Path,
        default=DEFAULT_OUTPUT_DIRECTORY,
        help="The folder the zip is written to (default: bin/package).",
    )
    package_parser.add_argument(
        "--manifest",
        type=Path,
        help=f"The manifest to update (default: {MANIFEST_FILE_NAME} in the output directory).",
    )
    package_parser.add_argument(
        "--repository",
        default=DEFAULT_REPOSITORY,
        help="The GitHub repository as owner/name, whose main branch serves the plugin image (default: %(default)s).",
    )

    release_notes_parser: argparse.ArgumentParser = commands.add_parser(
        "release-notes", help="Write the GitHub release body with the pull requests and commits since the last release.",
    )
    release_notes_parser.add_argument("tag", help=f"The release tag, such as {RELEASE_TAG_PREFIX}1.1.0.0.")
    release_notes_parser.add_argument(
        "--repository", required=True, help="The GitHub repository as owner/name, for links and pull requests.",
    )
    release_notes_parser.add_argument("--changelog", help="A summary written above the install steps.")
    release_notes_parser.add_argument(
        "--target", default="HEAD", help="The commit being released (default: %(default)s).",
    )
    release_notes_parser.add_argument(
        "--output-file", type=Path, help="The file the notes are written to (default: standard output).",
    )

    arguments: argparse.Namespace = argument_parser.parse_args()
    match arguments.command:
        case "set-version":
            set_version(arguments.version, arguments.changelog)
        case "package":
            output_directory: Path = arguments.output_directory.resolve()
            manifest_file: Path = (arguments.manifest or output_directory / MANIFEST_FILE_NAME).resolve()
            package(arguments.source_url_base, output_directory, manifest_file, arguments.repository)
        case "release-notes":
            release_notes(arguments.tag, arguments.repository, arguments.changelog, arguments.target, arguments.output_file)


if __name__ == "__main__":
    main()

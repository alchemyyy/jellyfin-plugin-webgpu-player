# /// script
# requires-python = ">=3.10"
# dependencies = ["ruamel.yaml>=0.18"]
# ///
"""Sets the plugin version, numbers unstable builds, and packages the published plugin for a Jellyfin plugin repository.

build.yaml holds the plugin metadata, including the version and its changelog. Directory.Build.props stamps the same
version on the assembly.

    uv run .github/scripts/release.py set-version 1.1.0.0 --changelog "Fix seeking"
    uv run .github/scripts/release.py unstable-version
    uv run .github/scripts/release.py package
    uv run .github/scripts/release.py package --source-url-base http://192.168.1.10:8000
    uv run .github/scripts/release.py record bin/package/webgpu-player_1.1.0.1.zip --source-url-base <url> --manifest <file>
    uv run .github/scripts/release.py release-notes v1.3.0.0 --repository alchemyyy/jellyfin-plugin-webgpu-player

set-version writes the version into both files and the changelog into build.yaml; build the plugin after it. A stable
release ends in .0, which set-version --stable checks, because unstable builds number the fourth part: unstable-version
prints the next one from the release tags, the latest stable release's first three parts with the next fourth, so every
unstable build sorts above the release it follows and below the next one.

package zips the artifacts of the dotnet publish output (./build.sh --publish) with a meta.json and the plugin image,
and inserts or replaces that version in a plugin repository manifest whose imageUrl names the image committed on main.
Both land in bin/package/ by default, a repository to serve over HTTP for test installs. The release workflow writes the
committed manifest.json instead, with the GitHub release as the download source. record inserts or replaces a zip that
package wrote in another manifest, from the meta.json the zip carries; once an unstable build's draft is published, the
publish manifest workflow records it in the manifest.json of the unstable branch, with the build's GitHub pre-release as
the download source.

release-notes writes the GitHub release body: the install steps, the merged pull requests, the commits since the
previous release tag, or for an unstable build since the previous release or unstable build, and the engine's commits
since the engine the previous release carried, each credited to its author and co-authors, then the contributors whose
first credited commit the release carries. It reads the history from git, the engine's from its submodule checkout or a
blobless clone, and the authors' GitHub accounts and the pull requests through the GitHub CLI.
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
import tempfile
import urllib.parse
import uuid
import xml.etree.ElementTree as ElementTree
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
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
# Release tags are v and the four-part version, and an unstable build's tag ends in -unstable as well
RELEASE_TAG_PREFIX: str = "v"
UNSTABLE_TAG_SUFFIX: str = "-unstable"
# The branch whose manifest.json lists the unstable builds, a plugin repository a server adds beside main's
UNSTABLE_BRANCH: str = "unstable"
# The release workflow commits the version and manifest.json as this author, which is not a change worth listing
RELEASE_BOT_EMAIL: str = "41898282+github-actions[bot]@users.noreply.github.com"
GITHUB_URL: str = "https://github.com"
GITHUB_RAW_URL: str = "https://raw.githubusercontent.com"
GITHUB_API_VERSION: str = "2022-11-28"
# GitHub rejects a release body above 125000 characters
MAXIMUM_RELEASE_NOTES_LENGTH: int = 120_000
RELEASE_NOTES_TRUNCATION_NOTICE: str = "Release notes truncated because they exceed GitHub's release body limit."
# Commit fields joined by the unit separator, one record per line: the hashes, the author, the commit time, the
# Co-authored-by trailers joined by the record separator, and the subject last, the one field that may hold anything
COMMIT_LOG_FORMAT: str = (
    "%H%x1f%h%x1f%an%x1f%ae%x1f%ct%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)%x1f%s"
)
COMMIT_FIELD_SEPARATOR: str = "\x1f"
TRAILER_SEPARATOR: str = "\x1e"
# The author's email and the Co-authored-by trailers of every commit before a release, which tell its new contributors
CREDIT_LOG_FORMAT: str = "%ae%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)"
# A Co-authored-by trailer: the name, then the email in angle brackets
CO_AUTHOR_PATTERN: re.Pattern[str] = re.compile(r"(?P<name>.*?)\s*<(?P<email>[^<>]+)>")
# The submodule, as .gitmodules names it, whose commits a release carries beside the plugin's
ENGINE_SUBMODULE: str = "webgpu-player"
GITHUB_REPOSITORY_URL_PATTERN: re.Pattern[str] = re.compile(
    r"github\.com[:/](?P<repository>[^/\s]+/[^/\s]+?)(?:\.git)?/?$"
)
# Commits per GraphQL query that reads their authors and pull requests
COMMIT_QUERY_BATCH_SIZE: int = 50
# GitHub's app accounts, such as github-actions[bot], which the notes credit but never welcome as new contributors
BOT_LOGIN_SUFFIX: str = "[bot]"
REQUIRED_KEYS: tuple[str, ...] = (
    "name", "guid", "version", "targetAbi", "overview", "description", "category", "owner", "artifacts", "changelog",
)


@dataclass(frozen=True)
class Contributor:
    """A commit's author or co-author, with the GitHub account its email belongs to when GitHub knows one."""

    name: str
    email: str
    login: str | None

    @property
    def identity(self) -> str:
        """The key every credit of one person shares: the GitHub account, else the email."""
        return f"login:{self.login.lower()}" if self.login else f"email:{self.email.lower()}"

    @property
    def credit(self) -> str:
        """An @mention, which GitHub links and lists among the release's contributors, else the name."""
        return f"@{self.login}" if self.login else self.name


@dataclass(frozen=True)
class PullRequestEntry:
    number: int
    title: str
    author_login: str
    url: str


@dataclass(frozen=True)
class CommitEntry:
    full_hash: str
    short_hash: str
    subject: str
    timestamp: int
    url: str
    # The author first, then the co-authors, one credit per person
    contributors: tuple[Contributor, ...]
    # The merged pull requests that carried the commit
    pull_requests: tuple[PullRequestEntry, ...]


@dataclass(frozen=True)
class GitHistory:
    """A GitHub repository, as owner/name, and the git arguments that reach its commits locally."""

    repository: str
    git_arguments: tuple[str, ...] = ()

    def git(self, *arguments: str) -> list[str]:
        """Returns a git command line over this history."""
        return ["git", *self.git_arguments, *arguments]


@dataclass(frozen=True)
class EngineHistory:
    """The engine's history beside a release: the submodule's commit the previous release carried and the target's."""

    history: GitHistory
    previous_commit: str
    commit: str

    @property
    def changed(self) -> bool:
        """Whether the release carries engine commits."""
        return self.previous_commit != self.commit


@dataclass(frozen=True)
class NewContributor:
    contributor: Contributor
    # The pull request that carried the contributor's first credited commit, else that commit
    url: str


@dataclass(frozen=True)
class ReleaseTag:
    name: str
    version: tuple[int, ...]
    unstable: bool


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


def set_version(version: str, changelog: str | None, stable: bool) -> None:
    """Writes the version into build.yaml and Directory.Build.props, and the changelog into build.yaml."""
    version_parts: tuple[int, ...] = parse_version(version)
    # Unstable builds number the fourth part after the stable release they follow
    if stable and version_parts[3] != 0:
        fail(f"{version} is not a stable version, which ends in .0; the fourth part numbers unstable builds")
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


def read_image_url(repository: str) -> str:
    """Returns the URL of the plugin image committed on main."""
    # The catalog fetches the image committed on main, as it fetches manifest.json, so a release carries no image asset
    return f"{GITHUB_RAW_URL}/{repository}/main/{IMAGE_FILE.relative_to(REPOSITORY_DIRECTORY).as_posix()}"


def record(package_file: Path, source_url_base: str, manifest_file: Path, repository: str) -> None:
    """Records a zip that package wrote in a manifest, from the meta.json the zip carries."""
    if not package_file.is_file():
        fail(f"No package at {package_file}")
    with zipfile.ZipFile(package_file) as package_archive:
        if METADATA_FILE_NAME not in package_archive.namelist():
            fail(f"{package_file.name} carries no {METADATA_FILE_NAME}")
        metadata: dict = json.loads(package_archive.read(METADATA_FILE_NAME))
    checksum: str = hashlib.md5(package_file.read_bytes()).hexdigest()
    source_url: str = f"{source_url_base.rstrip('/')}/{package_file.name}"
    update_manifest(manifest_file, metadata, source_url, checksum, read_image_url(repository))
    print(f"Recorded {metadata['version']} in {manifest_file}, downloaded from {source_url}")


def package(source_url_base: str, output_directory: Path, manifest_file: Path, repository: str) -> None:
    """Packages the published plugin and records it in the manifest."""
    configuration: dict = read_build_configuration()
    check_build_properties_version(configuration["version"])
    timestamp: str = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    metadata: dict = build_metadata(configuration, timestamp)
    package_file: Path = output_directory / f"{PACKAGE_SLUG}_{metadata['version']}.zip"
    checksum: str = write_package(configuration, metadata, package_file)
    print(f"Packaged {package_file} (MD5 {checksum})")
    record(package_file, source_url_base, manifest_file, repository)


def run_command(command: list[str]) -> str:
    """Runs a command in the repository and returns its output, failing with its error output."""
    result: subprocess.CompletedProcess[str] = subprocess.run(
        command, cwd=REPOSITORY_DIRECTORY, capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode != 0:
        fail(f"{' '.join(command)} failed: {result.stderr.strip()}")
    return result.stdout


def command_succeeds(command: list[str]) -> bool:
    """Runs a command in the repository and returns whether it exited with 0, discarding its output."""
    return subprocess.run(command, cwd=REPOSITORY_DIRECTORY, capture_output=True).returncode == 0


def read_release_tag(tag: str) -> ReleaseTag | None:
    """Reads a release tag, such as v1.1.0.0 or an unstable build's v1.1.0.1-unstable, or returns None for another tag."""
    if not tag.startswith(RELEASE_TAG_PREFIX):
        return None
    unstable: bool = tag.endswith(UNSTABLE_TAG_SUFFIX)
    version: str = tag.removeprefix(RELEASE_TAG_PREFIX).removesuffix(UNSTABLE_TAG_SUFFIX)
    if VERSION_PATTERN.fullmatch(version) is None:
        return None
    return ReleaseTag(tag, tuple(int(part) for part in version.split(".")), unstable)


def parse_release_tag(tag: str) -> ReleaseTag:
    """Parses a release tag such as v1.1.0.0, or an unstable build's such as v1.1.0.1-unstable."""
    release_tag: ReleaseTag | None = read_release_tag(tag)
    if release_tag is None:
        fail(
            f"{tag} is not a release tag such as {RELEASE_TAG_PREFIX}1.1.0.0"
            f" or {RELEASE_TAG_PREFIX}1.1.0.1{UNSTABLE_TAG_SUFFIX}"
        )
    return release_tag


def list_release_tags() -> list[ReleaseTag]:
    """Lists the repository's release tags, stable and unstable, skipping every other tag."""
    release_tags: list[ReleaseTag] = []
    for tag in run_command(["git", "tag", "--list", f"{RELEASE_TAG_PREFIX}*"]).split():
        release_tag: ReleaseTag | None = read_release_tag(tag)
        if release_tag is not None:
            release_tags.append(release_tag)
    return release_tags


def find_previous_release_tag(tag: str) -> str | None:
    """Returns the release tag with the highest version below the tag's, or None for the first release.

    A stable release follows the previous stable release, so its notes cover the unstable builds between them; an
    unstable build follows the previous release or unstable build, whichever is higher.
    """
    release_tag: ReleaseTag = parse_release_tag(tag)
    candidates: list[ReleaseTag] = [
        candidate for candidate in list_release_tags()
        if candidate.version < release_tag.version and (release_tag.unstable or not candidate.unstable)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda candidate: candidate.version).name


def next_unstable_version() -> str:
    """Returns the next unstable build's version, from the release tags.

    It takes the latest stable release's first three parts, and a fourth part above that release's and above every
    unstable build's of the same three, so it sorts above the release it follows and below the next one.
    """
    release_tags: list[ReleaseTag] = list_release_tags()
    stable_versions: list[tuple[int, ...]] = [
        release_tag.version for release_tag in release_tags if not release_tag.unstable
    ]
    if not stable_versions:
        fail("No stable release tag to number an unstable build after")
    stable_version: tuple[int, ...] = max(stable_versions)
    build_numbers: list[int] = [
        release_tag.version[3] for release_tag in release_tags
        if release_tag.unstable and release_tag.version[:3] == stable_version[:3]
    ]
    build_number: int = max([stable_version[3], *build_numbers]) + 1
    if build_number > MAXIMUM_VERSION_PART:
        fail(f"No unstable build number is left above {'.'.join(str(part) for part in stable_version)}")
    return ".".join(str(part) for part in (*stable_version[:3], build_number))


def query_commit_details(repository: str, full_hashes: list[str]) -> dict[str, dict]:
    """Reads each commit's authors, co-authors included, and the pull requests that carried it from GitHub, in batches.

    GitHub matches each author's email to the account it belongs to, which the commit itself never names. A commit
    GitHub does not have, such as one not pushed yet, is left out.
    """
    owner, name = repository.split("/", 1)
    details: dict[str, dict] = {}
    for start in range(0, len(full_hashes), COMMIT_QUERY_BATCH_SIZE):
        batch: list[str] = full_hashes[start:start + COMMIT_QUERY_BATCH_SIZE]
        # The hashes come from git log, so they are hexadecimal and safe to write into the query
        fields: str = " ".join(
            f'c{index}: object(oid: "{full_hash}") {{ ... on Commit {{ oid'
            " authors(first: 20) { nodes { name email user { login } } }"
            " associatedPullRequests(first: 10) { nodes { number title url merged author { login } } } } }"
            for index, full_hash in enumerate(batch)
        )
        query: str = (
            f"query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ {fields} }} }}"
        )
        response: dict = json.loads(run_command([
            "gh", "api", "graphql", "-f", f"query={query}", "-f", f"owner={owner}", "-f", f"name={name}",
        ]))
        repository_data: dict = (response.get("data") or {}).get("repository") or {}
        for commit in repository_data.values():
            if commit:
                details[commit["oid"]] = commit
    return details


def read_unique_contributors(contributors: list[Contributor]) -> tuple[Contributor, ...]:
    """Keeps each person's first credit, in order."""
    unique_contributors: dict[str, Contributor] = {}
    for contributor in contributors:
        unique_contributors.setdefault(contributor.identity, contributor)
    return tuple(unique_contributors.values())


def read_trailer_contributors(author_name: str, author_email: str, co_authors: str) -> tuple[Contributor, ...]:
    """Credits a commit from git alone: its author and its Co-authored-by trailers, without their GitHub accounts."""
    contributors: list[Contributor] = [Contributor(author_name, author_email, None)]
    for co_author in co_authors.split(TRAILER_SEPARATOR):
        match: re.Match[str] | None = CO_AUTHOR_PATTERN.fullmatch(co_author.strip())
        if match is not None:
            contributors.append(Contributor(match.group("name").strip(), match.group("email").strip(), None))
    return read_unique_contributors(contributors)


def read_detail_contributors(detail: dict) -> tuple[Contributor, ...]:
    """Credits a commit from GitHub's authors, the author first, each with the account GitHub matched."""
    contributors: list[Contributor] = []
    for author in (detail.get("authors") or {}).get("nodes") or []:
        if not author:
            continue
        user: dict = author.get("user") or {}
        contributors.append(Contributor(
            name=str(author.get("name") or ""),
            email=str(author.get("email") or ""),
            login=str(user["login"]) if user.get("login") else None,
        ))
    return read_unique_contributors(contributors)


def read_detail_pull_requests(detail: dict) -> tuple[PullRequestEntry, ...]:
    """Lists the merged pull requests GitHub associates with a commit, by number."""
    pull_requests: list[PullRequestEntry] = []
    for pull_request in (detail.get("associatedPullRequests") or {}).get("nodes") or []:
        if not pull_request or not pull_request.get("merged"):
            continue
        number: int = int(pull_request["number"])
        title: str = " ".join(str(pull_request.get("title") or "").split())
        author: dict = pull_request.get("author") or {}
        pull_requests.append(PullRequestEntry(
            number=number,
            title=title or f"Pull request #{number}",
            author_login=str(author.get("login") or "ghost"),
            url=str(pull_request["url"]),
        ))
    return tuple(sorted(pull_requests, key=lambda pull_request: pull_request.number))


def read_commits(history: GitHistory, revision_range: str) -> list[CommitEntry]:
    """Reads the commits of a revision range, newest first, without merges or release commits, with their credits.

    git names each commit's author and co-authors; GitHub adds the account each belongs to and the merged pull requests
    that carried the commit, and a commit GitHub does not have keeps git's names.
    """
    log_output: str = run_command(history.git("log", "--no-merges", f"--format={COMMIT_LOG_FORMAT}", revision_range))
    records: list[list[str]] = []
    for log_line in log_output.splitlines():
        if not log_line:
            continue
        fields: list[str] = log_line.split(COMMIT_FIELD_SEPARATOR, 6)
        if fields[3] == RELEASE_BOT_EMAIL:
            continue
        records.append(fields)
    details: dict[str, dict] = query_commit_details(history.repository, [fields[0] for fields in records])
    commits: list[CommitEntry] = []
    for full_hash, short_hash, author_name, author_email, timestamp, co_authors, subject in records:
        detail: dict = details.get(full_hash) or {}
        commits.append(CommitEntry(
            full_hash=full_hash,
            short_hash=short_hash,
            subject=subject,
            timestamp=int(timestamp),
            url=f"{GITHUB_URL}/{history.repository}/commit/{full_hash}",
            contributors=(
                read_detail_contributors(detail) or read_trailer_contributors(author_name, author_email, co_authors)
            ),
            pull_requests=read_detail_pull_requests(detail),
        ))
    return commits


def read_submodule(name: str) -> tuple[str, str, str]:
    """Returns a submodule's path, URL, and GitHub repository as owner/name, from .gitmodules."""
    path: str = run_command(["git", "config", "--file", ".gitmodules", "--get", f"submodule.{name}.path"]).strip()
    url: str = run_command(["git", "config", "--file", ".gitmodules", "--get", f"submodule.{name}.url"]).strip()
    match: re.Match[str] | None = GITHUB_REPOSITORY_URL_PATTERN.search(url)
    if match is None:
        fail(f"The {name} submodule's URL {url} is not a GitHub repository")
    return path, url, match.group("repository")


def read_submodule_commit(revision: str, path: str) -> str | None:
    """Returns the commit a revision pins the submodule at a path to, or None when the revision has none there."""
    for tree_line in run_command(["git", "ls-tree", revision, "--", path]).splitlines():
        _mode, object_type, object_hash = tree_line.split("\t", 1)[0].split(" ")
        if object_type == "commit":
            return object_hash
    return None


@contextmanager
def open_engine_history(previous_tag: str | None, target: str) -> Iterator[EngineHistory | None]:
    """Yields the engine's history from the commit the previous release carried to the target's, or None without one.

    It holds the engine commits the release carries, and the earlier ones, which tell the release's new contributors
    even when the engine is unchanged. The submodule's own checkout serves when it holds both commits; the release
    workflows check the plugin out without its submodules, so there a blobless clone of the engine's repository does,
    which holds every commit but no file.
    """
    if previous_tag is None:
        yield None
        return
    path, url, repository = read_submodule(ENGINE_SUBMODULE)
    previous_commit: str | None = read_submodule_commit(previous_tag, path)
    commit: str | None = read_submodule_commit(target, path)
    if previous_commit is None or commit is None:
        yield None
        return
    checkout: Path = REPOSITORY_DIRECTORY / path
    local_history: GitHistory = GitHistory(repository, ("-C", str(checkout)))
    if (checkout / ".git").exists() and all(
        command_succeeds(local_history.git("cat-file", "-e", f"{revision}^{{commit}}"))
        for revision in (previous_commit, commit)
    ):
        yield EngineHistory(local_history, previous_commit, commit)
        return
    with tempfile.TemporaryDirectory(prefix="release-notes-engine-", ignore_cleanup_errors=True) as directory:
        git_directory: Path = Path(directory) / "engine.git"
        run_command(["git", "clone", "--quiet", "--bare", "--filter=blob:none", url, str(git_directory)])
        yield EngineHistory(GitHistory(repository, ("--git-dir", str(git_directory))), previous_commit, commit)


def read_credited_emails(history: GitHistory, revision: str | None) -> set[str]:
    """Returns the lowercased email of every author and co-author of the commits a revision reaches."""
    if revision is None:
        return set()
    emails: set[str] = set()
    for log_line in run_command(history.git("log", f"--format={CREDIT_LOG_FORMAT}", revision)).splitlines():
        author_email, _, co_authors = log_line.partition(COMMIT_FIELD_SEPARATOR)
        emails.add(author_email.strip().lower())
        for co_author in co_authors.split(TRAILER_SEPARATOR):
            match: re.Match[str] | None = CO_AUTHOR_PATTERN.fullmatch(co_author.strip())
            if match is not None:
                emails.add(match.group("email").strip().lower())
    emails.discard("")
    return emails


def has_earlier_commit(repository: str, login: str, revision: str) -> bool:
    """Returns whether GitHub knows a commit of the account, under any of its emails, among those a revision reaches."""
    response: str = run_command([
        "gh", "api", "--header", f"X-GitHub-Api-Version: {GITHUB_API_VERSION}",
        f"repos/{repository}/commits?author={urllib.parse.quote(login)}&sha={urllib.parse.quote(revision)}&per_page=1",
    ])
    return bool(json.loads(response))


def find_new_contributors(
    commits: list[CommitEntry], earlier_histories: list[tuple[GitHistory, str | None]],
) -> list[NewContributor]:
    """Returns the contributors whose first credited commit the release carries, oldest first.

    A contributor is not new when a commit before the release credits them: under one of the emails the release
    credits them by, as author or co-author, or as the author of a commit GitHub matches to their account.
    """
    earlier_emails: set[str] = set().union(
        *(read_credited_emails(history, revision) for history, revision in earlier_histories)
    )
    emails_by_identity: dict[str, set[str]] = {}
    first_contributions: dict[str, NewContributor] = {}
    for commit in sorted(commits, key=lambda commit: commit.timestamp):
        for contributor in commit.contributors:
            emails_by_identity.setdefault(contributor.identity, set()).add(contributor.email.lower())
            if contributor.identity in first_contributions or (contributor.login or "").endswith(BOT_LOGIN_SUFFIX):
                continue
            first_contributions[contributor.identity] = NewContributor(
                contributor, commit.pull_requests[0].url if commit.pull_requests else commit.url,
            )
    new_contributors: list[NewContributor] = []
    for identity, first_contribution in first_contributions.items():
        if emails_by_identity[identity] & earlier_emails:
            continue
        login: str | None = first_contribution.contributor.login
        if login and any(
            revision is not None and has_earlier_commit(history.repository, login, revision)
            for history, revision in earlier_histories
        ):
            continue
        new_contributors.append(first_contribution)
    return new_contributors


def list_pull_requests(commits: list[CommitEntry]) -> list[PullRequestEntry]:
    """Lists the merged pull requests that carried the commits once each, the plugin's then the engine's, by number."""
    pull_requests_by_url: dict[str, PullRequestEntry] = {}
    for commit in commits:
        for pull_request in commit.pull_requests:
            pull_requests_by_url.setdefault(pull_request.url, pull_request)
    repositories: list[str] = list(dict.fromkeys(commit.url.rsplit("/commit/", 1)[0] for commit in commits))
    return sorted(
        pull_requests_by_url.values(),
        key=lambda pull_request: (
            next((index for index, prefix in enumerate(repositories) if pull_request.url.startswith(f"{prefix}/")),
                 len(repositories)),
            pull_request.number,
        ),
    )


def format_credit(contributors: tuple[Contributor, ...]) -> str:
    """Names a commit's contributors, the author first: @mentions, which GitHub links, else names."""
    credits: list[str] = [contributor.credit for contributor in contributors]
    if len(credits) <= 1:
        return "".join(credits)
    return f"{', '.join(credits[:-1])} and {credits[-1]}"


def format_pull_request_lines(pull_requests: list[PullRequestEntry]) -> list[str]:
    """Formats the pull requests as a Markdown list, each credited to its author."""
    if not pull_requests:
        return ["- No pull requests found."]
    return [
        f"- {pull_request.title} by @{pull_request.author_login} in {pull_request.url}"
        for pull_request in pull_requests
    ]


def format_commit_lines(commits: list[CommitEntry]) -> list[str]:
    """Formats the commits as an HTML list, each linked by its short hash and credited to its authors."""
    lines: list[str] = ["<ul>"]
    if not commits:
        lines.append("  <li>No commits.</li>")
    for commit in commits:
        credit: str = format_credit(commit.contributors)
        lines.append(
            f'  <li><a href="{html.escape(commit.url, quote=True)}"><code>{html.escape(commit.short_hash)}</code></a>'
            f" {html.escape(commit.subject)}{f' by {html.escape(credit)}' if credit else ''}</li>"
        )
    lines.append("</ul>")
    return lines


def format_new_contributor_lines(new_contributors: list[NewContributor]) -> list[str]:
    """Formats the new contributors as a Markdown list, as GitHub's generated release notes do."""
    return [
        f"- {new_contributor.contributor.credit} made their first contribution in {new_contributor.url}"
        for new_contributor in new_contributors
    ]


def fit_release_notes(head: list[str], commit_lines: list[str], tail: list[str]) -> str:
    """Joins the notes under GitHub's limit, cutting the commit lists at a line boundary when needed.

    The pull requests above the lists and the new contributors and changelog links below them always stay; a cut
    closes the list it falls in and says the notes were truncated.
    """
    notes: str = "\n".join([*head, *commit_lines, *tail])
    if len(notes) <= MAXIMUM_RELEASE_NOTES_LENGTH:
        return notes
    closing: str = "\n</ul>"
    notice: str = f"\n\n{RELEASE_NOTES_TRUNCATION_NOTICE}"
    budget: int = MAXIMUM_RELEASE_NOTES_LENGTH - len("\n".join([*head, *tail])) - len(closing) - len(notice) - 2
    kept_lines: list[str] = []
    kept_length: int = 0
    for line in commit_lines:
        if kept_length + len(line) + 1 > budget:
            break
        kept_lines.append(line)
        kept_length += len(line) + 1
    kept: str = "\n".join(kept_lines).rstrip()
    if kept.count("<ul>") > kept.count("</ul>"):
        kept += closing
    return "\n".join([*head, kept + notice, *tail])


def release_notes(tag: str, repository: str, changelog: str | None, target: str, output_file: Path | None) -> None:
    """Writes the release body for the tag: the install steps, then the pull requests and the plugin's and the engine's
    commits since the last release, each credited to its authors, and the contributors the release welcomes."""
    configuration: dict = read_build_configuration()
    release_tag: ReleaseTag = parse_release_tag(tag)
    previous_tag: str | None = find_previous_release_tag(tag)
    plugin_history: GitHistory = GitHistory(repository)
    commits: list[CommitEntry] = read_commits(plugin_history, f"{previous_tag}..{target}" if previous_tag else target)
    with open_engine_history(previous_tag, target) as engine:
        engine_changed: bool = engine is not None and engine.changed
        engine_commits: list[CommitEntry] = read_commits(
            engine.history, f"{engine.previous_commit}..{engine.commit}",
        ) if engine is not None and engine_changed else []
        # A contributor whom only the engine credited before the release is not new, even when the engine is unchanged
        earlier_histories: list[tuple[GitHistory, str | None]] = [(plugin_history, previous_tag)]
        if engine is not None:
            earlier_histories.append((engine.history, engine.previous_commit))
        new_contributors: list[NewContributor] = find_new_contributors([*commits, *engine_commits], earlier_histories)
    pull_requests: list[PullRequestEntry] = list_pull_requests([*commits, *engine_commits])
    manifest_url: str = f"{GITHUB_RAW_URL}/{repository}/main/{MANIFEST_FILE_NAME}"
    install_steps: str = (
        f"To install, add {manifest_url} as a plugin repository (Dashboard > Plugins),"
        f" then install {configuration['name']} from the catalog."
    )
    if release_tag.unstable:
        unstable_manifest_url: str = f"{GITHUB_RAW_URL}/{repository}/{UNSTABLE_BRANCH}/{MANIFEST_FILE_NAME}"
        install_steps = (
            f"This is an unstable build. To install unstable builds, add {unstable_manifest_url} as a plugin repository"
            f" beside {manifest_url} (Dashboard > Plugins), then install {configuration['name']} from the catalog;"
            " the server then updates it to each unstable build and to each stable release."
        )

    head: list[str] = []
    if changelog and changelog.strip():
        head.extend([changelog.strip(), ""])
    head.extend([
        install_steps,
        "",
        "## Pull Requests",
        "",
        *format_pull_request_lines(pull_requests),
    ])
    commit_lines: list[str] = [
        "",
        f"## Commits since {previous_tag or 'the first commit'}",
        "",
        *format_commit_lines(commits),
    ]
    tail: list[str] = []
    if engine is not None and engine_changed:
        commit_lines.extend([
            "",
            f"## Engine commits since {engine.previous_commit[:7]}",
            "",
            *format_commit_lines(engine_commits),
        ])
    if new_contributors:
        tail.extend(["", "## New Contributors", "", *format_new_contributor_lines(new_contributors)])
    if previous_tag:
        tail.extend(["", f"**Full Changelog**: {GITHUB_URL}/{repository}/compare/{previous_tag}...{tag}"])
    if engine is not None and engine_changed:
        tail.extend([
            "",
            f"**Engine Changelog**: {GITHUB_URL}/{engine.history.repository}/compare/"
            f"{engine.previous_commit[:7]}...{engine.commit[:7]}",
        ])
    notes: str = fit_release_notes(head, commit_lines, tail) + "\n"
    if output_file is None:
        sys.stdout.write(notes)
        return
    output_file.write_text(notes, encoding="utf-8")
    print(
        f"Wrote the {tag} release notes to {output_file}: {len(commits)} commits, {len(engine_commits)} engine commits,"
        f" {len(pull_requests)} pull requests, and {len(new_contributors)} new contributors"
    )


def main() -> None:
    """Runs the set-version, unstable-version, package, record, or release-notes command."""
    argument_parser: argparse.ArgumentParser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands: argparse._SubParsersAction = argument_parser.add_subparsers(dest="command", required=True)

    set_version_parser: argparse.ArgumentParser = commands.add_parser(
        "set-version", help="Write the version into build.yaml and Directory.Build.props.",
    )
    set_version_parser.add_argument("version", help="A four-part version such as 1.1.0.0.")
    set_version_parser.add_argument("--changelog", help="The changelog of the version, written into build.yaml.")
    set_version_parser.add_argument(
        "--stable", action="store_true", help="Reject a version whose fourth part is not 0, the part unstable builds number.",
    )

    commands.add_parser(
        "unstable-version", help="Print the next unstable build's version, numbered after the latest stable release tag.",
    )

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

    record_parser: argparse.ArgumentParser = commands.add_parser(
        "record", help="Record a zip that package wrote in a plugin repository manifest.",
    )
    record_parser.add_argument("package", type=Path, help="The zip, which carries its meta.json.")
    record_parser.add_argument(
        "--source-url-base", required=True, help="The URL the server downloads the zip from, without the file name.",
    )
    record_parser.add_argument(
        "--manifest", type=Path, required=True, help="The manifest to update, which is created when missing.",
    )
    record_parser.add_argument(
        "--repository",
        default=DEFAULT_REPOSITORY,
        help="The GitHub repository as owner/name, whose main branch serves the plugin image (default: %(default)s).",
    )

    release_notes_parser: argparse.ArgumentParser = commands.add_parser(
        "release-notes",
        help="Write the GitHub release body: the pull requests and the plugin's and engine's commits since the last"
        " release, credited to their authors, and the new contributors.",
    )
    release_notes_parser.add_argument(
        "tag", help=f"The release tag, such as {RELEASE_TAG_PREFIX}1.1.0.0 or {RELEASE_TAG_PREFIX}1.1.0.1{UNSTABLE_TAG_SUFFIX}.",
    )
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
            set_version(arguments.version, arguments.changelog, arguments.stable)
        case "unstable-version":
            print(next_unstable_version())
        case "package":
            output_directory: Path = arguments.output_directory.resolve()
            manifest_file: Path = (arguments.manifest or output_directory / MANIFEST_FILE_NAME).resolve()
            package(arguments.source_url_base, output_directory, manifest_file, arguments.repository)
        case "record":
            record(arguments.package.resolve(), arguments.source_url_base, arguments.manifest.resolve(), arguments.repository)
        case "release-notes":
            release_notes(arguments.tag, arguments.repository, arguments.changelog, arguments.target, arguments.output_file)


if __name__ == "__main__":
    main()

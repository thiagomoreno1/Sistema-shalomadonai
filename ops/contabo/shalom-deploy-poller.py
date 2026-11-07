#!/usr/bin/env python3
"""Build and publish public main only after GitHub CI succeeds."""
from __future__ import annotations
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import tarfile
import urllib.request
from pathlib import Path
from pathlib import PurePosixPath

REPO = "https://github.com/thiagomoreno1/Sistema-shalomadonai.git"
API = "https://api.github.com/repos/thiagomoreno1/Sistema-shalomadonai"
REPOSITORY = Path("/opt/shalom-deploy/repository")
BUILD_SOURCE = Path("/opt/shalom-deploy/build-src")
RELEASES = Path("/var/www/shalom-releases")
CURRENT = RELEASES / "current"
STATE = Path("/var/lib/shalom-deploy/current_sha")
REQUIRED = {"validate", "database"}
LOG = logging.getLogger("shalom-deploy")


def run(args, *, capture=False):
    return subprocess.run(args, check=True, text=True, capture_output=capture)


def api_json(url):
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "shalom-adonai-contabo-deployer",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def current_main_sha():
    result = run(["git", "ls-remote", "--heads", REPO, "refs/heads/main"], capture=True)
    sha = result.stdout.split()[0] if result.stdout.split() else ""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("Could not read a valid main commit from GitHub")
    return sha


def ci_is_green(sha):
    data = api_json(f"{API}/commits/{sha}/check-suites?per_page=100")
    suites = [
        suite for suite in data.get("check_suites", [])
        if suite.get("head_sha") == sha
        and suite.get("head_branch") == "main"
        and suite.get("app", {}).get("slug") == "github-actions"
        and suite.get("repository", {}).get("full_name") == "thiagomoreno1/Sistema-shalomadonai"
        and not suite.get("pull_requests")
    ]
    if not suites:
        LOG.info("Skipping %s: no GitHub Actions check suite for main", sha)
        return False
    latest_suite = max(suites, key=lambda suite: suite.get("created_at", ""))
    if latest_suite.get("status") != "completed" or latest_suite.get("conclusion") != "success":
        LOG.info("Skipping %s: latest main CI suite is not successful", sha)
        return False
    runs = api_json(f"{API}/check-suites/{latest_suite['id']}/check-runs?per_page=100")
    statuses = {
        check["name"]: (check.get("status"), check.get("conclusion"))
        for check in runs.get("check_runs", [])
        if check.get("name") in REQUIRED
    }
    if set(statuses) != REQUIRED:
        LOG.info("Skipping %s: required CI checks are not all present yet", sha)
        return False
    if any(status != ("completed", "success") for status in statuses.values()):
        LOG.info("Skipping %s: CI checks are not all successful: %s", sha, statuses)
        return False
    return True


def checkout(sha):
    REPOSITORY.parent.mkdir(parents=True, exist_ok=True)
    if not (REPOSITORY / ".git").is_dir():
        if REPOSITORY.exists():
            raise RuntimeError("Source path exists but is not a Git checkout")
        run(["git", "clone", "--depth=1", "--branch", "main", REPO, str(REPOSITORY)])
    else:
        run(["git", "-C", str(REPOSITORY), "fetch", "--depth=1", "origin", "main"])
    run(["git", "-C", str(REPOSITORY), "checkout", "--force", "--detach", sha])
    run(["git", "-C", str(REPOSITORY), "clean", "-fdx"])


def export_build_source(sha):
    if BUILD_SOURCE.is_symlink():
        raise RuntimeError("Build source path must not be a symlink")
    if BUILD_SOURCE.exists():
        shutil.rmtree(BUILD_SOURCE)
    BUILD_SOURCE.mkdir(parents=True)
    archive = REPOSITORY.parent / "source.tar"
    run(["git", "-C", str(REPOSITORY), "archive", "--format=tar", f"--output={archive}", sha])
    with tarfile.open(archive, "r:") as source_archive:
        for member in source_archive.getmembers():
            archive_path = PurePosixPath(member.name)
            if archive_path.is_absolute() or ".." in archive_path.parts:
                raise RuntimeError("Git archive contains a path outside the build tree")
            if not (member.isfile() or member.isdir()):
                raise RuntimeError("Git archive contains a link or special file")
        source_archive.extractall(BUILD_SOURCE, filter="data")
    archive.unlink(missing_ok=True)
    for root, dirs, files in os.walk(BUILD_SOURCE, followlinks=False):
        os.chown(root, 1001, 1001, follow_symlinks=False)
        for name in dirs + files:
            os.chown(Path(root) / name, 1001, 1001, follow_symlinks=False)


def validate_dist(dist):
    if not (dist / "index.html").is_file():
        raise RuntimeError("Build did not produce apps/web/dist/index.html")
    for root, dirs, files in os.walk(dist, followlinks=False):
        for name in dirs + files:
            entry = Path(root) / name
            mode = entry.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise RuntimeError("Build output contains a special file; refusing publication")


def build():
    image = os.environ.get("NODE_IMAGE", "")
    if not re.fullmatch(r"node@sha256:[0-9a-f]{64}", image):
        raise RuntimeError("NODE_IMAGE must be pinned to the verified Node 24 image digest")
    for name in ("VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"):
        if not os.environ.get(name):
            raise RuntimeError(f"Missing public build setting: {name}")
    run([
        "docker", "run", "--rm", "--network", "bridge",
        "--user", "1001:1001", "--workdir", "/src",
        "--mount", f"type=bind,source={BUILD_SOURCE},target=/src",
        "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=536870912",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pids-limit=256", "--memory=2g", "--cpus=2",
        "--env", "HOME=/tmp", "--env", "npm_config_cache=/tmp/npm-cache",
        "--env", "CI=true",
        "--env", f"VITE_SUPABASE_URL={os.environ['VITE_SUPABASE_URL']}",
        "--env", f"VITE_SUPABASE_PUBLISHABLE_KEY={os.environ['VITE_SUPABASE_PUBLISHABLE_KEY']}",
        image, "sh", "-lc", "npm ci && npm run build",
    ])
    dist = BUILD_SOURCE / "apps/web/dist"
    validate_dist(dist)
    return dist


def publish(dist, sha):
    RELEASES.mkdir(parents=True, exist_ok=True)
    release = RELEASES / sha
    staging = RELEASES / f".{sha}.staging"
    if staging.is_symlink():
        raise RuntimeError("Release staging path must not be a symlink")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    run(["rsync", "-a", "--delete", "--delay-updates", "--chown=deploy:deploy", f"{dist}/", f"{staging}/"])
    validate_dist(staging)
    if release.is_symlink():
        raise RuntimeError("Release path must not be a symlink")
    if release.exists():
        if CURRENT.is_symlink() and CURRENT.resolve() == release.resolve():
            raise RuntimeError("Refusing to replace the active release in place")
        shutil.rmtree(release)
    os.replace(staging, release)
    temporary_link = RELEASES / "current.next"
    if temporary_link.exists() and not temporary_link.is_symlink():
        raise RuntimeError("Temporary current path is not a symlink")
    temporary_link.unlink(missing_ok=True)
    temporary_link.symlink_to(release)
    if CURRENT.exists() and not CURRENT.is_symlink():
        raise RuntimeError("Current release path is not a symlink")
    os.replace(temporary_link, CURRENT)
    if not (CURRENT / "index.html").is_file():
        raise RuntimeError("Published release is missing index.html")
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(sha + "\n", encoding="ascii")
    os.replace(temporary, STATE)
    prune_releases()


def prune_releases():
    active = CURRENT.resolve(strict=True)
    versions = sorted(
        (path for path in RELEASES.iterdir() if path.is_dir() and re.fullmatch(r"[0-9a-f]{40}", path.name)),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    keep = {path.resolve() for path in versions[:5]}
    keep.add(active)
    for path in versions:
        if path.resolve() not in keep:
            shutil.rmtree(path)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sha = current_main_sha()
    if not ci_is_green(sha):
        return 0
    if STATE.is_file() and STATE.read_text(encoding="ascii").strip() == sha:
        if CURRENT.is_symlink() and CURRENT.resolve() == (RELEASES / sha).resolve() and (CURRENT / "index.html").is_file():
            LOG.info("Already deployed %s", sha)
            return 0
    LOG.info("Building validated main commit %s", sha)
    checkout(sha)
    export_build_source(sha)
    dist = build()
    if current_main_sha() != sha or not ci_is_green(sha):
        LOG.info("Skipping publication: main or its CI state changed during the build")
        return 0
    if CURRENT.is_symlink() and CURRENT.resolve() == (RELEASES / sha).resolve() and (CURRENT / "index.html").is_file():
        LOG.info("Commit %s is already the current release", sha)
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(sha + "\n", encoding="ascii")
        return 0
    publish(dist, sha)
    LOG.info("Published %s to %s", sha, CURRENT)
    return 0


if __name__ == "__main__":
    try:
        sys_exit = main()
    except Exception as exc:
        logging.basicConfig(level=logging.ERROR, format="%(asctime)s %(levelname)s %(message)s")
        logging.exception("Deployment poll failed: %s", exc)
        sys_exit = 1
    raise SystemExit(sys_exit)

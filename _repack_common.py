#!/usr/bin/env python3
"""Shared helpers for gui/assets/repack_*.py scripts."""
from __future__ import annotations

import gzip
import hashlib
import tarfile
from contextlib import contextmanager
from pathlib import Path

SKIP_DIR_NAMES = {
    ".git",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vscode",
}
SKIP_FILE_NAMES = {".DS_Store", "Thumbs.db"}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_kv(path: Path, lines: list[str]) -> None:
    text = "\n".join(lines).rstrip() + "\n"
    path.write_text(text, encoding="utf-8")


WARSHIP_RELEASE = "https://github.com/hi30998946/warship/releases/download/v1.4"


def write_bundle_meta(path: Path, *, title: str, bundled: str, sha256: str) -> None:
    """Same keys for PMTA / Haraka / ZonePMTA: SHA256 + GitHub URL; BUNDLED commented (not in exe)."""
    write_kv(path, [
        f"# {title}",
        f"# BUNDLE_BUNDLED='{bundled}'",
        f"BUNDLE_SHA256='{sha256}'",
        f"BUNDLE_URL='{WARSHIP_RELEASE}/{bundled}'",
    ])


def write_injector_meta(path: Path, *, title: str, bundled: str, sha256: str) -> None:
    """Same keys for GO / goMail / phpMailer source meta."""
    write_kv(path, [
        f"# {title}",
        f"# INJECTOR_SOURCE_BUNDLED='{bundled}'",
        f"INJECTOR_SOURCE_SHA256='{sha256}'",
        f"INJECTOR_SOURCE_URL='{WARSHIP_RELEASE}/{bundled}'",
    ])


def _should_skip(rel: str, extra_dirs: set[str] | None = None) -> bool:
    parts = rel.replace("\\", "/").split("/")
    skip_dirs = SKIP_DIR_NAMES if not extra_dirs else SKIP_DIR_NAMES | extra_dirs
    if any(p in skip_dirs for p in parts[:-1]):
        return True
    return parts[-1] in SKIP_FILE_NAMES if parts[-1] else False


def normalize_tarinfo(info: tarfile.TarInfo, *, mode: int | None = None) -> tarfile.TarInfo:
    """Drop mtime/uid/uname so the same files always hash the same."""
    info.name = info.name.replace("\\", "/")
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.pax_headers = {}
    if mode is not None:
        info.mode = mode
    elif info.isdir():
        info.mode = 0o755
    elif info.isfile():
        info.mode = 0o755 if (info.mode & 0o111) else 0o644
    return info


@contextmanager
def deterministic_tar_gz(out: Path, compresslevel: int = 9):
    """gzip mtime=0 + GNU tar, so recompressing identical files keeps SHA256."""
    out = Path(out)
    if out.exists():
        out.unlink()
    fh = out.open("wb")
    gz = gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0, compresslevel=compresslevel)
    tar = tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT)
    try:
        yield tar
    finally:
        tar.close()
        gz.close()
        fh.close()


def add_regular_file(tar: tarfile.TarFile, path: Path, arcname: str, *, mode: int | None = None) -> None:
    info = tar.gettarinfo(str(path), arcname=arcname.replace("\\", "/"))
    info = normalize_tarinfo(info, mode=mode)
    with path.open("rb") as f:
        tar.addfile(info, f)


def pack_tree(
    src: Path,
    out: Path,
    arc_prefix: str = "",
    skip_dirs: set[str] | None = None,
) -> tuple[int, int]:
    src = src.resolve()
    added = skipped = 0
    prefix = arc_prefix.strip("/").replace("\\", "/")
    extra = set(skip_dirs or ())
    with deterministic_tar_gz(out) as tar:
        for path in sorted(src.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(src).as_posix()
            if _should_skip(rel, extra):
                skipped += 1
                continue
            arcname = f"{prefix}/{rel}" if prefix else rel
            add_regular_file(tar, path, arcname)
            added += 1
    return added, skipped

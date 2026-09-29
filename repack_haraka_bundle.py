#!/usr/bin/env python3
"""Repack gui/assets/haraka-bundle-v1/ -> haraka-bundle-v1.4.tar.gz + update bundle_heraka.txt"""
from __future__ import annotations

import os
import sys
import tarfile
from pathlib import Path

ASSETS = Path(__file__).resolve().parent
sys.path.insert(0, str(ASSETS))

from _repack_common import (
    add_regular_file,
    deterministic_tar_gz,
    normalize_tarinfo,
    sha256_file,
    write_bundle_meta,
)

SRC = ASSETS / "haraka-bundle-v1"
OUT = ASSETS / "haraka-bundle-v1.4.tar.gz"
META = ASSETS / "bundle_heraka.txt"
TOPS = ("usr", "root", "etc")
EXECUTABLES = {
    "usr/bin/node",
}


def _add_dir(tar: tarfile.TarFile, arcname: str) -> None:
    info = tarfile.TarInfo(name=arcname.replace("\\", "/"))
    info.type = tarfile.DIRTYPE
    tar.addfile(normalize_tarinfo(info, mode=0o755))


def _add_tree(tar: tarfile.TarFile, src_dir: Path, arc_top: str) -> None:
    _add_dir(tar, arc_top)
    for dirpath, dirnames, filenames in os.walk(src_dir):
        dirnames.sort()
        filenames.sort()
        rel_dir = os.path.relpath(dirpath, src_dir).replace("\\", "/")
        arc_dir = arc_top if rel_dir == "." else f"{arc_top}/{rel_dir}"
        if rel_dir != ".":
            _add_dir(tar, arc_dir)
        for fn in filenames:
            path = Path(dirpath) / fn
            if not path.is_file():
                continue
            arcname = f"{arc_dir}/{fn}"
            mode = 0o755 if arcname in EXECUTABLES else None
            add_regular_file(tar, path, arcname, mode=mode)


def main() -> None:
    for top in TOPS:
        path = SRC / top
        if not path.is_dir():
            raise SystemExit(f"missing directory: {path}")

    print(f"Packing {SRC} -> {OUT}")
    with deterministic_tar_gz(OUT) as tar:
        for top in TOPS:
            _add_tree(tar, SRC / top, top)

    digest = sha256_file(OUT)
    size_mb = OUT.stat().st_size / (1024 * 1024)
    write_bundle_meta(
        META,
        title="Haraka bundle. SHA256 is the local tar; frozen EXE uses BUNDLE_URL.",
        bundled=OUT.name,
        sha256=digest,
    )
    print(f"Done: {size_mb:.1f} MB")
    print(f"SHA256: {digest}")
    print(f"Updated: {META}")


if __name__ == "__main__":
    main()

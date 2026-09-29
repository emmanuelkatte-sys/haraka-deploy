"""Sync log_delivered.js <-> configure_haraka.sh base64 block."""
from __future__ import annotations

import base64
import re
from pathlib import Path

ASSETS = Path(__file__).resolve().parent
CONFIGURE = ASSETS / "configure_haraka.sh"
PLUGIN = ASSETS / "haraka" / "plugins" / "log_delivered.js"
MARKER = "H13_B64_EOF_LOGDEL"


def embed_plugin() -> None:
    if not PLUGIN.is_file():
        raise SystemExit(f"Missing plugin file: {PLUGIN}")
    src = PLUGIN.read_text(encoding="utf-8")
    b64 = base64.b64encode(src.encode("utf-8")).decode("ascii")
    text = CONFIGURE.read_text(encoding="utf-8")
    pattern = rf"(<< '{MARKER}'\n)[\s\S]*?(\n{MARKER})"
    repl = rf"\1{b64}\2"
    updated, count = re.subn(pattern, repl, text, count=1)
    if count != 1:
        raise SystemExit(f"Could not update {MARKER} block in configure_haraka.sh")
    CONFIGURE.write_text(updated, encoding="utf-8")
    print(f"embedded {PLUGIN.name} into configure_haraka.sh ({len(src.splitlines())} lines)")


if __name__ == "__main__":
    embed_plugin()

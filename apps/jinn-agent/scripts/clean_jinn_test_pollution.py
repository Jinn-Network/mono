#!/usr/bin/env python3
"""Reversibly clean local jinn test-store pollution (Jinn-Network/mono#1841).

Before the store-path sandbox landed, suites exercising jinn session/layer
persistence wrote into the real store dirs under ``~/.jinn-client/*``. This
script backs those dirs up to a timestamped tarball, then (only with
``--yes``) removes them so a subsequent run starts clean.

Dry-run by default: prints what it would back up and remove, changes nothing.
Undo = untar the backup (see docs/runbooks/jinn-test-store-cleanup.md).

Stdlib only — no network, no external deps.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tarfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

# Make ``plugins.jinn`` importable — the script lives under
# apps/jinn-agent/scripts/, so its parent is the apps/jinn-agent root that
# holds the ``plugins`` package (same path shim as sample_and_compress.py).
sys.path.insert(0, str(Path(__file__).parent.parent))

from plugins.jinn.distill import captures_dir, episodes_dir  # noqa: E402
from plugins.jinn.session_bridge import contribution_state_dir  # noqa: E402


@contextmanager
def _env_unset(name: str):
    """Temporarily remove ``name`` from the environment, then restore it."""
    prior = os.environ.pop(name, None)
    try:
        yield
    finally:
        if prior is not None:
            os.environ[name] = prior


def _default_dir(resolver, env_var: str) -> Path:
    """Resolve a store dir's real default by ignoring its env override."""
    with _env_unset(env_var):
        return resolver().resolve()


# The three store dirs, derived from the canonical plugin resolvers (not
# re-hardcoded) so this script can never drift from what the plugin writes.
STORE_DIRS = (
    _default_dir(captures_dir, "JINN_LAYER_CAPTURES_DIR"),
    _default_dir(episodes_dir, "JINN_LAYER_EPISODES_DIR"),
    _default_dir(contribution_state_dir, "JINN_MINEABLE_STATE_DIR"),
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="actually back up and remove the store dirs (default: dry-run).",
    )
    args = parser.parse_args()

    present = [d for d in STORE_DIRS if d.exists()]
    if not present:
        print("No jinn store dirs present — nothing to clean.")
        return 0

    print("Jinn store dirs found:")
    for d in present:
        print(f"  {d}")

    if not args.yes:
        print("\nDry-run (no --yes): nothing changed. Re-run with --yes to")
        print("back up to a timestamped tarball and remove these dirs.")
        return 0

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = Path.home() / ".jinn-client" / f".pollution-backup-{ts}.tgz"
    with tarfile.open(backup, "w:gz") as tar:
        for d in present:
            tar.add(d, arcname=d.relative_to(Path.home()))
    print(f"\nBacked up to {backup}")

    for d in present:
        shutil.rmtree(d)
        print(f"Removed {d}")

    print(f"\nUndo: tar -xzf {backup} -C {Path.home()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

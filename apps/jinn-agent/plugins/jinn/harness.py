"""Resolve the harness identity the plugin is running inside.

Stock Hermes and the jinn-agent fork share ONE plugin artifact. The fork's
bin/jinn-agent exports JINN_HARNESS_NAME/_VERSION and JINN_CLI_NAME; on a stock
host those are unset and we fall back to the host's own identity. Feature-detect
via env — never assume the fork, never sniff for fork-owned files.
"""
from __future__ import annotations

import os
import sys
from typing import Tuple

DEFAULT_NAME = "hermes-agent"


def harness_name() -> str:
    return (os.environ.get("JINN_HARNESS_NAME") or "").strip() or DEFAULT_NAME


def harness_version() -> str:
    v = (os.environ.get("JINN_HARNESS_VERSION") or "").strip()
    if v:
        return v
    try:
        from hermes_cli import __version__ as host_version
        return str(host_version)
    except (ImportError, AttributeError):
        return "unknown"


def harness() -> Tuple[str, str]:
    return harness_name(), harness_version()


def is_fork() -> bool:
    return harness_name() != DEFAULT_NAME


def cli_name() -> str:
    name = (os.environ.get("JINN_CLI_NAME") or "").strip()
    if name:
        return name
    argv0 = os.path.basename(sys.argv[0] or "")
    return argv0 or "hermes"

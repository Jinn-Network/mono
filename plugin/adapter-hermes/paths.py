"""Where the adapter's state lives.

One rule governs the whole module: every path is derived from the Hermes home
in effect, so two Hermes homes on one machine never share an archive, an index,
or a capture directory. That is cross-plan contract 5 ("per-Hermes-home
archives by default"), implemented once, here.
"""

from __future__ import annotations

import os
from pathlib import Path


def hermes_home() -> Path:
    """The active Hermes home. ``HERMES_HOME`` is the profile switch Hermes itself uses."""
    value = (os.environ.get("HERMES_HOME") or "").strip()
    return Path(value).resolve() if value else (Path.home() / ".hermes").resolve()


def plugin_dir() -> Path:
    """This plugin's own directory: the clone root when installed."""
    return Path(__file__).resolve().parent


def state_dir() -> Path:
    """Adapter-owned state: markers, logs. Never the runtime's data."""
    return (hermes_home() / "jinn").resolve()


def runtime_home() -> Path:
    """``JINN_PLUGIN_HOME`` for every runtime instance this adapter is responsible for."""
    return state_dir() / "runtime-home"


def is_installed_plugin() -> bool:
    """True only under ``<hermes home>/plugins/``.

    The acquisition path (runtime_pin.ensure) is gated on this: a repository
    checkout must never npm-install into the working tree, and a user's
    installed clone must, because stock Hermes has no dependency-install hook.
    """
    try:
        plugin_dir().relative_to((hermes_home() / "plugins").resolve())
    except ValueError:
        return False
    return True

"""Register the runtime's read-only tools with the host's own MCP plumbing.

Spec 6.2 puts the model-facing half of the seam behind Hermes's native
``mcp_servers`` config, so the host spawns its own runtime instance in the
read-only ``tools`` role. This module writes that one key and nothing else.

It is written rather than documented because the acceptance gate is one install
command and zero questions; asking a person to hand-edit YAML fails the gate.
Hermes's config watcher (cli.py) picks the change up within five seconds, so the
tools appear in the session that installed the plugin.

Known limitation: Hermes has no plugin-disable hook, so this key survives
``hermes plugins disable jinn``. The command deliberately points inside the
plugin directory, so ``hermes plugins remove jinn`` leaves a dead entry rather
than a live server, and the doctor names that state.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

SERVER_KEY = "jinn"

Loader = Callable[[], Dict[str, Any]]
Saver = Callable[[Dict[str, Any]], None]


def _default_loader() -> Dict[str, Any]:
    from hermes_cli.config import load_config

    return load_config()


def _default_saver(config: Dict[str, Any]) -> None:
    from hermes_cli.config import save_config

    save_config(config)


def desired_entry(resolution, home: Path) -> Dict[str, Any]:
    """The exact entry this adapter owns.

    ``env`` carries only ``JINN_PLUGIN_HOME`` — the one thing the two instances
    must agree on. Custody law C2: no key material in any position.
    """
    return {
        "command": resolution.argv[0],
        "args": [*resolution.argv[1:], "serve", "--role", "tools"],
        "env": {"JINN_PLUGIN_HOME": str(home)},
        "enabled": True,
    }


def read_entry(loader: Optional[Loader] = None) -> Optional[Dict[str, Any]]:
    try:
        config = (loader or _default_loader)()
    except Exception as exc:
        logger.debug("jinn: host config unreadable: %s", exc)
        return None
    servers = config.get("mcp_servers")
    if not isinstance(servers, dict):
        return None
    entry = servers.get(SERVER_KEY)
    return entry if isinstance(entry, dict) else None


def entry_is_current(entry: Dict[str, Any], resolution, home: Path) -> bool:
    return entry == desired_entry(resolution, home)


def ensure_entry(
    resolution,
    home: Path,
    loader: Optional[Loader] = None,
    saver: Optional[Saver] = None,
) -> str:
    """Idempotently write the entry. Returns what happened; never raises.

    Returns one of ``written``, ``updated``, ``unchanged``, ``skipped-development``,
    ``failed``.
    """
    if getattr(resolution, "source", "") != "pinned":
        # A development override belongs to a shell, not to a user's config.
        return "skipped-development"
    try:
        config = (loader or _default_loader)()
        servers = config.get("mcp_servers")
        if not isinstance(servers, dict):
            servers = {}
        existing = servers.get(SERVER_KEY)
        wanted = desired_entry(resolution, home)
        if existing == wanted:
            return "unchanged"
        action = "updated" if isinstance(existing, dict) else "written"
        servers[SERVER_KEY] = wanted
        config["mcp_servers"] = servers
        (saver or _default_saver)(config)
        return action
    except Exception as exc:
        # A host that will not accept the registration is a doctor finding, not
        # a broken session: capture and pickup run through the adapter's own
        # client and do not depend on this key.
        logger.debug("jinn: could not register the corpus tools: %s", exc)
        return "failed"

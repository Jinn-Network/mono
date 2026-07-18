#!/usr/bin/env python3
"""Run a finite Hermes CLI command with synchronous top-level delegation."""

from __future__ import annotations

import os


def main() -> None:
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(
        source="jinn-autopilot",
        cwd=os.getcwd(),
        async_delivery=False,
    )
    try:
        from hermes_cli.main import main as hermes_main

        hermes_main()
    finally:
        clear_session_vars(tokens)


if __name__ == "__main__":
    main()

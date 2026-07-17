"""Test-sandbox enforcement for the jinn plugin's on-disk store dirs.

The jinn plugin persists session/layer state under ``~/.jinn-client/*``. A
test that exercises those code paths without redirecting the store env vars
writes into the developer's real store — leaking fixture pollution that
corrupts later runs and, on CI, is invisible until it bites.

This mirrors the ``HERMES_HOME`` handling in ``tests/conftest.py``: the
``_hermetic_environment`` fixture (step 6) points the three store env vars
at a per-test tempdir, and this guard fails loud if any resolved path
escapes back to the real ``~/.jinn-client`` tree.

The store env vars and their resolvers (see Jinn-Network/mono#1841):
  JINN_LAYER_CAPTURES_DIR  -> distill.captures_dir()
  JINN_LAYER_EPISODES_DIR  -> distill.episodes_dir()
  JINN_MINEABLE_STATE_DIR  -> session_bridge.contribution_state_dir()
"""

from __future__ import annotations

from pathlib import Path

from plugins.jinn import distill, session_bridge

# (env var, resolver) — used by the guard and its own test.
JINN_STORE_RESOLVERS = (
    ("JINN_LAYER_CAPTURES_DIR", distill.captures_dir),
    ("JINN_LAYER_EPISODES_DIR", distill.episodes_dir),
    ("JINN_MINEABLE_STATE_DIR", session_bridge.contribution_state_dir),
)


def assert_jinn_store_sandboxed() -> None:
    """Raise AssertionError if any jinn store resolver points at the real tree.

    Resolves each store dir the way production code does and checks it is not
    inside ``~/.jinn-client``. The error names the offending env var so the
    fix (redirect it to a tempdir) is obvious.
    """
    real_root = (Path.home() / ".jinn-client").resolve()
    for env_var, resolver in JINN_STORE_RESOLVERS:
        resolved = Path(resolver()).expanduser().resolve()
        if resolved == real_root or real_root in resolved.parents:
            raise AssertionError(
                f"jinn store guard: {resolver.__module__}.{resolver.__name__}() "
                f"resolved to {resolved}, which is inside the real store root "
                f"{real_root}. Set ${env_var} to a per-test tempdir (the "
                f"_hermetic_environment fixture does this) so the suite never "
                f"writes to the default store paths."
            )

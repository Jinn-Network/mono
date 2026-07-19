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

from functools import wraps
from pathlib import Path
from typing import Callable

from plugins.jinn import distill, session_bridge

# (env var, resolver) — used by the guard and its own test.
JINN_STORE_RESOLVERS = (
    ("JINN_LAYER_CAPTURES_DIR", distill.captures_dir),
    ("JINN_LAYER_EPISODES_DIR", distill.episodes_dir),
    ("JINN_MINEABLE_STATE_DIR", session_bridge.contribution_state_dir),
)


def _assert_resolved_store_sandboxed(
    env_var: str,
    resolver: Callable[[], Path],
    resolved: Path,
) -> None:
    real_root = (Path.home() / ".jinn-client").resolve()
    resolved = Path(resolved).expanduser().resolve()
    if resolved == real_root or real_root in resolved.parents:
        raise AssertionError(
            f"jinn store guard: {resolver.__module__}.{resolver.__name__}() "
            f"resolved to {resolved}, which is inside the real store root "
            f"{real_root}. Set ${env_var} to a per-test tempdir (the "
            f"_hermetic_environment fixture does this) so the suite never "
            f"writes to the default store paths."
        )


def assert_jinn_store_sandboxed() -> None:
    """Raise AssertionError if any jinn store resolver points at the real tree.

    Resolves each store dir the way production code does and checks it is not
    inside ``~/.jinn-client``. The error names the offending env var so the
    fix (redirect it to a tempdir) is obvious.
    """
    for env_var, resolver in JINN_STORE_RESOLVERS:
        _assert_resolved_store_sandboxed(env_var, resolver, resolver())


def install_jinn_store_resolver_guards(monkeypatch) -> None:
    """Guard every production resolver call, including transient escapes."""
    for env_var, resolver in JINN_STORE_RESOLVERS:
        module = distill if resolver.__module__ == distill.__name__ else session_bridge

        @wraps(resolver)
        def guarded(
            *args,
            _env_var=env_var,
            _resolver=resolver,
            **kwargs,
        ):
            resolved = _resolver(*args, **kwargs)
            _assert_resolved_store_sandboxed(_env_var, _resolver, resolved)
            return resolved

        monkeypatch.setattr(module, resolver.__name__, guarded)

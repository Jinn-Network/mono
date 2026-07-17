"""Verification tests for the jinn store-path sandbox guard (mono#1841).

These prove the lint/guard behaviour:
  * with the autouse ``_hermetic_environment`` fixture active, the three store
    resolvers point under the per-test tempdir and the guard stays green;
  * a deliberate violation (unsetting a store env var so the resolver returns
    the real default) makes the guard go red.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.support.jinn_store import assert_jinn_store_sandboxed
from plugins.jinn import distill, session_bridge


def test_guard_green_when_sandboxed():
    # The autouse _hermetic_environment fixture has redirected all three vars.
    assert_jinn_store_sandboxed()

    real_root = (Path.home() / ".jinn-client").resolve()
    for resolved in (
        distill.captures_dir(),
        distill.episodes_dir(),
        session_bridge.contribution_state_dir(),
    ):
        resolved = Path(resolved).resolve()
        assert real_root not in resolved.parents and resolved != real_root


@pytest.mark.jinn_store_guard_bypass
def test_guard_red_on_deliberate_violation(monkeypatch):
    # Unset one store var so its resolver falls back to the real default.
    monkeypatch.delenv("JINN_LAYER_EPISODES_DIR", raising=False)

    with pytest.raises(AssertionError, match="JINN_LAYER_EPISODES_DIR"):
        assert_jinn_store_sandboxed()

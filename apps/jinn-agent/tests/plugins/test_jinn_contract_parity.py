"""Cross-language contract-constant parity tests (Jinn-Network/mono#1822).

Python and TypeScript each declare the process-contract literals
independently: ``CONTRACT_VERSION`` and the inline status guard tuple here in
``plugins/jinn/jinn_layer.py``, ``JINN_PLUGIN_CONTRACT_VERSION`` in
``packages/plugin/src/plugin.ts``, and the ``ProcessStatus`` union in
``client/packages/harness-layer/src/process-contract.ts``. These tests read
the other language's source as text and regex-extract the literal, so a
one-sided bump fails naming the divergent constant. A regex that matches
nothing is itself a loud failure (declaration moved).
"""

from __future__ import annotations

import re
from pathlib import Path

from plugins.jinn import jinn_layer

_REPO_ROOT = Path(__file__).resolve().parents[4]
_TS_PLUGIN = _REPO_ROOT / "packages" / "plugin" / "src" / "plugin.ts"
_TS_PROCESS_CONTRACT = (
    _REPO_ROOT / "client" / "packages" / "harness-layer" / "src" / "process-contract.ts"
)
_PY_JINN_LAYER = Path(jinn_layer.__file__).resolve()


def test_contract_version_matches_ts():
    source = _TS_PLUGIN.read_text()
    match = re.search(
        r"^export const JINN_PLUGIN_CONTRACT_VERSION\s*=\s*(\d+)\s+as const",
        source,
        re.MULTILINE,
    )
    assert match, (
        f"could not locate JINN_PLUGIN_CONTRACT_VERSION in {_TS_PLUGIN} — "
        "declaration moved?"
    )
    ts_version = int(match.group(1))
    assert jinn_layer.CONTRACT_VERSION == ts_version, (
        f"contract version diverged: Python CONTRACT_VERSION="
        f"{jinn_layer.CONTRACT_VERSION} ({_PY_JINN_LAYER}) != "
        f"TS JINN_PLUGIN_CONTRACT_VERSION={ts_version} ({_TS_PLUGIN})"
    )


def test_process_status_set_matches_ts():
    py_source = _PY_JINN_LAYER.read_text()
    py_match = re.search(r'parsed\.get\("status"\) not in \(([^)]+)\)', py_source)
    assert py_match, (
        f"could not locate the status guard tuple in {_PY_JINN_LAYER} — "
        "declaration moved?"
    )
    py_statuses = set(re.findall(r'"([^"]+)"', py_match.group(1)))
    assert py_statuses, (
        f"extracted zero statuses from the guard tuple in {_PY_JINN_LAYER} — "
        "quote style changed?"
    )

    ts_source = _TS_PROCESS_CONTRACT.read_text()
    ts_match = re.search(r"export type ProcessStatus\s*=\s*([^;]+);", ts_source)
    assert ts_match, (
        f"could not locate the ProcessStatus union in {_TS_PROCESS_CONTRACT} — "
        "declaration moved?"
    )
    ts_statuses = set(re.findall(r"'([^']+)'", ts_match.group(1)))
    assert ts_statuses, (
        f"extracted zero statuses from the ProcessStatus union in "
        f"{_TS_PROCESS_CONTRACT} — quote style changed?"
    )

    assert py_statuses == ts_statuses, (
        f"process-status set diverged: Python {sorted(py_statuses)} "
        f"({_PY_JINN_LAYER}) != TS ProcessStatus {sorted(ts_statuses)} "
        f"({_TS_PROCESS_CONTRACT})"
    )

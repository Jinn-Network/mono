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

import pytest

from plugins.jinn import jinn_layer

_REPO_ROOT = Path(__file__).resolve().parents[4]
_TS_PLUGIN = _REPO_ROOT / "packages" / "plugin" / "src" / "plugin.ts"
_TS_PROCESS_CONTRACT = (
    _REPO_ROOT / "client" / "packages" / "harness-layer" / "src" / "process-contract.ts"
)
_PY_JINN_LAYER = Path(jinn_layer.__file__).resolve()


def _extract_python_statuses(source: str, source_path: Path) -> set[str]:
    matches = list(
        re.finditer(
            r'^[ \t]*if[ \t]+parsed\.get\("status"\)[ \t]+not[ \t]+in[ \t]+\(([^)]*)\)[ \t]*:',
            source,
            re.MULTILINE,
        )
    )
    assert matches, (
        f"could not locate the status guard tuple in {source_path} — declaration moved?"
    )
    assert len(matches) == 1, (
        f"expected exactly one status guard tuple in {source_path}, "
        f"found {len(matches)} declaration-shaped matches"
    )
    match = matches[0]
    body = match.group(1)
    assert re.fullmatch(
        r'[ \t\r\n]*"[^"\r\n]+"(?:[ \t\r\n]*,[ \t\r\n]*"[^"\r\n]+")*'
        r"[ \t\r\n]*,?[ \t\r\n]*",
        body,
    ), f"unsupported syntax in status guard tuple in {source_path}: {body!r}"
    return set(re.findall(r'"([^"]+)"', body))


def _extract_ts_statuses(source: str, source_path: Path) -> set[str]:
    matches = list(
        re.finditer(
            r"^export[ \t]+type[ \t]+ProcessStatus[ \t]*=[ \t]*([^;]+);",
            source,
            re.MULTILINE,
        )
    )
    assert matches, (
        f"could not locate the ProcessStatus union in {source_path} — "
        "declaration moved?"
    )
    assert len(matches) == 1, (
        f"expected exactly one ProcessStatus union in {source_path}, "
        f"found {len(matches)} declaration-shaped matches"
    )
    match = matches[0]
    body = match.group(1)
    assert re.fullmatch(
        r"[ \t\r\n]*'[^'\r\n]+'(?:[ \t\r\n]*\|[ \t\r\n]*'[^'\r\n]+')*[ \t\r\n]*",
        body,
    ), f"unsupported syntax in ProcessStatus union in {source_path}: {body!r}"
    return set(re.findall(r"'([^']+)'", body))


def test_python_status_extraction_rejects_unrecognized_member():
    source_path = Path("fixture-jinn-layer.py")

    with pytest.raises(
        AssertionError, match=r"status guard tuple.*fixture-jinn-layer\.py"
    ):
        _extract_python_statuses(
            'if parsed.get("status") not in ("ok", EXTRA_STATUS):', source_path
        )


def test_ts_status_extraction_rejects_unrecognized_member():
    source_path = Path("fixture-process-contract.ts")

    with pytest.raises(
        AssertionError, match=r"ProcessStatus union.*fixture-process-contract\.ts"
    ):
        _extract_ts_statuses(
            "export type ProcessStatus = 'ok' | ExtraStatus;", source_path
        )


def test_python_status_extraction_rejects_docstring_decoy_before_live_guard():
    source_path = Path("fixture-jinn-layer.py")
    source = '''"""
if parsed.get("status") not in ("ok", "degraded", "unavailable"):
"""
if parsed.get("status") not in ("ok", EXTRA_STATUS):
'''

    with pytest.raises(
        AssertionError, match=r"status guard tuple.*fixture-jinn-layer\.py"
    ):
        _extract_python_statuses(source, source_path)


def test_ts_status_extraction_rejects_block_comment_decoy_before_live_union():
    source_path = Path("fixture-process-contract.ts")
    source = """/*
export type ProcessStatus = 'ok' | 'degraded' | 'unavailable';
*/
export type ProcessStatus = 'ok' | ExtraStatus;
"""

    with pytest.raises(
        AssertionError, match=r"ProcessStatus union.*fixture-process-contract\.ts"
    ):
        _extract_ts_statuses(source, source_path)


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
    py_statuses = _extract_python_statuses(py_source, _PY_JINN_LAYER)

    ts_source = _TS_PROCESS_CONTRACT.read_text()
    ts_statuses = _extract_ts_statuses(ts_source, _TS_PROCESS_CONTRACT)

    assert py_statuses == ts_statuses, (
        f"process-status set diverged: Python {sorted(py_statuses)} "
        f"({_PY_JINN_LAYER}) != TS ProcessStatus {sorted(ts_statuses)} "
        f"({_TS_PROCESS_CONTRACT})"
    )

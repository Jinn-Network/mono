"""Cross-language process-contract constant parity (Jinn-Network/mono#1822)."""

from __future__ import annotations

import json
from pathlib import Path

from plugins.jinn import jinn_layer

_REPO_ROOT = Path(__file__).resolve().parents[4]
_CONTRACT_PATH = _REPO_ROOT / "packages" / "plugin" / "process-contract.json"
_PYTHON_PATH = Path(jinn_layer.__file__).resolve()
_CONTRACT = json.loads(_CONTRACT_PATH.read_text())


def test_contract_version_matches_canonical_contract():
    assert jinn_layer.CONTRACT_VERSION == _CONTRACT["contractVersion"], (
        "CONTRACT_VERSION diverged: "
        f"Python={jinn_layer.CONTRACT_VERSION} ({_PYTHON_PATH}) != "
        f"canonical={_CONTRACT['contractVersion']} ({_CONTRACT_PATH})"
    )


def test_process_statuses_match_canonical_contract():
    python_statuses = sorted(jinn_layer.PROCESS_STATUSES)
    canonical_statuses = sorted(_CONTRACT["processStatuses"])

    assert python_statuses == canonical_statuses, (
        "PROCESS_STATUSES diverged: "
        f"Python={python_statuses} ({_PYTHON_PATH}) != "
        f"canonical={canonical_statuses} ({_CONTRACT_PATH})"
    )

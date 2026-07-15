"""Static contract for the blocking Stage 1 cold-stock product gate."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]
AGENT_ROOT = REPO_ROOT / "apps" / "jinn-agent"


def test_cold_stock_script_uses_built_products_and_both_lifecycle_drivers():
    script = (AGENT_ROOT / "scripts" / "cold-stock-e2e.sh").read_text(
        encoding="utf-8"
    )

    assert "9df5f879b4a5925c0f8f947e7e16ed8e845932c3" in script
    assert "pip wheel" in script
    assert "dist/bin/jinn-layer.js" in script
    assert "scripts/fixtures/jinn-layer-stub" not in script
    assert "stage1-stock-product.py" in script
    assert "stage1-task-creator-acceptance.mjs" in script


def test_stage1_gate_is_blocking_for_every_product_boundary():
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github" / "workflows" / "jinn-agent-ci.yml").read_text(
            encoding="utf-8"
        )
    )
    triggers = workflow[True]
    pull_request_paths = triggers["pull_request"]["paths"]
    gate = workflow["jobs"]["cold-stock-e2e"]

    assert "apps/jinn-agent/**" in pull_request_paths
    assert "packages/plugin/**" in pull_request_paths
    assert "client/packages/harness-layer/**" in pull_request_paths
    assert gate["name"] == "Cold-stock Stage 1 product gate"
    assert gate.get("continue-on-error") is not True
    assert "pull_request" in gate["if"]
    assert "push" in gate["if"]
    rendered_steps = "\n".join(
        str(step.get("run", "")) for step in gate["steps"]
    )
    assert "yarn build" in rendered_steps
    assert "packages/plugin" in rendered_steps
    assert "process-contract.test.ts" in rendered_steps
    assert "task-creator-session-echo.test.ts" in rendered_steps
    assert "cold-stock-e2e.sh" in rendered_steps


def test_acceptance_drivers_are_repo_owned_executables():
    python_driver = AGENT_ROOT / "scripts" / "stage1-stock-product.py"
    daemon_driver = REPO_ROOT / "client" / "scripts" / "stage1-task-creator-acceptance.mjs"

    assert python_driver.is_file()
    assert daemon_driver.is_file()

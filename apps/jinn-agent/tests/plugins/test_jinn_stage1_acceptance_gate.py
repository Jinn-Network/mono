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
    assert 'LAYER="$REPO_ROOT/packages/layer"' in script
    assert 'JINN_LAYER_BIN="$LAYER/dist/bin/jinn-layer.js"' in script
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
    assert "packages/core/**" in pull_request_paths
    assert "packages/layer/**" in pull_request_paths
    assert gate["name"] == "Cold-stock Stage 1 product gate"
    assert gate.get("continue-on-error") is not True
    assert "pull_request" in gate["if"]
    assert "push" in gate["if"]
    rendered_steps = "\n".join(
        f"{step.get('working-directory', '')} {step.get('run', '')}"
        for step in gate["steps"]
    )
    assert "packages/layer" in rendered_steps
    assert "yarn build" in rendered_steps
    assert "packages/plugin" in rendered_steps
    assert "contribution-store.test.ts" in rendered_steps
    assert "process-contract.test.ts" in rendered_steps
    assert "task-creator-session-echo.test.ts" in rendered_steps
    assert "cold-stock-e2e.sh" in rendered_steps


def test_cold_stock_package_steps_build_before_testing_built_exports():
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github" / "workflows" / "jinn-agent-ci.yml").read_text(
            encoding="utf-8"
        )
    )
    steps = workflow["jobs"]["cold-stock-e2e"]["steps"]
    test_commands = {
        "packages/plugin": "yarn test",
        "packages/core": "yarn vitest run test/contribution-store.test.ts",
        "packages/layer": (
            "yarn vitest run test/process-contract.test.ts "
            "test/contract-parity.test.ts"
        ),
    }

    for working_directory, test_command in test_commands.items():
        step = next(
            step
            for step in steps
            if step.get("working-directory") == working_directory
        )
        command = step["run"]

        assert command.index("yarn build") < command.index(test_command)


def test_jinn_agent_suite_includes_destructive_cleanup_regressions():
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github" / "workflows" / "jinn-agent-ci.yml").read_text(
            encoding="utf-8"
        )
    )
    test_steps = workflow["jobs"]["test"]["steps"]
    rendered_steps = "\n".join(
        str(step.get("run", "")) for step in test_steps
    )

    assert "tests/scripts/test_clean_jinn_test_pollution.py" in rendered_steps


def test_acceptance_drivers_are_repo_owned_executables():
    python_driver = AGENT_ROOT / "scripts" / "stage1-stock-product.py"
    daemon_driver = REPO_ROOT / "client" / "scripts" / "stage1-task-creator-acceptance.mjs"

    assert python_driver.is_file()
    assert daemon_driver.is_file()


def test_stock_fixture_acceptance_pins_content_rescore_near_miss():
    python_driver = (
        AGENT_ROOT / "scripts" / "stage1-stock-product.py"
    ).read_text(encoding="utf-8")

    assert "CONTENT_RESCORE_MESSAGE" in python_driver
    assert "apiMocks.getStatus" in python_driver
    assert 'session_id="stage1-content-rescore"' in python_driver
    assert "metadata score-1 source did not clear the floor after content re-score" in python_driver


def test_acceptance_drivers_enforce_stage2_parked_lifecycle():
    python_driver = (
        AGENT_ROOT / "scripts" / "stage1-stock-product.py"
    ).read_text(encoding="utf-8")
    daemon_driver = (
        REPO_ROOT / "client" / "scripts" / "stage1-task-creator-acceptance.mjs"
    ).read_text(encoding="utf-8")

    assert 'jinn._handle_jinn("preview")' not in python_driver
    assert "preview acknowledged" not in python_driver
    assert "expected_publication" not in python_driver
    assert "jinn.consent.save_state(True, previewed=True)" in python_driver
    assert '"publication ON" not in current' in python_driver
    assert "contribution: parked — nothing leaves this machine" in python_driver
    assert "publish: true" not in daemon_driver
    assert "publish: false" in daemon_driver
    assert "assert.equal(uploads.length, 0)" in daemon_driver

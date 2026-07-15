"""Finding A regression fence: the plugin must import + register on a stock
Hermes, whose hermes_cli.banner exposes only _RST (no fork _TC/_FB/probe)."""
import sys
import types
import importlib
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
COLD_STOCK = REPO_ROOT / "scripts" / "cold-stock-e2e.sh"
STOCK_DRIVER = REPO_ROOT / "scripts" / "stage1-stock-product.py"
PINNED_HERMES_SHA = "9df5f879b4a5925c0f8f947e7e16ed8e845932c3"


def test_plugin_imports_with_stock_banner(monkeypatch):
    # Simulate stock upstream banner: only _RST, nothing fork-added.
    stock_banner = types.ModuleType("hermes_cli.banner")
    stock_banner._RST = "\033[0m"
    monkeypatch.setitem(sys.modules, "hermes_cli.banner", stock_banner)

    # Force a fresh import of the plugin's style module under the stub.
    for mod in list(sys.modules):
        if mod.startswith("plugins.jinn.style") or mod.startswith("jinn_plugin.style"):
            monkeypatch.delitem(sys.modules, mod, raising=False)

    style = importlib.import_module("plugins.jinn.style")
    pal, rst = style.palette(truecolor=True)
    assert pal["sky"].startswith("\033[")  # a real ANSI code, vendored — no ImportError
    assert rst == "\033[0m"


def test_cold_stock_e2e_pins_upstream_and_checks_required_hooks_by_subset():
    script = COLD_STOCK.read_text(encoding="utf-8")
    driver = STOCK_DRIVER.read_text(encoding="utf-8")
    assert PINNED_HERMES_SHA in script
    assert "git clone --depth 1" not in script
    assert "stage1-stock-product.py" in script
    assert ".issubset(calls[\"hooks\"])" in driver
    assert "post_llm_call" in driver

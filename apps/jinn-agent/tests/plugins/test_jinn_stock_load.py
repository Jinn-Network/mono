"""Finding A regression fence: the plugin must import + register on a stock
Hermes, whose hermes_cli.banner exposes only _RST (no fork _TC/_FB/probe)."""
import sys
import types
import importlib


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

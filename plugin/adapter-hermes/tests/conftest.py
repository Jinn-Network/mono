"""Import the adapter directory as the package name it ships under.

Installed, this directory is ``~/.hermes/plugins/jinn`` and Hermes imports it
as ``jinn_plugin`` via the entry point. In the repository it is
``plugin/adapter-hermes``, so the tests bind the same name to the same code
rather than importing by a path-derived name the product never uses.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from _pytest import python as pytest_python

ADAPTER_DIR = Path(__file__).resolve().parent.parent
_INIT_PATH = ADAPTER_DIR / "__init__.py"


def _load_jinn_plugin():
    if "jinn_plugin" in sys.modules:
        return sys.modules["jinn_plugin"]
    spec = importlib.util.spec_from_file_location(
        "jinn_plugin",
        _INIT_PATH,
        submodule_search_locations=[str(ADAPTER_DIR)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["jinn_plugin"] = module
    spec.loader.exec_module(module)
    return module


_jinn_plugin = _load_jinn_plugin()
if _jinn_plugin.__spec__ is None:
    _jinn_plugin.__spec__ = importlib.util.spec_from_file_location(
        "jinn_plugin",
        _INIT_PATH,
        submodule_search_locations=[str(ADAPTER_DIR)],
    )

_original_importtestmodule = pytest_python.importtestmodule


def _importtestmodule(path, config):
    if Path(path).resolve() == _INIT_PATH.resolve():
        return _jinn_plugin
    return _original_importtestmodule(path, config)


pytest_python.importtestmodule = _importtestmodule

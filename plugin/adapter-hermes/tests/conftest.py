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

ADAPTER_DIR = Path(__file__).resolve().parent.parent

if "jinn_plugin" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "jinn_plugin",
        ADAPTER_DIR / "__init__.py",
        submodule_search_locations=[str(ADAPTER_DIR)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["jinn_plugin"] = module
    spec.loader.exec_module(module)

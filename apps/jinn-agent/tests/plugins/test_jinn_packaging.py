import tomllib
from pathlib import Path
import plugins.jinn as jinn_pkg

PYPROJECT = Path(__file__).resolve().parents[2] / "plugins" / "jinn" / "pyproject.toml"


def test_pyproject_declares_entry_point():
    data = tomllib.loads(PYPROJECT.read_text())
    eps = data["project"]["entry-points"]["hermes_agent.plugins"]
    assert eps["jinn"] == "jinn_plugin"
    assert "pyyaml" in " ".join(data["project"].get("dependencies", [])).lower()


def test_package_dir_maps_jinn_plugin_to_dot():
    data = tomllib.loads(PYPROJECT.read_text())
    assert data["tool"]["setuptools"]["package-dir"]["jinn_plugin"] == "."


def test_register_is_exposed():
    assert callable(getattr(jinn_pkg, "register", None))

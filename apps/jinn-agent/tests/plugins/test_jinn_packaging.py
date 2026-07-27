import re
import tomllib
from pathlib import Path

import plugins.jinn as jinn_pkg

PYPROJECT = Path(__file__).resolve().parents[2] / "plugins" / "jinn" / "pyproject.toml"
APP_ROOT = Path(__file__).resolve().parents[2]
PRODUCT_SURFACES = (
    APP_ROOT / "README.md",
    APP_ROOT / "JINN.md",
    APP_ROOT / "plugins" / "jinn" / "README.md",
    PYPROJECT,
)


def test_pyproject_declares_entry_point():
    data = tomllib.loads(PYPROJECT.read_text())
    eps = data["project"]["entry-points"]["hermes_agent.plugins"]
    assert eps["jinn"] == "jinn_plugin"
    assert "pyyaml" in " ".join(data["project"].get("dependencies", [])).lower()


def test_package_dir_maps_jinn_plugin_to_dot():
    data = tomllib.loads(PYPROJECT.read_text())
    assert data["tool"]["setuptools"]["package-dir"]["jinn_plugin"] == "."
    package_data = data["tool"]["setuptools"]["package-data"]["jinn_plugin"]
    assert "layer-runtime.json" in package_data


def test_register_is_exposed():
    assert callable(getattr(jinn_pkg, "register", None))


def test_installable_product_docs_describe_parked_stage2_not_deleted_stage1_surface():
    text_by_path = {
        path: path.read_text(encoding="utf-8")
        for path in PRODUCT_SURFACES
    }
    combined = "\n".join(text_by_path.values())
    stale_patterns = (
        r"/jinn consent\b",
        r"/jinn preview\b",
        r"/jinn ledger\b",
        r"/jinn skills install\b",
        r"\bjinn-agent onboarding\b",
        r"@jinn-network/client@canary",
        r"npm install -g @jinn-network/client",
        r"consent-gated contribution",
        r"publish(?:es|ed|ing)? automatically",
        r"automatically publish(?:es|ed|ing)?",
    )
    for pattern in stale_patterns:
        assert re.search(pattern, combined, re.IGNORECASE) is None, pattern

    for path in (APP_ROOT / "README.md", APP_ROOT / "JINN.md"):
        text = text_by_path[path].lower()
        assert "contribution" in text
        assert "parked" in text
        assert "nothing leaves this machine" in text

    description = tomllib.loads(text_by_path[PYPROJECT])["project"]["description"].lower()
    assert "parked" in description
    assert "local" in description

    plugin_readme = text_by_path[APP_ROOT / "plugins" / "jinn" / "README.md"]
    assert (
        "**No separate search. No slash commands. Just use Hermes normally.**"
        in plugin_readme
    )
    assert "How should a Jinn evaluator handle Docker failures?" in plugin_readme
    assert "JINN.md" not in plugin_readme

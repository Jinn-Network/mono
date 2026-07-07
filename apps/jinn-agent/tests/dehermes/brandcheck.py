import os, re, subprocess, sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]          # apps/jinn-agent/
_BIN = _REPO / "bin" / "jinn-agent"
# Technical tokens that are NOT branding and are allowed on screen:
_TECHNICAL = re.compile(r"HERMES_[A-Z0-9_]+|\.hermes\b|hermes_[a-z0-9_]+")
_BRAND_WORDS = ("hermes", "nous")

def strip_technical(text: str) -> str:
    return _TECHNICAL.sub("", text)

def assert_no_upstream_brand(text: str) -> None:
    cleaned = strip_technical(text).lower()
    for w in _BRAND_WORDS:
        i = cleaned.find(w)
        assert i == -1, f"upstream brand {w!r} leaked: ...{cleaned[max(0,i-40):i+40]!r}..."

def run_cli(*args: str, home: str) -> str:
    env = {**os.environ, "HERMES_HOME": home}
    env.pop("JINN_AGENT_HOME", None)
    p = subprocess.run([str(_BIN), *args], env=env, capture_output=True, text=True, timeout=120)
    return p.stdout + p.stderr

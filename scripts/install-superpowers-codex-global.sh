#!/usr/bin/env bash
# Install obra/superpowers for Codex globally on this machine.
# - Registers the obra/superpowers marketplace (if missing)
# - Enables the superpowers plugin in ~/.codex/config.toml
# - Symlinks skills into ~/.codex/skills/superpowers
# - Enables multi_agent (required for subagent skills)
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="${CODEX_HOME}/config.toml"
SKILLS_LINK="${CODEX_HOME}/skills/superpowers"
MARKETPLACE_NAME="superpowers-dev"
PLUGIN_KEY="superpowers@${MARKETPLACE_NAME}"

if ! rg -q "\\[marketplaces\\.${MARKETPLACE_NAME}\\]" "${CONFIG}" 2>/dev/null; then
  echo "Adding marketplace obra/superpowers ..."
  codex plugin marketplace add obra/superpowers
fi

MARKETPLACE_ROOT="${CODEX_HOME}/.tmp/marketplaces/${MARKETPLACE_NAME}"
SKILLS_SRC="${MARKETPLACE_ROOT}/skills"
if [[ ! -d "${SKILLS_SRC}" ]]; then
  echo "error: expected skills at ${SKILLS_SRC} after marketplace add" >&2
  exit 1
fi

mkdir -p "${CODEX_HOME}/skills"
if [[ -L "${SKILLS_LINK}" ]]; then
  rm "${SKILLS_LINK}"
elif [[ -e "${SKILLS_LINK}" ]]; then
  echo "error: ${SKILLS_LINK} exists and is not a symlink" >&2
  exit 1
fi
ln -s "${SKILLS_SRC}" "${SKILLS_LINK}"
echo "Linked ${SKILLS_LINK} -> ${SKILLS_SRC}"

python3 - "${CONFIG}" "${PLUGIN_KEY}" <<'PY'
import re
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
plugin_key = sys.argv[2]
text = config_path.read_text() if config_path.exists() else ""

plugin_section = f'[plugins."{plugin_key}"]\nenabled = true\n'
if f'[plugins."{plugin_key}"]' not in text:
    if '[plugins.' in text:
        matches = list(re.finditer(r'^\[plugins\.[^\]]+\][^\[]*', text, re.M | re.S))
        insert_at = matches[-1].end() if matches else len(text)
        text = text[:insert_at] + "\n" + plugin_section + text[insert_at:]
    else:
        text += "\n" + plugin_section

if not re.search(r'^\[features\]', text, re.M):
    text += "\n[features]\n"
if not re.search(r'^multi_agent\s*=', text, re.M):
    text = re.sub(
        r'(\[features\]\s*\n)',
        r'\1multi_agent = true\n',
        text,
        count=1,
    )

config_path.write_text(text)
print(f"Updated {config_path}: enabled {plugin_key}, multi_agent = true")
PY

echo ""
echo "Done. Restart Codex (CLI or app) to load Superpowers."

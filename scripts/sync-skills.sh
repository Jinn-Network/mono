#!/usr/bin/env bash
# Symlink repo skills into Claude Code, Cursor, and Codex skill directories.
# Canonical source: .claude/skills/<name>/ (tracked in git per .gitignore).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANON="${ROOT}/.claude/skills"
TARGETS=(
  "${ROOT}/.claude/skills"
  "${ROOT}/.cursor/skills"
  "${ROOT}/.codex/skills"
)

if [[ ! -d "${CANON}" ]]; then
  echo "error: canonical skills dir missing: ${CANON}" >&2
  exit 1
fi

link_skill() {
  local name="$1"
  local target_dir="$2"
  local link="${target_dir}/${name}"

  mkdir -p "${target_dir}"

  if [[ "${target_dir}" == "${CANON}" ]]; then
    if [[ -L "${link}" ]]; then
      rm "${link}"
    fi
    return 0
  fi

  local rel="../../.claude/skills/${name}"
  if [[ -L "${link}" ]]; then
    local current
    current="$(readlink "${link}")"
    if [[ "${current}" == "${rel}" ]]; then
      return 0
    fi
    rm "${link}"
  elif [[ -e "${link}" ]]; then
    echo "error: ${link} exists and is not a symlink — remove or relocate manually" >&2
    exit 1
  fi

  ln -s "${rel}" "${link}"
}

for target in "${TARGETS[@]}"; do
  mkdir -p "${target}"
done

shopt -s nullglob
for skill_dir in "${CANON}"/*/; do
  name="$(basename "${skill_dir}")"
  if [[ ! -f "${skill_dir}/SKILL.md" ]]; then
    echo "warn: skipping ${name} (no SKILL.md)" >&2
    continue
  fi
  for target in "${TARGETS[@]}"; do
    link_skill "${name}" "${target}"
  done
done

echo "Synced skills from ${CANON} into:"
printf '  %s\n' "${TARGETS[@]}"

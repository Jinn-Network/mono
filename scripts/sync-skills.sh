#!/usr/bin/env bash
# Generated, pruning, idempotent skill mirror.
#
# Canonical source (edit only here): .claude/skills/<name>/SKILL.md
# Generated mirrors (do not edit; CI runs --check):
#   .agents/skills/  — Agent Skills standard (Codex, Gemini, Cursor)
#   .cursor/skills/  — Cursor native project discovery (still documented)
#   .codex/skills/   — compatibility path (Cursor still scans it)
#
# Discovery verified 2026-08-24:
#   Codex repo skills: .agents/skills (cwd → repo root), not .codex/skills
#     https://developers.openai.com/codex/skills
#   Cursor project skills: .agents/skills and .cursor/skills; also loads
#     .claude/skills and .codex/skills for compatibility
#     https://cursor.com/docs/skills
#
# Usage:
#   ./scripts/sync-skills.sh          # write mirrors
#   ./scripts/sync-skills.sh --check  # exit 1 on drift, write nothing
#
# SYNC_SKILLS_ROOT overrides the repo root (tests only).
set -euo pipefail

usage() {
  echo "usage: $0 [--check]" >&2
  exit 2
}

CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
  shift
fi
if [[ $# -gt 0 ]]; then
  usage
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${SYNC_SKILLS_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
CANON="${ROOT}/.claude/skills"
REL_FROM_MIRROR="../../.claude/skills"

# Non-authoritative generated trees only. Never treat .claude/skills as a target.
MIRRORS=(
  "${ROOT}/.agents/skills"
  "${ROOT}/.cursor/skills"
  "${ROOT}/.codex/skills"
)

if [[ ! -d "${CANON}" ]]; then
  echo "error: canonical skills dir missing: ${CANON}" >&2
  exit 1
fi

is_canonical() {
  local needle="$1"
  local skill
  for skill in "${SKILLS[@]+"${SKILLS[@]}"}"; do
    if [[ "${skill}" == "${needle}" ]]; then
      return 0
    fi
  done
  return 1
}

# Directories under .claude/skills that contain SKILL.md. README.md and
# leftover folders without SKILL.md are not skills.
SKILLS=()
shopt -s nullglob
for skill_dir in "${CANON}"/*/; do
  name="$(basename "${skill_dir}")"
  if [[ -f "${skill_dir}/SKILL.md" ]]; then
    SKILLS+=("${name}")
  fi
done
shopt -u nullglob

# Stable order so --check output is deterministic.
if [[ ${#SKILLS[@]} -gt 0 ]]; then
  IFS=$'\n' SKILLS=($(printf '%s\n' "${SKILLS[@]}" | LC_ALL=C sort))
  unset IFS
fi

DRIFT=0

report_drift() {
  echo "drift: $1" >&2
  DRIFT=1
}

mirror_entries() {
  local target_dir="$1"
  local entry
  shopt -s nullglob
  for entry in "${target_dir}"/*; do
    printf '%s\n' "$(basename "${entry}")"
  done
  shopt -u nullglob
}

ensure_link() {
  local name="$1"
  local target_dir="$2"
  local link="${target_dir}/${name}"
  local rel="${REL_FROM_MIRROR}/${name}"

  if [[ "${CHECK}" -eq 1 ]]; then
    if [[ ! -e "${link}" && ! -L "${link}" ]]; then
      report_drift "missing ${link}"
      return 0
    fi
    if [[ ! -L "${link}" ]]; then
      report_drift "${link} is not a symlink"
      return 0
    fi
    current="$(readlink "${link}")"
    if [[ "${current}" != "${rel}" ]]; then
      report_drift "${link} -> ${current} (want ${rel})"
    fi
    return 0
  fi

  mkdir -p "${target_dir}"
  if [[ -L "${link}" ]]; then
    current="$(readlink "${link}")"
    if [[ "${current}" == "${rel}" ]]; then
      return 0
    fi
    rm "${link}"
  elif [[ -e "${link}" ]]; then
    rm -rf "${link}"
  fi
  ln -s "${rel}" "${link}"
}

prune_stale() {
  local target_dir="$1"
  local name

  if [[ ! -d "${target_dir}" ]]; then
    if [[ "${CHECK}" -eq 1 ]]; then
      report_drift "missing directory ${target_dir}"
    fi
    return 0
  fi

  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    if is_canonical "${name}"; then
      continue
    fi
    if [[ "${CHECK}" -eq 1 ]]; then
      report_drift "extra ${target_dir}/${name}"
    else
      rm -rf "${target_dir:?}/${name}"
    fi
  done < <(mirror_entries "${target_dir}")
}

for target in "${MIRRORS[@]}"; do
  if [[ "${CHECK}" -eq 0 ]]; then
    mkdir -p "${target}"
  elif [[ ! -d "${target}" ]]; then
    report_drift "missing directory ${target}"
    continue
  fi

  for name in "${SKILLS[@]+"${SKILLS[@]}"}"; do
    ensure_link "${name}" "${target}"
  done
  prune_stale "${target}"
done

if [[ "${CHECK}" -eq 1 ]]; then
  if [[ "${DRIFT}" -ne 0 ]]; then
    echo "skill mirror drifted; run ./scripts/sync-skills.sh and commit the generated trees" >&2
    exit 1
  fi
  echo "Skill mirrors match ${CANON}"
  printf '  %s\n' "${MIRRORS[@]}"
  exit 0
fi

echo "Synced skills from ${CANON} into:"
printf '  %s\n' "${MIRRORS[@]}"

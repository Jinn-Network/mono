"""/jinn skills — install corpus-published skills into Hermes's native skills.

Closes the seed-consumption loop (mono #1345): a skill published to the
corpus as a trace envelope becomes a locally installed Hermes skill —
``jinn-layer corpus get <ref>`` → sha256 verification → extract the
envelope's ``skill.md`` step attribute → write
``$HERMES_HOME/skills/<slug>/SKILL.md`` — and Hermes's native loader takes
over from there.

Consuming is ALWAYS allowed: no consent state is consulted anywhere in this
module. Consent gates contributing (capture/publish), never reading.

Every install writes a ``.jinn-ref`` marker (the corpus ref) next to the
SKILL.md; ``uninstall`` refuses to touch a skill directory without the
marker, so a user's own skills can never be deleted through this surface.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import jinn_layer
from .consent import get_hermes_home

logger = logging.getLogger(__name__)

TRACE_ENVELOPE_ARTIFACT_TYPE = "jinn.trace-envelope.v0"
MARKER_FILE = ".jinn-ref"

_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def skills_dir() -> Path:
    return get_hermes_home() / "skills"


def _sanitise_slug(raw: str) -> str:
    """Directory-safe slug: no separators, no traversal, non-empty."""
    slug = _SLUG_RE.sub("-", raw.strip()).strip(".-")
    if not slug:
        raise ValueError(f"cannot derive a usable skill slug from {raw!r}")
    return slug[:80]


# RESIDUAL (flagged cross-repo, 2026-07-08 design): these read-only envelope
# helpers still serve corpus_fetch + pickup classification for DISPLAY. They no
# longer gate any install write (install() defers to the layer). Fully removing
# them needs an interpreted `jinn-layer corpus get` projection — a harness-layer
# follow-up, tracked separately.
def _extract_trace(record: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
    """Return (trace envelope, verified sha256) from a corpus-get record.

    Verifies the artifact bytes against the record's sha256 BEFORE parsing —
    a mismatch refuses the install outright.
    """
    artifacts = record.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("corpus record has no artifacts")
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        if artifact.get("artifactType") != TRACE_ENVELOPE_ARTIFACT_TYPE:
            continue
        content_b64 = artifact.get("contentBase64")
        expected = str(artifact.get("sha256") or "")
        if not isinstance(content_b64, str) or not expected:
            raise ValueError("trace artifact is missing content or sha256")
        content = base64.b64decode(content_b64)
        actual = hashlib.sha256(content).hexdigest()
        if actual != expected:
            raise ValueError(
                f"sha256 mismatch — refusing to install (expected {expected[:12]}…, got {actual[:12]}…)"
            )
        return json.loads(content.decode("utf-8")), expected
    raise ValueError(f"no {TRACE_ENVELOPE_ARTIFACT_TYPE} artifact in this record")


def _skill_md_and_slug(trace: Dict[str, Any], ref: str) -> Tuple[str, str]:
    steps = trace.get("steps")
    if not isinstance(steps, list):
        raise ValueError("trace envelope has no steps")
    for step in steps:
        if not isinstance(step, dict):
            continue
        attrs = step.get("attributes")
        if not isinstance(attrs, dict):
            continue
        skill_md = attrs.get("skill.md")
        if not isinstance(skill_md, str) or not skill_md.strip():
            continue
        attribution = attrs.get("seed.attribution")
        raw_slug: Optional[str] = None
        if isinstance(attribution, dict) and isinstance(attribution.get("skill"), str):
            raw_slug = str(attribution["skill"]).split("/")[-1]
        if raw_slug is None:
            tags = (trace.get("task") or {}).get("distributionTags")
            if isinstance(tags, list):
                candidates = [t for t in tags if isinstance(t, str) and t not in ("seed-import",)]
                raw_slug = candidates[-1] if candidates else None
        return skill_md, _sanitise_slug(raw_slug or ref)
    raise ValueError("no skill.md content in this envelope — not an installable skill record")


def install(ref: str, runner: Optional[jinn_layer.Runner] = None) -> str:
    """Install a corpus-published skill by ref via `jinn-layer skills install`.

    The layer extracts, sha256-verifies, and writes SKILL.md (+ companions) into
    the skills dir; this function only chooses the dir and drops the .jinn-ref
    fence. No envelope parsing or hash verification happens here — that is the
    layer's job (thin-fork boundary, mono #1345 / distillation-v1 §9).
    """
    skills_root = skills_dir()
    skills_root.mkdir(parents=True, exist_ok=True)
    code, out = jinn_layer.run(
        ["skills", "install", ref, "--json"], runner, cwd=str(skills_root)
    )
    if code != 0:
        raise ValueError(f"skills install failed: {out}")
    try:
        result = json.loads(out)
        target = Path(result["dir"])
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError(f"unreadable skills install result: {exc}")
    (target / MARKER_FILE).write_text(
        json.dumps({"ref": ref}) + "\n", encoding="utf-8"
    )
    logger.info("jinn: installed skill %s from %s", target.name, ref)
    return str(target / "SKILL.md")


def list_installed() -> List[Dict[str, str]]:
    """Jinn-installed skills only (those carrying the .jinn-ref marker)."""
    directory = skills_dir()
    if not directory.exists():
        return []
    out: List[Dict[str, str]] = []
    for child in sorted(directory.iterdir()):
        marker = child / MARKER_FILE
        if not (child.is_dir() and marker.exists() and (child / "SKILL.md").exists()):
            continue
        try:
            ref = str(json.loads(marker.read_text(encoding="utf-8")).get("ref", ""))
        except Exception:
            ref = ""
        out.append({"slug": child.name, "ref": ref})
    return out


def uninstall(slug: str) -> str:
    """Remove a jinn-installed skill. Refuses anything without the marker."""
    target = skills_dir() / _sanitise_slug(slug)
    if not target.is_dir():
        raise ValueError(f"no installed skill named {slug!r}")
    if not (target / MARKER_FILE).exists():
        raise ValueError(
            f"{slug!r} was not installed by jinn (no {MARKER_FILE} marker) — refusing to remove it"
        )
    shutil.rmtree(target)
    logger.info("jinn: uninstalled skill %s", slug)
    return str(target)

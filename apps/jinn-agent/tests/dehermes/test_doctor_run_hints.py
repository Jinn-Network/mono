"""Source-level pin: doctor.py must never tell users to run ``hermes <cmd>``.

Doctor's remediation hints ("run 'hermes setup'", "run: hermes memory
setup", "`hermes doctor --ack <id>`") only render when the corresponding
issue fires — stale config, missing API keys, corrupt state.db, broken
symlink — so a clean CI environment never reaches most of them and the
runtime acceptance gate stays green while the strings leak.
test_command_installation.py closes this deterministically for the symlink
branches; this test pins *every* run-hint in the file at the source level,
so no environment-gated branch can reintroduce the wrong binary name.

Pattern notes, verified against the pre-fix file (``1672d13e2^``, 24 hits;
current file, 0 hits):

- quoted invocations (``'hermes setup'``, ``"hermes update"``) and the
  ``run: hermes <cmd>`` colon form cover the issues.append/check_warn hints;
- the backtick form excludes RST double-backticks (````hermes doctor````
  in docstrings is prose, not a rendered hint) via the ``(?<!`)`` guard;
- comment lines are skipped — comments legitimately name upstream commands
  (issue references, upstream-behaviour notes);
- flag-only forms (``"hermes -p"`` content sniffing, ``hermes --version``
  prose) don't match because the patterns require ``hermes <lowercase>``;
- on-disk path truth (``~/.local/bin/hermes``, ``venv/bin/hermes``) doesn't
  match because the character before ``hermes`` is ``/``.
"""
import re
from pathlib import Path

_DOCTOR = Path(__file__).resolve().parents[2] / "hermes_cli" / "doctor.py"

_RUN_HINT_PATTERNS = (
    r"'hermes [a-z]",        # "run 'hermes setup'"
    r'"hermes [a-z]',        # "hermes update wiped ..." rendered prose
    r"run: hermes\b",        # check_warn("...", "run: hermes memory setup")
    r"(?<!`)`hermes [a-z]",  # "`hermes doctor --ack <id>`" (single backtick)
)


def test_doctor_source_has_no_hermes_run_hints():
    hits = []
    for lineno, line in enumerate(_DOCTOR.read_text().splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        for pattern in _RUN_HINT_PATTERNS:
            if re.search(pattern, line):
                hits.append(f"doctor.py:{lineno}: {line.strip()[:100]}")
    assert not hits, (
        "doctor.py remediation strings must say 'jinn-agent', not 'hermes' "
        "(the hermes binary resolves to a stock upstream install):\n"
        + "\n".join(hits)
    )

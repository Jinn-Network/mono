import os, re, subprocess
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]          # apps/jinn-agent/
_BIN = _REPO / "bin" / "jinn-agent"

# ``hermes-*`` toolset registry keys (hermes_cli/platforms.py:40 default_toolset
# values; static bundle definition in toolsets.py). These are technical
# identifiers, not branding: users type them verbatim in `-s <toolset>` flags
# and reference them in config files. Renaming them is tracked separately
# from CLI brand copy (Task 10 controller ruling) — listed explicitly (NOT a
# broad `hermes-[a-z-]+` pattern) so this exemption can never accidentally
# swallow the brand string "hermes-agent", which is not itself a toolset key.
_TOOLSET_KEYS = (
    "hermes-acp", "hermes-api-server", "hermes-bluebubbles", "hermes-cli",
    "hermes-cron", "hermes-dingtalk", "hermes-discord", "hermes-email",
    "hermes-feishu", "hermes-gateway", "hermes-homeassistant", "hermes-matrix",
    "hermes-mattermost", "hermes-qqbot", "hermes-signal", "hermes-slack",
    "hermes-sms", "hermes-telegram", "hermes-webhook", "hermes-wecom",
    "hermes-wecom-callback", "hermes-weixin", "hermes-whatsapp", "hermes-yuanbao",
)
_TOOLSET_KEY_PATTERN = "|".join(re.escape(k) for k in _TOOLSET_KEYS)

# Technical tokens that are NOT branding and are allowed on screen:
# (?:venv/|\.local/)?bin/hermes\b covers real on-disk paths — the venv entry
# point and ~/.local/bin symlink are genuinely named `hermes` (pip entry
# point / install.sh), which is filesystem truth, not a branding choice.
# hermes-backup- is the literal filename stem `backup --help` prints for
# ``~/hermes-backup-<timestamp>.zip`` — filesystem truth, not branding.
# argparse line-wraps long help text at whatever column it likes, and can
# split this filename right after the hyphen (``hermes-\n    backup-``), so
# the pattern tolerates optional whitespace (including a newline) there.
#
# Task 10 acceptance-gate residue (main-path sweep found these; each is a
# fact about real infrastructure/filenames/identifiers, not CLI cosmetics —
# see task-10-report.md's classification table for the full rationale):
#   - hermes-agent\.nousresearch\.com — live upstream docs domain (fallback,
#     secrets, kanban --help). Rewriting the string would 404 the link;
#     re-pointing docs is a separate, larger undertaking than this sweep.
#   - bare `hermes-agent` in a `pip install`/`uv pip install --upgrade`
#     invocation (proxy's aiohttp-missing message, config.py's update-banner
#     hint) — the real PyPI package name (pyproject.toml `name = "hermes-agent"`).
#     Renaming the string would tell users to install a package that doesn't
#     exist. Anchored to the pip-install context so it can't widen into a
#     general "hermes-agent" brand-string exemption.
#   - hermes\.service — legacy systemd unit filename `gateway migrate-legacy`
#     detects and removes; filesystem truth like bin/hermes above.
#   - hermes-gateway-<profile>.service — the current (non-legacy) per-profile
#     systemd/launchd unit name pattern that same command's help text
#     explicitly says it does NOT touch; also filesystem truth. argparse
#     line-wraps this one right after the hyphen too (`hermes-\ngateway-...`),
#     same tolerance as hermes-backup- above.
#   - hermes\.exe — real Windows executable name `update --force` checks for
#     (electron-builder output), filesystem truth.
#   - --hermes-root — the literal `--hermes-root` flag name (desktop/gui
#     --help); an existing script-facing flag, not prose. Anchored to the
#     `--` prefix (not bare `hermes-root`) so a stray bare mention would
#     still be flagged as branding rather than silently swallowed.
#   - nous-approved mcps — factual claim that Nous curates the bundled MCP
#     catalog (mcp catalog --help); a statement about who vetted the
#     content, not incidental branding.
#   - --nous / nous-internal storage / nous staff — debug.py's real
#     Nous-operated S3 bucket for private uploads and who can view it;
#     naming the operator of real infra, not incidental branding.
#   - bare `nous` as a --provider/auth choice value (logout, portal --help,
#     proxy start/gateway enroll's "nous or xai (default: nous)") — a
#     provider-id enum literal users type verbatim, like a toolset key.
#   - docs/hermes-kanban-v1-spec.pdf — a real repo-relative file path
#     (kanban --help points users at it); filesystem truth, not branding.
#   - anpicasso/hermes-plugin-chrome-profiles — a real third-party GitHub
#     repo name used as a `plugins install` shorthand example; renaming it
#     would point at a repo that doesn't exist. Also line-wraps right after
#     the hyphen (`hermes-plugin-\nchrome-profiles`), same tolerance as
#     hermes-backup- above.
# Word/hyphen-boundary anchor: `\b` alone treats `-` as a non-word
# character, so it sits on *both* sides of a hyphen and happily matches
# `hermes-cli` in the middle of `hermes-cli-extra` or `prefix-hermes-slack`
# — stripping just the real key and leaving `-extra` / `prefix-` behind,
# which then passes the brand check even though the surrounding text is
# not a real toolset key. (?<![\w-]) / (?![\w-]) instead require the
# character immediately outside the match to be neither a word char nor a
# hyphen, so adjacent-hyphen spillover is left in place and still flagged.
_TECHNICAL = re.compile(
    r"HERMES_[A-Z0-9_]+|\.hermes\b|hermes_[a-z0-9_]+|nous_[a-z0-9_]+"
    r"|(?:venv/|\.local/)?bin/hermes\b"
    r"|hermes-\s*backup-"
    r"|hermes-\s*agent\.nousresearch\.com"
    r"|(?:pip install(?:\s+--upgrade)?\s+'?)hermes-\s*agent(?=[\[\'\s]|$)"
    r"|hermes\.service\b"
    r"|hermes-\s*gateway-<profile>\.service\b"
    r"|hermes\.exe\b"
    r"|(?<![\w-])--hermes-root(?![\w-])"
    r"|(?i:nous-approved)\b"
    r"|(?i:nous-internal)\b"
    r"|(?i:nous staff)\b"
    r"|--nous\b"
    r"|\{nous,"
    r"|add nous --type"
    r"|nous or xai \(default: nous\)"
    r"|docs/hermes-\s*kanban-v1-spec\.pdf"
    r"|anpicasso/hermes-\s*plugin-\s*chrome-profiles"
    rf"|(?<![\w-])(?:{_TOOLSET_KEY_PATTERN})(?![\w-])"
)
# "nous" as a bare substring also matches inside ordinary English words that
# have nothing to do with the brand — e.g. "synchronous" (a real, legitimate
# flag name: `curator run --help`'s `--sync, --synchronous`). "hermes" has
# no such collision (checked against hermeneutics/hermetic/isotherms — none
# contain it), so only "nous" needs the letter-boundary guard: it must not
# be immediately preceded by a letter, which rules out "...chro-NOUS" while
# still catching "Nous Portal", "Nous Research", "-nous", start-of-string
# "nous", etc.
_BRAND_PATTERNS = {
    "hermes": re.compile(r"hermes"),
    "nous": re.compile(r"(?<![a-z])nous"),
}

def strip_technical(text: str) -> str:
    return _TECHNICAL.sub("", text)

def assert_no_upstream_brand(text: str) -> None:
    cleaned = strip_technical(text).lower()
    for w, pattern in _BRAND_PATTERNS.items():
        m = pattern.search(cleaned)
        assert m is None, f"upstream brand {w!r} leaked: ...{cleaned[max(0,m.start()-40):m.start()+40]!r}..."

def run_cli(*args: str, home: str) -> str:
    env = {**os.environ, "HERMES_HOME": home}
    env.pop("JINN_AGENT_HOME", None)
    p = subprocess.run([str(_BIN), *args], env=env, capture_output=True, text=True, timeout=120)
    return p.stdout + p.stderr

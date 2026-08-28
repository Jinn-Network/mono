"""Jinn for Hermes - the host adapter.

The adapter carries only what MCP structurally cannot: the host's hook API.
Hooks append to a session feed the runtime seals; the first turn injects a
projection the runtime built; the doctor merges local checks with the runtime's
own report. Everything else lives in the runtime, reached over MCP.

Two rules govern this module and are tested as such: no hook ever raises into
the host, and a broken runtime degrades the product to silence, never to a
broken session.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

from . import doctor
from . import feed as feed_module
from . import host_config
from . import mcp_client
from . import paths
from . import runtime_pin
from . import view

logger = logging.getLogger(__name__)

_FIRST_SESSION_MARKER = "first-session-done"
_SEAL_TIMEOUT_S = 60.0

#: A session start must not feel like a hang, so the whole observation shares one deadline
#: rather than giving each read its own: an unreachable repository costs the base state, not the
#: first turn. The capture proceeds without it rather than late.
_GIT_BUDGET_S = 2.0

#: scp-style `git@host:path`, where `:` separates the path — a port cannot appear.
_SCP_REMOTE = re.compile(r"\A(?P<user>[^@/]+)@(?P<host>[^:/]+):(?P<path>.+?)(?:\.git)?\Z")
#: An explicit URL, where `:NNNN` after the host is unambiguously a port, not a path segment.
_URL_REMOTE = re.compile(
    r"\A(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*)://"
    # `[^/]*` is greedy so the group backtracks to the LAST `@` before the host, which is where
    # RFC 3986 puts the boundary. Stopping at the first would leave a password fragment behind.
    r"(?:(?P<userinfo>[^/]*)@)?"
    r"(?P<host>[^/:]+)(?::(?P<port>\d+))?"
    r"(?P<path>/.*?)(?:\.git)?\Z"
)
_NETWORK_SCHEMES = ("https", "http", "git", "ssh")

_lock = threading.Lock()
_sessions: Dict[str, "_SessionState"] = {}
_FIRST_SESSION_RUN: Dict[str, bool] = {"value": False}


@dataclass
class _SessionState:
    client: Optional[Any] = None
    capture_session_id: Optional[str] = None
    feed: Optional[feed_module.SessionFeed] = None
    pickup_done: bool = False
    degraded: Optional[str] = None
    cwd: Optional[str] = None
    model: str = ""
    announced: bool = field(default=False)


def user_line(message: str) -> None:
    """One user-visible line.

    stderr, not the logger: while the TUI runs, prompt_toolkit's patch_stdout
    proxy renders stderr above the input area, and in -q mode it is plain
    stderr. Plain text only - the proxy shows escape bytes as noise (mono #1798).
    Never raises: a feedback line must not break a session.
    """
    try:
        print(view.sanitise(message), file=sys.stderr, flush=True)
    except Exception:
        pass


def _reset_state_for_tests() -> None:
    with _lock:
        _sessions.clear()
    _FIRST_SESSION_RUN["value"] = False


# -- runtime access ---------------------------------------------------------


def _spawn_client() -> Any:
    resolution = runtime_pin.resolve()
    return mcp_client.spawn_session_client(resolution, paths.runtime_home()).start()


def _state(session_id: str) -> "_SessionState":
    key = session_id or "default"
    with _lock:
        state = _sessions.get(key)
        if state is None:
            state = _SessionState()
            _sessions[key] = state
        return state


def _ensure_client(state: "_SessionState") -> Optional[Any]:
    if state.client is not None:
        return state.client
    if state.degraded is not None:
        return None
    try:
        state.client = _spawn_client()
    except Exception as exc:
        state.degraded = str(exc)
        logger.debug("jinn: runtime unavailable: %s", exc)
        return None
    return state.client


def _ensure_capture(state: "_SessionState", model: str) -> None:
    if state.feed is not None:
        return
    client = _ensure_client(state)
    if client is None:
        return
    try:
        opened = client.call_tool("capture_open", {})
        state.capture_session_id = str(opened["sessionId"])
        state.feed = feed_module.SessionFeed(Path(str(opened["feedPath"])))
    except Exception as exc:
        logger.debug("jinn: capture unavailable: %s", exc)
        state.feed = None
        return
    host_name, host_version = _host_identity()
    provider, model_name = _split_model(model)
    state.feed.open_session(
        session_id=state.capture_session_id or "",
        host_name=host_name,
        host_version=host_version,
        model_provider=provider,
        model_name=model_name,
        model_service=feed_module.derive_model_service(provider, model_name),
    )
    observed = _observe_repository_state(state.cwd)
    if observed is not None:
        state.feed.repository_state(**observed)
    state.feed.environment(tools=[], skills=[])


def _git(cwd: str, deadline: float, *args: str) -> str:
    """One short read from *cwd*'s repository, or "" if anything goes wrong.

    `-C cwd` is load-bearing, not tidiness: the process directory is not the session's. An
    orchestrator dispatches a session into a worktree while sitting elsewhere, and reading the
    wrong repository would seal a confident, wrong answer to the one question this record
    exists to answer.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        logger.debug("jinn: git budget spent before %s", args[0])
        return ""
    try:
        done = subprocess.run(
            ("git", "-C", cwd, *args),
            capture_output=True,
            text=True,
            timeout=remaining,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except Exception as exc:
        logger.debug("jinn: git %s failed: %s", args[0], exc)
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def _repository_iri(remote: str) -> str:
    """Normalize a Git remote to a credential-free network IRI, which is what the record needs.

    Two things are dropped rather than carried, for the same reason: the record they land in is
    durable, never deleted, and publicly projectable.

    * **Userinfo.** `https://x-access-token:ghs_…@github.com/o/r` is the remote every GitHub
      Actions checkout writes. A token sealed into an append-only archive cannot be withdrawn
      from it, so it is stripped here — at the source, which is the discipline this capture
      path is supposed to hold rather than leave to a later scrub.
    * **Local remotes.** `file:///Users/<name>/…` is a well-formed IRI naming a filesystem path,
      usually with a username in it, and it resolves for nobody.
    """
    remote = (remote or "").strip()
    # Whitespace anywhere makes it not an IRI, and the runtime refuses the whole feed for one.
    if not remote or re.search(r"\s", remote):
        return ""

    url = _URL_REMOTE.match(remote)
    if url is not None:
        if url.group("scheme").lower() not in _NETWORK_SCHEMES:
            logger.debug("jinn: remote scheme %r is not a network repository", url.group("scheme"))
            return ""
        if url.group("userinfo"):
            logger.debug("jinn: dropped credentials from the origin remote")
        # ssh:// is a transport, not a way to fetch; https names the same repository publicly.
        # The port does not survive that rewrite: 22 (or Gerrit's 29418) names the SSH daemon,
        # not the web endpoint. Keep a port only where the scheme it belongs to is kept.
        observed = url.group("scheme").lower()
        scheme = "https" if observed == "ssh" else observed
        port = f":{url.group('port')}" if url.group("port") and scheme == observed else ""
        return f"{scheme}://{url.group('host')}{port}{url.group('path')}"

    scp = _SCP_REMOTE.match(remote)
    if scp is not None:
        return f"https://{scp.group('host')}/{scp.group('path')}"

    logger.debug("jinn: remote %r is not a network repository", remote)
    return ""


def _observe_repository_state(cwd: Optional[str]) -> Optional[Dict[str, str]]:
    """Read the base commit and tree the session in *cwd* starts from.

    The commit and tree are the content binding; branch and target base are context this may
    legitimately fail to find (a detached head, a repository with no upstream).
    """
    if not cwd:
        return None
    deadline = time.monotonic() + _GIT_BUDGET_S
    commit = _git(cwd, deadline, "rev-parse", "HEAD")
    tree = _git(cwd, deadline, "rev-parse", "HEAD^{tree}")
    repository = _repository_iri(_git(cwd, deadline, "config", "--get", "remote.origin.url"))
    if not commit or not tree or not repository:
        return None
    upstream = _git(cwd, deadline, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    return {
        "repository": repository,
        "base_commit": commit,
        "base_tree": tree,
        "branch": _git(cwd, deadline, "rev-parse", "--abbrev-ref", "HEAD"),
        # "origin/next" names the same base as "next"; the remote prefix is local bookkeeping.
        "target_base": upstream.split("/", 1)[1] if "/" in upstream else upstream,
    }


def _host_identity() -> tuple[str, str]:
    try:
        from hermes_cli import __version__ as host_version
    except Exception:
        host_version = "unknown"
    return "hermes-agent", str(host_version)


def _split_model(model: str) -> tuple[str, str]:
    if "/" in model:
        provider, name = model.split("/", 1)
        return provider, name
    return "unknown", model or "unknown"


def _marker_path() -> Path:
    return paths.state_dir() / _FIRST_SESSION_MARKER


def _first_session() -> bool:
    return not _marker_path().exists()


def _mark_first_session() -> None:
    marker = _marker_path()
    try:
        marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker.touch(mode=0o600, exist_ok=True)
    except OSError:
        pass  # a read-only home repeats the banner; it never breaks a session


# -- hooks ------------------------------------------------------------------


def _on_session_start(session_id: str = "", platform: str = "", **kwargs: Any) -> None:
    state = _state(session_id)
    state.cwd = kwargs.get("cwd") or kwargs.get("working_directory")
    first = _first_session()
    try:
        checks = doctor.run_checks(full=first)
    except Exception as exc:  # a doctor that crashes must not crash a session
        logger.debug("jinn: doctor failed: %s", exc)
        return
    state.degraded = doctor.degraded_reason(checks)
    if first:
        for line in view.first_session_banner(checks):
            user_line(line)
        _mark_first_session()
        _FIRST_SESSION_RUN["value"] = True
        return
    for check in checks:
        if not check["ok"]:
            for line in view.fail_lines(check):
                user_line(line)


def _on_pre_llm_call(
    session_id: str = "",
    user_message: str = "",
    is_first_turn: bool = False,
    model: str = "",
    **kwargs: Any,
) -> Optional[Dict[str, str]]:
    state = _state(session_id)
    state.model = model or state.model
    if kwargs.get("cwd"):
        state.cwd = str(kwargs["cwd"])
    _ensure_capture(state, state.model)
    if state.feed is not None:
        state.feed.user_turn(user_message or "")
    if not is_first_turn or state.pickup_done:
        return None
    state.pickup_done = True

    client = _ensure_client(state)
    if client is None:
        return None
    request: Dict[str, Any] = {"message": user_message or ""}
    slug = _repository_slug(state.cwd)
    if slug:
        request["repositorySlug"] = slug
    try:
        result = client.call_tool("pickup", request)
    except Exception as exc:
        # Retrieval absence is fail-open: the turn proceeds untouched.
        logger.debug("jinn: pickup failed open: %s", exc)
        return None

    terms = [str(term) for term in (result.get("terms") or [])]
    text = result.get("text")
    if result.get("status") == "projected" and isinstance(text, str) and text.strip():
        user_line(view.corpus_line(terms, int(result.get("recordCount") or 0)))
        return {"context": text}
    if _FIRST_SESSION_RUN["value"] and not state.announced:
        # The designed empty state, once per install: the mechanism must be
        # visible even when there is nothing to show.
        user_line(view.empty_line(terms))
        state.announced = True
    return None


def _on_post_tool_call(
    tool_name: str = "",
    args: Any = None,
    result: Any = None,
    session_id: str = "",
    tool_call_id: str = "",
    duration_ms: Optional[int] = None,
    status: str = "ok",
    error_message: Optional[str] = None,
    **_: Any,
) -> None:
    state = _state(session_id)
    if state.feed is None:
        return
    started = None
    if duration_ms:
        import time

        started = time.time_ns() - int(duration_ms) * 1_000_000
    state.feed.tool_call(
        tool_name=tool_name,
        tool_call_id=tool_call_id,
        arguments=args,
        result=result,
        status=status,
        started_at_unix_nano=started,
        error_message=error_message,
    )


def _on_post_llm_call(
    session_id: str = "",
    assistant_response: str = "",
    model: str = "",
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    **_: Any,
) -> None:
    state = _state(session_id)
    if state.feed is None:
        return
    state.feed.assistant_turn(assistant_response or "", model=model or None)
    if input_tokens or output_tokens:
        state.feed.tokens(int(input_tokens or 0), int(output_tokens or 0))


def _on_session_end(
    session_id: str = "",
    completed: bool = False,
    interrupted: bool = False,
    **_: Any,
) -> None:
    key = session_id or "default"
    with _lock:
        state = _sessions.pop(key, None)
    if state is None:
        return
    try:
        if state.feed is not None:
            outcome = "abandoned" if interrupted else ("completed" if completed else "failed")
            state.feed.close_session(outcome=outcome, summary="")
            client = state.client
            if client is not None and state.capture_session_id:
                try:
                    sealed = client.call_tool("capture_seal", {"sessionId": state.capture_session_id})
                    if not sealed.get("sealed"):
                        logger.debug("jinn: capture not sealed: %s", sealed.get("diagnostics"))
                except mcp_client.McpToolError as exc:
                    # A busy archive keeps the feed; the next session's sweep or
                    # a later run seals it. Never a user-facing failure.
                    logger.debug("jinn: seal deferred (%s)", exc.code)
                except Exception as exc:
                    logger.debug("jinn: seal failed: %s", exc)
        elif state.degraded:
            for line in view.fail_lines(
                {"name": "runtime-available", "ok": False, "detail": state.degraded, "remedy": doctor.UPDATE_REMEDY}
            ):
                user_line(line)
    finally:
        if state.client is not None:
            try:
                state.client.close()
            except Exception:
                pass


def _repository_slug(cwd: Optional[str]) -> Optional[str]:
    """owner/name from the checkout's origin remote, when there is one."""
    if not cwd:
        return None
    import re
    import subprocess

    try:
        completed = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except Exception:
        return None
    if completed.returncode != 0:
        return None
    match = re.search(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?\s*$", completed.stdout.strip())
    return f"{match.group(1)}/{match.group(2)}" if match else None


# -- commands ---------------------------------------------------------------


def handle_jinn(command_args: str = "", session_id: str = "", **_: Any) -> str:
    argument = (command_args or "").strip().lower()
    if argument in {"", "doctor"}:
        return view.render_checks(doctor.run_checks(full=True))
    return "usage: /jinn doctor"


# -- registration -----------------------------------------------------------


def register(ctx) -> None:
    """Called once per process, only when the plugin is enabled.

    Two side effects, both idempotent and both non-fatal: acquire the pinned
    runtime for an installed clone (stock Hermes has no dependency-install
    hook), and register the read-only corpus tools with the host's own MCP
    plumbing. A failure in either degrades the product to a doctor finding; it
    never prevents the hooks from registering, because a plugin that fails to
    load cannot tell the user why.
    """
    resolution = None
    try:
        resolution = runtime_pin.ensure() if paths.is_installed_plugin() else runtime_pin.resolve()
    except runtime_pin.ChannelOutageError as exc:
        logger.warning("jinn: %s", exc)
    except runtime_pin.RuntimePinError as exc:
        logger.warning("jinn: runtime unavailable: %s", exc)

    if resolution is not None and os.environ.get("JINN_PLUGIN_SKIP_HOST_CONFIG_ENSURE") != "1":
        action = host_config.ensure_entry(resolution, paths.runtime_home())
        logger.debug("jinn: corpus tool registration %s", action)

    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_command(
        "jinn",
        handler=handle_jinn,
        description="Jinn: environment checks for capture and corpus retrieval.",
        args_hint="doctor",
    )
    # Not named `doctor`: that collides with the built-in hermes subcommand and
    # would silently disable discovery of every plugin CLI command.
    ctx.register_cli_command(
        "jinn-doctor",
        help="Jinn environment checks - adapter, runtime pin, prerequisites, corpus.",
        setup_fn=doctor.setup_parser,
        handler_fn=doctor.cli_handler,
        description="Print-only: [ok]/[fail] per check, one copy-paste remedy per failure.",
    )

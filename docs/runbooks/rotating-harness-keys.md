# Rotating harness keys

How to rotate the credential each harness uses. The operator dashboard's
**Settings → Security → Harness auth status** panel shows, per harness, where
the credential lives, the masked last-4 suffix, when the file last changed, and
a `loaded` / `missing` / `unknown` state. It never shows the full key. After
rotating, the daemon picks up file-based credentials on its next read; restart
`jinn run` if a harness still shows the old suffix.

## hermes-agent

- **Source:** the `OPENROUTER_API_KEY` line in `$HERMES_HOME/.env`
  (default `~/.hermes/.env`).
- **Rotate:**
  1. Create a new key at https://openrouter.ai/keys and revoke the old one.
  2. Edit `~/.hermes/.env` and set `OPENROUTER_API_KEY=<new-key>`.
  3. Confirm the panel shows the new last-4 suffix and an updated "last
     modified" time.
- **State meaning:** `loaded` = the file exists and the key line is present and
  non-empty. `missing` = the file or the key line is absent.

## claude-code

- **Source:** a CLI session, not a file. Auth is managed by the Claude CLI
  (`claude auth status` / `claude login`); there is no key file to read, so the
  panel shows state `unknown` and no suffix by design.
- **Rotate / re-auth:**
  1. Run `claude logout` then `claude login`, or re-run `claude setup-token`.
  2. Verify with `claude auth status`.
- **State meaning:** always `unknown` — session auth is not file-inspectable.
  Use the Claude precheck in onboarding to confirm the session is live.

## codex

- **Source:** `OPENAI_API_KEY` if set in the environment; otherwise the
  `auth.json` written by `codex login`, at `$CODEX_HOME/auth.json`
  (default `~/.codex/auth.json`).
- **Rotate:**
  - **API key:** set a new `OPENAI_API_KEY` in the daemon's environment and
    restart `jinn run`. The panel shows the new last-4 suffix.
  - **OAuth session:** run `codex login` to refresh `auth.json`. The panel
    reports the file's path and last-modified time; because `auth.json` is JSON
    (no flat key line), the suffix is shown as `—` while state is `loaded` from
    file existence.
- **State meaning:** `loaded` = the env key is set, or `auth.json` exists.
  `missing` = neither is present.

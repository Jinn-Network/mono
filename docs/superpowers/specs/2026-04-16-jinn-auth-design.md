# `jinn auth` — Claude Authentication Verb

**Version:** 1.0
**Date:** 2026-04-16
**Author:** adrianobradley + Claude

## Problem

Operators running the jinn daemon in Docker need to authenticate Claude inside
the container before the daemon can function. The current process requires
assembling a long `docker compose run --rm -it --entrypoint claude ...` command
from documentation. This is error-prone, undiscoverable, and a common stumbling
block for first-time setup.

Host-install operators face a simpler version of the same problem: they need to
know that `claude auth login` is a prerequisite, and there's no `jinn` verb
that checks or guides them.

## Solution

A new `jinn auth` CLI verb that:

1. Detects the operator's runtime context (container, Docker Compose, bare host)
2. Probes Claude's auth status in that context
3. Guides the operator through login if needed
4. Verifies the result

Additionally, `jinn run` gains an auth preflight check that catches missing
auth before the daemon starts, and `jinn doctor` includes auth status in its
checks array.

## Context Detection

Three contexts, checked in order:

| Context | Detection | Auth target |
|---------|-----------|-------------|
| **Container** | `/.dockerenv` exists | `claude` directly (already inside the right filesystem) |
| **Docker Compose** | `docker-compose.yml` in cwd contains service `jinn-daemon` | `docker compose run --rm -it --entrypoint claude jinn-daemon` |
| **Bare host** | Neither of the above | `claude` directly on the host |

The Docker Compose detection looks for the production compose file only.
The acceptance stack is internal tooling and assembles its own compose commands.

## `jinn auth` Verb

### Flow

```
jinn auth [--json] [--human]

1. Detect context (container / docker-compose / bare)
2. Probe: run `claude auth status` in the detected context
3. If already authenticated:
     Emit result: { authenticated: true, context: "<context>" }
     Exit 0
4. If not authenticated:
     a. If non-interactive (no TTY):
          Emit envelope: code=invalid_invocation, exit 11
          Message: "Claude is not authenticated. Run `jinn auth`
                    in an interactive terminal."
     b. If interactive (TTY):
          Print context-aware guidance:
            Container/bare: "Authenticating Claude..."
            Docker: "Authenticating Claude inside the jinn-daemon
                     container. A browser URL will appear — visit
                     it to complete login."
          Exec `claude auth login` in the detected context
          Probe again to verify
          If success:
            Emit result: { authenticated: true, context: "<context>" }
            Exit 0
          If failed:
            Emit envelope: code=fatal, exit 50
            Message: "Authentication failed. Try again with `jinn auth`."
```

### Output

Follows the existing envelope/result contract from
`spec/2026-04-14-client-surface.md`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "authenticated": true,
  "context": "docker-compose",
  "claudeBinary": "claude"
}
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Authenticated (already was, or just completed login) |
| 11 | Not authenticated, non-interactive terminal (invalid_invocation) |
| 50 | Probe or login subprocess failed unexpectedly (fatal) |

## `jinn run` Integration

During the preflight in `main.ts`, before starting daemon loops:

1. Run the same auth probe used by `jinn auth`.
2. If authenticated: continue normally.
3. If not authenticated:
   - **TTY**: prompt "Claude is not authenticated. Authenticate now? [Y/n]".
     If yes, run the auth flow inline. If no or if auth fails, exit with
     guidance.
   - **Non-TTY**: emit `invalid_invocation` envelope:
     "Claude is not authenticated. Run `jinn auth` in an interactive
     terminal before starting the daemon." Exit 11.

This catches the problem at the earliest possible point, before the daemon
spins up loops that will fail on every Claude invocation.

## `jinn doctor` Integration

Add an `auth_status` check to the doctor checks array:

```json
{
  "name": "claude_auth",
  "label": "Claude authentication",
  "status": "pass",
  "detail": "Authenticated (context: docker-compose)"
}
```

On failure:

```json
{
  "name": "claude_auth",
  "label": "Claude authentication",
  "status": "fail",
  "detail": "Not authenticated. Run `jinn auth` to log in."
}
```

The doctor check uses the probe only (no login attempt). It runs in whatever
context it detects, same as `jinn auth`.

## Shared Probe Module

### `src/preflight/claude-auth.ts`

Exports:

```typescript
type AuthContext = 'container' | 'docker-compose' | 'bare';

interface AuthProbeResult {
  authenticated: boolean;
  context: AuthContext;
  claudeBinary: string;
}

function detectAuthContext(cwd: string): AuthContext;
function probeClaudeAuth(context: AuthContext, cwd: string): Promise<AuthProbeResult>;
```

`detectAuthContext`:
- Checks `/.dockerenv` for container context
- Checks for `docker-compose.yml` in `cwd` with a `jinn-daemon` service
- Falls back to `bare`

`probeClaudeAuth`:
- Builds the appropriate command for the context
- Runs `claude auth status` as a subprocess
- Parses the JSON stdout for `{ loggedIn: boolean }` to determine auth state
- Returns the probe result

Both functions are pure and testable. The probe spawns a subprocess but
has no other side effects.

## Files to Create or Modify

| File | Action |
|------|--------|
| `src/preflight/claude-auth.ts` | **Create** — shared probe logic |
| `src/cli/commands/auth.ts` | **Create** — the `jinn auth` verb |
| `src/cli/index.ts` | **Modify** — register the auth command |
| `src/main.ts` | **Modify** — add auth preflight before daemon startup |
| `src/cli/commands/doctor.ts` | **Modify** — add `claude_auth` check |
| `test/preflight/claude-auth.test.ts` | **Create** — unit tests for probe logic |
| `test/cli/commands/auth.test.ts` | **Create** — unit tests for verb |

## Testing

- **Unit tests** for `detectAuthContext` with mocked filesystem
  (/.dockerenv presence, docker-compose.yml presence/contents)
- **Unit tests** for `probeClaudeAuth` with mocked subprocess
  (authenticated / not-authenticated / error responses)
- **Unit tests** for the auth command (TTY/non-TTY, already-authed,
  needs-login, login-fails paths)
- **Doctor integration** — verify the check appears in doctor output

No integration tests that actually run `claude auth login` — that requires
real OAuth and is validated by the acceptance gate.

## Scope Boundaries

- **In scope**: `jinn auth` verb, `jinn run` preflight, `jinn doctor` check,
  shared probe module, unit tests.
- **Out of scope**: acceptance-stack auth (stays as-is, internal tooling),
  API key auth (Claude uses OAuth), multi-service compose detection.
- **Not changing**: the `ClaudeRunner` in `runner/claude.ts`, the Dockerfile,
  the compose files, or the daemon loop logic.

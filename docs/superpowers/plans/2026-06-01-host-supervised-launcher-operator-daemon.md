# Host the supervised launcher+operator daemon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the operator's existing local SWE-rebench v2 launcher+solver daemon (one wallet, both roles) onto a supervised, always-on Railway service so task creation never gaps, with the solver side bounded by the already-shipped AI-units throttle.

**Architecture:** A new `deploy/railway-launcher-operator/` recipe — based on `client/Dockerfile` (which already installs the Claude CLI), wrapped with an entrypoint that materializes per-deployment state (config, launched record, optional one-shot state-tarball restore) from env onto the `/data` Railway volume. The daemon's generator spawns from an owned launched record; the solver claims under the `[#815]` AI-units gate, which engages headless via `CLAUDE_CODE_OAUTH_TOKEN`. Migration is a cutover (same wallet → restore local state onto the volume), not a parallel add.

**Tech Stack:** Docker (multi-stage, `node:22-slim`), bash entrypoint, Railway (config-as-code + volume + `ON_FAILURE` restart), `@anthropic-ai/claude-code` CLI, `@jinn-network/client` daemon, `gh` for issue reconciliation.

**Spec:** [`docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md`](../specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md)

**Note on shape:** This is `chore`/ops. There is little unit-testable logic — the deliverables are deploy artifacts, a runbook, and a verified migration. "Tests" here are concrete verification commands (shellcheck, docker build, a local end-to-end daemon run, indexer queries). Tasks 6 are **operator-executed** (need Railway credentials + the funded wallet) and cannot be run from an agent session — they are written as a runbook the operator follows.

---

## File structure

| File | Responsibility |
|---|---|
| `deploy/railway-launcher-operator/railway.toml` | Railway config-as-code: Dockerfile path, `ON_FAILURE` restart, single replica. |
| `deploy/railway-launcher-operator/Dockerfile` | Build+runtime image (Claude CLI present), env defaults, entrypoint wiring. |
| `deploy/railway-launcher-operator/entrypoint.sh` | Materialize git identity, optional one-shot state restore, config seed, launched-record seed, auth/CLI probes; exec daemon. |
| `deploy/railway-launcher-operator/README.md` | Operator runbook: secrets, volume, funding, cutover, verification, caveats. |

No `client/` source changes. The AI-units throttle is already shipped; this plan only configures and verifies it.

---

## Task 0: Spike — verify headless claude-code OAuth (HIGHEST RISK; gates everything)

This is the one genuine unknown (spec §10 q4): can the `claude` CLI authenticate **non-interactively in a container** from `CLAUDE_CODE_OAUTH_TOKEN`, and does the credential resolve so the AI-units gate engages? If this fails, the hosted-Haiku approach needs rethinking before any artifact work.

> **FINDING (2026-06-01): PASS — env-only.** Using the saved release-gate token (`client/.env.acceptance`), `claude -p` with a clean `HOME` (no `~/.claude` fallback) and only `CLAUDE_CODE_OAUTH_TOKEN` in env returned `4` non-interactively. Local CLI `@anthropic-ai/claude-code` **2.1.159**. Corroborated by the existing docker-acceptance infra (`client/docker-compose.acceptance.yml` runs claude-code headless via the same env var) and `client/src/runner/claude.ts:199` forwarding it. **Conclusion:** the entrypoint needs only to ensure `CLAUDE_CODE_OAUTH_TOKEN` is exported (Railway secret) — no `~/.claude.json` file write. The file-fallback block in Task 3 stays commented out. The credential resolves to `anthropic:subscription`, so the AI-units gate engages. The Dockerfile pins `@anthropic-ai/claude-code@2.1.159`. (Docker daemon was down in the authoring env; the in-image `claude --version` probe is verified at build time / on the operator machine.)

**Files:** none (throwaway container experiment). Record findings in the task's commit message / a scratch note.

- [ ] **Step 1: Obtain a CLAUDE_CODE_OAUTH_TOKEN.** On a machine with `claude` logged in, generate a long-lived token:

```bash
claude setup-token   # prints a token; copy it
```

Expected: a token string is printed. (If `setup-token` is unavailable in the installed CLI version, record the actual subcommand the version exposes for headless auth — this is part of the spike's finding.)

- [ ] **Step 2: Run a throwaway container with only the token in env.**

```bash
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN="<token>" \
  node:22-slim bash -lc '
    npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 &&
    claude --version &&
    echo "2+2" | claude -p "reply with only the number" --model claude-haiku-4-5-20251001
  '
```

Expected: `claude --version` prints a version, and the `-p` (print/non-interactive) call returns `4` without prompting for login. **If it prompts for login or errors with an auth message, the env-only path is insufficient — proceed to Step 3.**

- [ ] **Step 3 (only if Step 2 failed): test the file-based fallback.** Some CLI versions read auth from `~/.claude.json` rather than the env var:

```bash
docker run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN="<token>" node:22-slim bash -lc '
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 &&
  mkdir -p /root/.claude &&
  printf "{\"oauthToken\":\"%s\"}" "$CLAUDE_CODE_OAUTH_TOKEN" > /root/.claude.json &&
  echo "2+2" | claude -p "reply with only the number" --model claude-haiku-4-5-20251001
'
```

Expected: determine which form works. Record: (a) the working auth mechanism (env-only vs. file), (b) the exact file shape if a file is needed, (c) the `@anthropic-ai/claude-code` version that worked (for pinning).

- [ ] **Step 4: Confirm the credential resolves for the gate.** The AI-units gate only engages if `resolveCredentialId('claude-code', env)` is non-null. With `CLAUDE_CODE_OAUTH_TOKEN` set it returns `anthropic:subscription` ([`client/src/spend/credential.ts`](../../../client/src/spend/credential.ts)). Confirm by reading that function — the env check is unconditional, so the gate engages as long as the token is exported into the daemon's environment.

- [ ] **Step 5: Record the finding and commit the note.**

```bash
git add docs/superpowers/plans/2026-06-01-host-supervised-launcher-operator-daemon.md
git commit -m "spike(#661): confirm headless claude-code OAuth mechanism

Finding: <env-only | file at ~/.claude.json>; claude-code version <x.y.z>;
token via \`claude setup-token\`; credential resolves to anthropic:subscription."
```

**Decision gate:** if no non-interactive auth path exists, STOP and revisit the spec's §6/§7 (the operator may have to run the solver locally and host only the generator with a separate non-LLM identity — a different design). Otherwise continue; Task 3 uses the mechanism found here.

---

## Task 1: Recipe scaffold + railway.toml

**Files:**
- Create: `deploy/railway-launcher-operator/railway.toml`

- [ ] **Step 1: Create the railway.toml.**

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "deploy/railway-launcher-operator/Dockerfile"

[deploy]
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
numReplicas = 1
```

- [ ] **Step 2: Verify it parses and points at this recipe (not root).**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -q 'dockerfilePath = "deploy/railway-launcher-operator/Dockerfile"' deploy/railway-launcher-operator/railway.toml && echo OK
test ! -f railway.toml && echo "OK: no root railway.toml (would hijack jinn-indexer, #846)"
```

Expected: both print `OK`. (A root `railway.toml` is applied to every monorepo service and broke the indexer — #846. This recipe's `railway.toml` must stay in its own dir and be wired via Railway's "Config as code" path in Task 6.)

- [ ] **Step 3: Commit.**

```bash
git add deploy/railway-launcher-operator/railway.toml
git commit -m "chore(deploy): railway.toml for launcher-operator recipe (#661)"
```

---

## Task 2: Dockerfile

**Files:**
- Create: `deploy/railway-launcher-operator/Dockerfile`

Based on `client/Dockerfile` (Claude CLI already installed there at line 68), with: build context = monorepo root, env defaults for headless testnet operation, no `VOLUME` directive (Railway rejects it), and the entrypoint wired in.

- [ ] **Step 1: Create the Dockerfile.**

```dockerfile
# Railway launcher+operator deploy image (claude-code / Haiku).
#
# Hosts the operator's single jinn-run daemon that is BOTH the SWE-rebench v2
# launcher/generator (owns a launched record) AND a solver — one wallet, both
# roles (see docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md).
#
# Derived from client/Dockerfile. Differences:
#   - entrypoint wrapper materialises config + launched record (+ optional
#     one-shot state restore) from env onto the /data volume on each boot.
#   - no VOLUME directive (Railway rejects it; volume attached at service level).
#
# Build context MUST be the monorepo root (copies from client/ and packages/sdk/).

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY client/package.json client/yarn.lock client/.yarnrc.yml ./client/
COPY client/src/dashboard/spa/package.json ./client/src/dashboard/spa/package.json
COPY packages/sdk/package.json packages/sdk/yarn.lock packages/sdk/README.md ./packages/sdk/
RUN corepack enable && cd client && yarn install --immutable

COPY packages/sdk/tsconfig.json ./packages/sdk/
COPY packages/sdk/src/ ./packages/sdk/src/

COPY client/src/ ./client/src/
COPY client/deployments/ ./client/deployments/
COPY client/docs/ ./client/docs/
COPY client/plugins/ ./client/plugins/
COPY client/scripts/ ./client/scripts/
COPY client/templates/ ./client/templates/
COPY client/tsconfig.json ./client/

WORKDIR /app/client
RUN yarn build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude CLI for the claude-code harness. (Pin to the version verified in Task 0.)
RUN npm install -g @anthropic-ai/claude-code

# Claude Code writes config to $HOME/.claude.json; keep it on the volume so the
# OAuth token / session survives container restarts (mirrors client/Dockerfile).
RUN mkdir -p /root/.claude && ln -sf /root/.claude/claude.json /root/.claude.json

COPY --from=build /app/client/dist dist/
COPY --from=build /app/client/deployments deployments/
COPY --from=build /app/client/plugins plugins/
COPY --from=build /app/client/node_modules node_modules/
COPY --from=build /app/client/package.json ./

# Durable state on the Railway volume at /data.
ENV NODE_ENV=production
ENV JINN_EARNING_DIR=/data/earning
ENV JINN_DB_PATH=/data/jinn.db
ENV JINN_CONFIG=/data/config.json
ENV JINN_NETWORK=testnet
ENV JINN_AUTO_TESTNET_FAUCET=1

EXPOSE 7331
# NOTE: no `VOLUME ["/data"]` — Railway rejects the Dockerfile directive.
# Attach the /data volume at the service level (railway volume add --mount-path /data).

COPY deploy/railway-launcher-operator/entrypoint.sh /usr/local/bin/jinn-launcher-operator-entrypoint.sh
RUN chmod +x /usr/local/bin/jinn-launcher-operator-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/jinn-launcher-operator-entrypoint.sh"]
CMD ["run", "--config", "/data/config.json"]
```

- [ ] **Step 2: Verify it builds.** From the monorepo root (build context = root):

```bash
cd "$(git rev-parse --show-toplevel)"
docker build -f deploy/railway-launcher-operator/Dockerfile -t jinn-launcher-operator:test .
```

Expected: build succeeds; final image tagged. If Docker is unavailable in the environment, fall back to `hadolint deploy/railway-launcher-operator/Dockerfile` and a manual diff against `client/Dockerfile` confirming only the documented differences.

- [ ] **Step 3: Verify the Claude CLI is present in the image.**

```bash
docker run --rm jinn-launcher-operator:test bash -lc 'claude --version'
```

Expected: prints a Claude CLI version. (Note: `ENTRYPOINT` is the wrapper, so pass `bash -lc` as the command to probe.)

- [ ] **Step 4: Commit.**

```bash
git add deploy/railway-launcher-operator/Dockerfile
git commit -m "chore(deploy): Dockerfile for launcher-operator recipe (#661)"
```

---

## Task 3: entrypoint.sh

**Files:**
- Create: `deploy/railway-launcher-operator/entrypoint.sh`

Materializes per-deployment state on each boot. Uses the auth mechanism confirmed in Task 0 (the version below assumes env-only `CLAUDE_CODE_OAUTH_TOKEN` works; if Task 0 found a file is required, uncomment the `~/.claude.json` write block as noted inline).

- [ ] **Step 1: Create the entrypoint.**

```bash
#!/usr/bin/env bash
# Materialise per-deployment state from env vars before launching the daemon.
# Persistent state lives on the Railway volume at /data so the daemon survives
# restarts. See docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md
set -euo pipefail

EARNING_DIR="${JINN_EARNING_DIR:-/data/earning}"
CONFIG_PATH="${JINN_CONFIG:-/data/config.json}"
LAUNCHED_DIR="$EARNING_DIR/solvernets/launched"

# --- One-shot state restore (cutover migration path) --------------------------
# JINN_STATE_TARBALL_B64, if set, is a base64-encoded tar.gz of the operator's
# local ~/.jinn-client/earning tree (keystore + earning/stake state + launched
# records). Extracted ONCE, only when /data/earning does not yet exist, so a
# redeploy never clobbers live state. This is how the same wallet/stake is
# migrated off the laptop.
if [ ! -d "$EARNING_DIR" ] && [ -n "${JINN_STATE_TARBALL_B64:-}" ]; then
  echo "[entrypoint] restoring state tarball into /data (first boot)"
  mkdir -p /data
  printf '%s' "$JINN_STATE_TARBALL_B64" | base64 -d | tar -xzf - -C /data
fi

mkdir -p "$EARNING_DIR" "$LAUNCHED_DIR"

# Global git identity so plugin session-start hooks (which `git commit
# --allow-empty` to init implStateDir before setting their own user.*) don't
# fail with "Author identity unknown" on a fresh container.
git config --global user.name  "jinn-launcher-operator" || true
git config --global user.email "jinn-launcher-operator@local" || true

# --- Claude auth probe --------------------------------------------------------
# Per Task 0: the claude CLI authenticates from CLAUDE_CODE_OAUTH_TOKEN in env,
# which Railway exports into this process; child claude subprocesses inherit it.
# The same env var makes resolveCredentialId('claude-code') return
# anthropic:subscription, so the AI-units gate engages.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[entrypoint] WARNING: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set —"
  echo "[entrypoint] WARNING: claude-code will fail auth AND the AI-units throttle will be OFF (unbounded burn)."
fi
# --- If Task 0 found a FILE is required, uncomment: ---------------------------
# if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
#   printf '{"oauthToken":"%s"}' "$CLAUDE_CODE_OAUTH_TOKEN" > /root/.claude/claude.json
#   chmod 600 /root/.claude/claude.json
# fi
if command -v claude >/dev/null 2>&1; then
  echo "[entrypoint] claude CLI: $(claude --version 2>&1 | head -1)"
else
  echo "[entrypoint] ERROR: claude CLI not in PATH; claude-code tasks will fail"
fi

# --- Operator config (seeded only on first run) -------------------------------
if [ ! -f "$CONFIG_PATH" ]; then
  if [ -n "${CONFIG_TEMPLATE_JSON:-}" ]; then
    echo "[entrypoint] seeding $CONFIG_PATH from CONFIG_TEMPLATE_JSON env"
    printf '%s' "$CONFIG_TEMPLATE_JSON" > "$CONFIG_PATH"
  else
    echo "[entrypoint] WARNING: no CONFIG_TEMPLATE_JSON and $CONFIG_PATH missing — daemon starts with no SolverNets joined"
  fi
fi

# --- Launched record (so the generator spawns) --------------------------------
# LAUNCHED_RECORD_JSON, if set, is the operator's owned launched record JSON
# (schemaVersion solvernet.launched.v1). Written to
# $JINN_EARNING_DIR/solvernets/launched/<solverNetId>.json — the path the
# daemon walks at startup (client/src/main.ts:2393). Skipped if the state
# tarball already restored a record. The filename MUST be the record's
# solverNetId (a SafeId: alnum/dash/underscore/dot).
if [ -n "${LAUNCHED_RECORD_JSON:-}" ]; then
  SID="$(printf '%s' "$LAUNCHED_RECORD_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).solverNetId||"")})')"
  if [ -z "$SID" ]; then
    echo "[entrypoint] ERROR: LAUNCHED_RECORD_JSON has no solverNetId"; exit 1
  fi
  TARGET="$LAUNCHED_DIR/$SID.json"
  if [ ! -f "$TARGET" ]; then
    echo "[entrypoint] seeding launched record $TARGET"
    printf '%s' "$LAUNCHED_RECORD_JSON" > "$TARGET"
  fi
fi

# --- Hand off to the daemon ---------------------------------------------------
echo "[entrypoint] exec node dist/bin/jinn.js $*"
exec node dist/bin/jinn.js "$@"
```

- [ ] **Step 2: Lint with shellcheck.**

```bash
shellcheck deploy/railway-launcher-operator/entrypoint.sh
```

Expected: no errors. (If shellcheck flags the `node -e` `SID` extraction quoting, confirm it's intentional and add a `# shellcheck disable` only if truly needed.)

- [ ] **Step 3: Dry-run the materialization logic locally against a temp dir.**

```bash
tmp="$(mktemp -d)"
JINN_EARNING_DIR="$tmp/earning" \
JINN_CONFIG="$tmp/config.json" \
CONFIG_TEMPLATE_JSON='{"joinedSolverNets":{}}' \
LAUNCHED_RECORD_JSON='{"schemaVersion":"solvernet.launched.v1","solverNetId":"swe-rebench-v2-001","manifestCid":"bafyTEST","manifestHash":"0x00","launcherAgentId":"1","launcherSafeAddress":"0x0000000000000000000000000000000000000000","launchedAt":"2026-06-01T00:00:00Z","status":"launched","statusUpdatedAt":"2026-06-01T00:00:00Z","generatorEnabled":true,"registry":{}}' \
bash -c '
  set -e
  # exec the daemon would actually start it — replace the final exec line for the dry run:
  sed "s#^exec node.*#echo DRYRUN-DONE#" deploy/railway-launcher-operator/entrypoint.sh > "'"$tmp"'/ep.sh"
  bash "'"$tmp"'/ep.sh" run
'
echo "--- seeded files ---"
cat "$tmp/config.json"
cat "$tmp/earning/solvernets/launched/swe-rebench-v2-001.json"
rm -rf "$tmp"
```

Expected: prints `DRYRUN-DONE`; `config.json` contains the template; the launched record is written at `earning/solvernets/launched/swe-rebench-v2-001.json` (filename = `solverNetId`).

- [ ] **Step 4: Commit.**

```bash
git add deploy/railway-launcher-operator/entrypoint.sh
git commit -m "chore(deploy): entrypoint for launcher-operator recipe (#661)"
```

---

## Task 4: README runbook

**Files:**
- Create: `deploy/railway-launcher-operator/README.md`

- [ ] **Step 1: Write the runbook.** It must cover: what this recipe is, required secrets/env, the volume, the config-as-code requirement (and the #846 warning), funding, the cutover/migration procedure, verification, and the caveats. Use this content:

````markdown
# Railway deploy — launcher+operator (claude-code / Haiku)

Hosts the operator's single `jinn run` daemon that is **both** the SWE-rebench v2
launcher/generator and a solver — one wallet, both roles. Standing this up on a
supervised host is how we stop the task-generator gaps that fail Milestone 1
blocks (see `docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md`).

Run locally with `jinn run`; this directory is only for the headless hosted deploy.

## Required Railway env vars (secrets)

| Variable | Source | Purpose |
|---|---|---|
| `JINN_PASSWORD` | the operator's existing keystore password | Decrypts the migrated keystore. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` on a logged-in machine | Authenticates Haiku headless **and** keeps the AI-units throttle engaged. **If unset, the throttle is silently OFF.** |
| `CONFIG_TEMPLATE_JSON` | the operator config, minified | Seeded to `/data/config.json` on first boot. Must include the `joinedSolverNets[<cid>]` entry with `harness: "claude-code"`, `model: "claude-haiku-4-5-20251001"`, and the load-bearing `contract: { id, version }` field (#674). |
| `JINN_STATE_TARBALL_B64` *(migration)* | `base64` of `tar -czf - -C ~/.jinn-client earning` | One-shot restore of keystore + stake state + launched record. Extracted only when `/data/earning` is absent. |
| `LAUNCHED_RECORD_JSON` *(fresh, alt to tarball)* | the owned `…/launched/<id>.json` | Seeds the launched record so the generator spawns. Redundant if the tarball already carries it. |

Baked-in defaults (override via Railway env): `JINN_NETWORK=testnet`,
`JINN_AUTO_TESTNET_FAUCET=1`, `JINN_EARNING_DIR=/data/earning`,
`JINN_DB_PATH=/data/jinn.db`, `JINN_CONFIG=/data/config.json`.

## Volume

Attach a volume at `/data`: `railway volume add --mount-path /data`. Keystore,
earning/stake state, launched records, SQLite db, and the Claude config all live there.

## One-time service setup

Set **Settings → Config as code → `deploy/railway-launcher-operator/railway.toml`**.
Do **not** put a `railway.toml` at the repo root — it hijacks `jinn-indexer` and
every other monorepo service (#846).

## Cutover (migration) — same wallet, so NOT parallel

The hosted box uses the **same wallet** as the laptop; running both at once causes
nonce races and double-claims. Cut over:

1. Stop the local daemon (`jinn kill` or Ctrl-C).
2. Export local state: `tar -czf - -C ~/.jinn-client earning | base64 | tr -d '\n' > state.b64` → set as `JINN_STATE_TARBALL_B64`.
3. Set the other secrets above; attach the volume; set the config-as-code path.
4. Deploy: from the repo root, `railway up --service <name> --environment production --ci -m "launcher-operator cutover"`.
5. Confirm the staked service re-appears in the staking contract's `getServiceIds()` and the generator resumes (see Verification).

## Funding

The agent EOA needs Base Sepolia ETH (gas + task-creation fees); the Safe needs
OLAS for the bond. On a migration the wallet is already funded/staked, so this is
moot. For a fresh wallet, `JINN_AUTO_TESTNET_FAUCET=1` only fires in Stage 2 — drip
the EOA manually past the Stage-1 minimum (~0.02 ETH) first.

## Verification

- Boot log shows `[ai-units] cap=100/2800 per (block, week)` → throttle engaged. **If absent, the credential didn't resolve — check `CLAUDE_CODE_OAUTH_TOKEN`.**
- `[entrypoint] claude CLI: <version>` and `[creator] …` task-posting lines appear.
- Task-creation rate on the indexer is non-zero and continuous (no gap > a few minutes).

## Caveats

- **Supply single-point-of-failure.** This box is now the sole task creator. `ON_FAILURE`
  restart + the task backlog buffer + an alert on stalled task-creation mitigate it; the
  *second* distinct operator M1 needs comes from the fleet on independent infra.
- True supply redundancy needs a **second** launcher with its own wallet + launch (future).
- A Claude OAuth token lives in Railway secrets (same posture as the codex recipe's `CODEX_AUTH_JSON`).
````

- [ ] **Step 2: Verify links and the config-as-code warning are present.**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -q "deploy/railway-launcher-operator/railway.toml" deploy/railway-launcher-operator/README.md && echo "OK config-as-code path"
grep -qi "846" deploy/railway-launcher-operator/README.md && echo "OK #846 warning"
grep -qi "silently OFF" deploy/railway-launcher-operator/README.md && echo "OK throttle caveat"
test -f docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md && echo "OK spec link target exists"
```

Expected: four `OK` lines.

- [ ] **Step 3: Commit.**

```bash
git add deploy/railway-launcher-operator/README.md
git commit -m "docs(deploy): runbook for launcher-operator recipe (#661)"
```

---

## Task 5: Local end-to-end validation (the real acceptance gate before Railway)

Prove the recipe's daemon actually generates tasks AND engages the throttle, using a **copy** of the operator's local state, before touching Railway. Run on the operator's machine (it has the funded/staked wallet + a Claude login).

**Files:** none (runtime validation).

- [ ] **Step 1: Build the client and confirm the launched-record read path.** CLAUDE.md says `~/.jinn-client/solvernets/launched/` but the dispatcher reads `${earningDir}/solvernets/launched/` ([`client/src/main.ts:2393`](../../../client/src/main.ts)). Confirm where YOUR local records actually live:

```bash
cd client && yarn build
ls -la ~/.jinn-client/earning/solvernets/launched/ 2>/dev/null || ls -la ~/.jinn-client/solvernets/launched/ 2>/dev/null
```

Expected: exactly one of these lists your `<solverNetId>.json`. That directory is the canonical path; the entrypoint's `LAUNCHED_DIR` (earningDir-relative) must match it. If your records are under the bare `~/.jinn-client/solvernets/launched/`, note it — the migration tarball must place them where `JINN_EARNING_DIR` resolves them on the box.

- [ ] **Step 2: Run the built daemon with the claude-code harness and the token exported.**

```bash
cd client
export CLAUDE_CODE_OAUTH_TOKEN="<token from Task 0>"
node dist/bin/jinn.js run --config ~/.jinn-client/config.json 2>&1 | tee /tmp/jinn-validate.log
```

(Ensure the config's `joinedSolverNets[<cid>]` uses `harness: "claude-code"`, `model: "claude-haiku-4-5-20251001"`.)

- [ ] **Step 3: Verify the throttle engaged.**

```bash
grep -m1 '\[ai-units\] cap=' /tmp/jinn-validate.log
```

Expected: `[ai-units] cap=100/2800 per (block, week) source=...`. **If absent, the credential did not resolve — STOP and fix auth before deploying.**

- [ ] **Step 4: Verify the generator is creating tasks and the solver claims under the cap.**

```bash
grep -E '\[creator\]|\[ai-units\]|claimed|attempt' /tmp/jinn-validate.log | head -40
```

Expected: `[creator]` posting lines (generator alive); solver claim/attempt lines; and, once ~3 Haiku attempts land in a 6h block, an `ai_units_cap_reached` / pause log (throttle working). Cross-check task creation on the indexer for the SolverNet's manifest CID.

- [ ] **Step 5: Record the validation outcome** in the task commit (no code change; this is a gate).

```bash
git commit --allow-empty -m "test(#661): local e2e — generator posts + ai-units gate engaged (cap=100/2800)"
```

---

## Task 6: Operator-executed deploy + cutover (runbook; needs Railway creds + the wallet)

**This task cannot be run from an agent session** — it requires Railway credentials and the funded wallet. The operator follows `deploy/railway-launcher-operator/README.md` §Cutover. Checklist:

- [ ] Stop the local daemon.
- [ ] `tar -czf - -C ~/.jinn-client earning | base64 | tr -d '\n'` → set `JINN_STATE_TARBALL_B64`.
- [ ] Set `JINN_PASSWORD`, `CLAUDE_CODE_OAUTH_TOKEN`, `CONFIG_TEMPLATE_JSON` as Railway secrets.
- [ ] `railway volume add --mount-path /data`; set Config-as-code = `deploy/railway-launcher-operator/railway.toml`.
- [ ] `railway up --service <name> --environment production --ci -m "launcher-operator cutover (#661)"`.
- [ ] Confirm boot log shows `[ai-units] cap=…`, `[entrypoint] claude CLI: …`, and `[creator] …`.
- [ ] Confirm the staked service is in `getServiceIds()` on `0x24e34E5037956a5Feca1AAAfaA30297084C228B8` and the generator resumed (indexer task-creation non-zero).
- [ ] Watch for 24h: no task-creation gap > a few minutes.

---

## Task 7: Reconcile #661

**Files:** none (GitHub issue edit + comment).

- [ ] **Step 1: Append the deploy note + flag the stale criteria.**

```bash
gh issue comment 661 --repo Jinn-Network/mono --body "$(cat <<'EOF'
## Resolution — supervised launcher+operator daemon

Per the brainstorm (`docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md`), reframed from "more operators" to the actual binding constraint: **supply liveness**. The SWE-rebench v2 generator ran on a local laptop, started manually; a ~20.5h gap failed the 2026-05-27 00:00–06:00 block. Fix: host the operator's single launcher+solver daemon (one wallet, both roles) on a supervised Railway service (`deploy/railway-launcher-operator/`), claude-code/Haiku, throttled by the already-shipped #815 AI-units gate.

- **Service ID(s):** <fill at deploy>
- **Host / supervision:** Railway, `restartPolicyType=ON_FAILURE` ×10, volume at /data.
- **Throttle:** AI-units gate engaged headless via `CLAUDE_CODE_OAUTH_TOKEN`; default ceiling 100/2800 → ~3 Haiku attempts/6h block.

### Stale acceptance criteria
The original criteria reference the retired "trailing paired streak ≥ 115 checkpoints (≈20%)" rule. M1 was reframed (2026-05-28) to the two-gate tJINN criterion (per-block floor + 48h aggregate). The script update is tracked in #927. Treat #661's acceptance as: ≥1 supervised daemon staked + generator continuously creating tasks (no >few-min gap over 24h) + boot log shows the throttle engaged.
EOF
)"
```

Expected: comment posted.

- [ ] **Step 2: Verify.**

```bash
gh issue view 661 --repo Jinn-Network/mono --comments | tail -30
```

Expected: the resolution comment is present.

---

## Self-review

**Spec coverage:**
- §3 topology (one daemon, both roles) → Tasks 2–3 (single image runs `jinn run`; launched-record materialization spawns the generator). ✓
- §4 recipe (auth swap, launched record, config, pool, funding, supervision) → Tasks 1–4; pool access verified transitively in Task 5 Step 4; supervision in Task 1 (`ON_FAILURE`) + README alert caveat. ✓
- §5 throttle verify-not-build → Task 0 Step 4 (credential resolves) + Task 5 Step 3 (`cap=` log). ✓
- §6 cutover → Task 6 + README §Cutover. ✓
- §7 tradeoffs → README §Caveats. ✓
- §8 #661 reconciliation → Task 7. ✓
- §10 open questions: q1 launched-record delivery (env-seed + tarball, Task 3); q2 pool (verified e2e, Task 5); q3 heartbeat (README caveat — minimal: alert on stalled creation; full mechanism deferred); q4 OAuth headless (Task 0, the gating spike). ✓

**Placeholder scan:** Remaining `<…>` are runtime values the operator fills at deploy (token, service ID, service name) — not plan gaps. Task 0's outcome legitimately parameterizes Task 3's auth block (env-only vs. file), with both code paths shown.

**Type/path consistency:** `solverNetId` is the launched-record filename in both Task 3 (entrypoint) and the schema ([`store.ts:104`](../../../client/src/solvernets/store.ts)). `JINN_EARNING_DIR=/data/earning` is consistent across Dockerfile, entrypoint (`LAUNCHED_DIR`), and Task 5's path check. `CLAUDE_CODE_OAUTH_TOKEN` is the single auth var across Task 0, entrypoint, README, and the gate's `resolveCredentialId`.

**Known soft spot:** the launched-record read path discrepancy (CLAUDE.md vs. `main.ts:2393`) is surfaced as Task 5 Step 1 rather than assumed — the implementer confirms the real path on the target build before relying on it.

# Jinn Client Surface — Technical Spec

> Version: 1
> Date: 2026-04-14
> Author: Ale
> Status: Proposed (not yet adopted)
> Supersedes: none
> Informs: `docs/planning/2026-04-jinn-client-surface.md`

## 1. Purpose and scope

This spec defines the **stable command-line and JSON surface** exposed
by the Jinn client to its primary user — an AI coding agent (Claude
Code / Codex / Cursor) running headlessly on behalf of a human
operator.

The goal is a contract that survives backend refactors. Renaming
`JinnDistributor`, swapping OLAS for stOLAS, replacing Safe with
another account-abstraction primitive, or moving from Phase 1b to
Phase 2 must not break any agent written against this spec.

### 1.1 In scope

- Verb set (command names and purpose).
- JSON request/response shapes for every verb that emits output.
- Error envelope and exit code map.
- Behavioral rules the CLI must obey: headless-first, JSON-by-default,
  dry-run/yes on tx-emitting verbs, idempotency per verb, token
  resolution boundary.
- Stable role enums: wallet role, asset role, event kind, attention
  kind, preflight check name.

### 1.2 Out of scope

- The Solidity changes described in the MVL-on-OLAS proposal.
- HTTP API shapes *not* reachable through a CLI verb.
- Daemon-internal module structure.
- Which concrete token is currently used for a given asset role —
  that mapping lives in `jinn version` output and changes per phase.

### 1.3 Non-goals

- This is not an SDK. Libraries wrapping the CLI may exist later;
  they are not part of this spec.
- This is not a migration plan. Existing `npm run` entrypoints
  continue to work; the CLI is additive until a later spec retires
  them.

## 2. Vocabulary

All verbs are invoked as `jinn <verb> [args...]`. All verbs MUST
accept `--json` and MUST emit JSON on stdout when `--json` is set
or when `process.stdout.isTTY === false`.

### 2.1 Lifecycle verbs

| Verb | Purpose | Idempotent |
|---|---|---|
| `jinn init` | Generate wallet + keystore; print fleet identity as JSON | Yes — re-running on an existing keystore is a no-op |
| `jinn doctor` | Preflight: checks without mutation; answers "would `run` work?" | Yes |
| `jinn bootstrap` | Advance the state machine toward a running fleet | Yes |
| `jinn fund-requirements` | List what must be funded before the next step | Yes |
| `jinn run` | Foreground daemon; exits on SIGINT/SIGTERM | N/A (long-running) |
| `jinn stop` | Signal a running `jinn run` to shut down | Yes |
| `jinn kill` | Force-terminate jinn daemon processes found by cmdline enumeration (SIGTERM→10s→SIGKILL); `--all` required for more than one match | Yes |
| `jinn version` | Client version, protocol phase, deployment digest, token map | Yes |

### 2.2 Introspection verbs

All introspection verbs are read-only and MUST NOT emit any
transaction.

| Verb | Purpose |
|---|---|
| `jinn status` | Daemon liveness + top-level roll-up. `status.fleet.needsAttention` and `status.exit.blocking` are the only two fields a monitor loop must read. |
| `jinn fleet` | Per-service detail: step, wallets, balances, staking state, activity, rewards |
| `jinn balance` | Flat per-wallet balance map across master + service wallets |
| `jinn history` | Recent protocol activity bounded by `--since <ts>` or `--limit N` |
| `jinn rewards` | Earned vs claimed per service, per asset; next checkpoint time if known |
| `jinn logs` | Structured event stream; one JSON object per line |

### 2.3 Action verbs

Every verb in this group MUST support:
- `--dry-run` — compute and print the effect as JSON, exit `0`, emit
  no transactions.
- `--yes` — skip confirmation.
- Refuse to prompt when stdin is not a TTY: without `--yes` on a
  non-TTY, exit with code `11` and an `exampleCli` naming the flag.

| Verb | Purpose | Idempotent |
|---|---|---|
| `jinn submit-intent` | Publish a desired state | Yes — keyed on `(creatorMultisig, desiredStateId)`; re-posting returns the existing on-chain id |
| `jinn claim-rewards` | Pull pending protocol rewards for the fleet | Yes — zero-delta is success |
| `jinn fleet scale --to N` | Grow or shrink fleet to target service count | Yes — target-state semantics |
| `jinn fleet retire <index>` | Retire one service: unstake, unbond, drain | Yes — already-retired is a no-op |
| `jinn withdraw --to <addr>` | Sweep wallets to an external address | No — requires `--yes` or TTY confirmation |
| `jinn keys backup --output <path>` | Write mnemonic to a path; no other side effects | Yes |

## 3. Stable role enums

Role names are the stable part of every JSON shape. Concrete values
mapped to each role (tokens, contract addresses, file paths) may
change across phases; role names will not.

### 3.1 Wallet role

```
master
service.<index>.agent
service.<index>.multisig
```

`<index>` is a non-negative integer; indices are stable for the
lifetime of a fleet and are not reused after a retire.

### 3.2 Asset role

```
native   // ETH (or equivalent native gas token)
bond     // Whatever token currently bonds a service (OLAS, stOLAS, ...)
reward   // Whatever token currently pays protocol rewards (stOLAS, JINN, ...)
```

The concrete token backing each role at runtime lives **only** in
`jinn version` output and in the `details` field of
`jinn fund-requirements`. It MUST NOT appear anywhere else in client
output.

### 3.3 Event kind

```
intent_posted
request_claimed
delivery_submitted
evaluation_submitted
reward_claimed
other     // forward-compat; carries a free-form `subkind` that the agent may ignore
```

### 3.4 Attention kind

```
none                   // service is healthy
low_gas                // native balance below the runway threshold
evicted                // on-chain staking shows evicted
stake_missing          // local state believes staked; chain disagrees
bond_insufficient      // bond token balance below minStakingDeposit
reconcile_needed       // chain state conflicts with local state; run `jinn bootstrap`
```

### 3.5 Preflight check name

```
node_version
claude_binary
rpc_reachable
keystore_readable
deployment_loaded
disk_writable
fleet_coherent
```

New check names may be added; existing names MUST NOT be removed or
repurposed without a spec version bump.

## 4. JSON shapes

Every response is a single JSON object with these common fields:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-14T12:30:00Z"
}
```

Field order is not significant. Unknown fields in responses MUST be
ignored by consumers (forward-compat).

### 4.1 `jinn status`

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-14T12:30:00Z",
  "daemon": {
    "state": "running" | "stopped" | "starting",
    "startedAt": "ISO-8601 or null",
    "phase": "phase-1b" | "phase-2" | ...,
    "network": "testnet" | "mainnet"
  },
  "rpc": {
    "ok": true | false,
    "chainId": 84532,
    "blockNumber": 12345678,
    "error": "string or absent"
  },
  "fleet": {
    "size": 3,
    "complete": 3,
    "needsAttention": 0
  },
  "earnings": {
    "pendingTotal": "decimal string (wei)",
    "asset": "reward"
  },
  "exit": {
    "blocking": false,
    "hint": null | "string"
  }
}
```

An agent monitoring liveness MUST be able to decide "healthy" from
`rpc.ok === true && fleet.needsAttention === 0 && exit.blocking === false`
without reading any other field.

### 4.2 `jinn fleet`

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "network": "testnet",
  "master": {
    "address": "0x...",
    "balances": [{ "asset": "native", "amountWei": "..." }]
  },
  "services": [
    {
      "index": 0,
      "step": "running" | <ServiceStep enum>,
      "serviceId": 42,
      "wallets": {
        "agent":    { "address": "0x...", "balances": [...] },
        "multisig": { "address": "0x...", "balances": [...] }
      },
      "staking": {
        "staked": true,
        "evicted": false,
        "sinceBlock": 12300000
      },
      "activity": {
        "lastEventAt": "ISO-8601 or null",
        "counts": { "create": 0, "deliver": 0, "evaluate": 0 }
      },
      "rewards": { "pending": "wei string", "asset": "reward" },
      "attention": null | {
        "kind": <AttentionKind>,
        "hint": "string",
        "exampleCli": "jinn ..."
      }
    }
  ]
}
```

Every balance entry is `{ "asset": <AssetRole>, "amountWei": <decimal string> }`.

### 4.3 `jinn balance`

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "wallets": [
    { "role": "master",             "address": "0x...", "balances": [...] },
    { "role": "service.0.agent",    "address": "0x...", "balances": [...] },
    { "role": "service.0.multisig", "address": "0x...", "balances": [...] }
  ]
}
```

### 4.4 `jinn history`

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "cursor": { "next": "opaque string or null" },
  "events": [
    {
      "id": "evt_NNNNN",
      "at": "ISO-8601",
      "serviceIndex": 0,
      "kind": <EventKind>,
      "subkind": "present only when kind === other",
      "intentId": "req_0x... or null",
      "txHash": "0x... or null",
      "outcome": "ok" | "failed" | "pending"
    }
  ]
}
```

Query parameters: `--since <ISO-8601>`, `--limit <N>` (default 50,
max 500), `--cursor <opaque>`.

### 4.5 `jinn doctor`

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "checks": [
    {
      "name": <CheckName>,
      "ok": true | false,
      "detail": "string",
      "remedy": "string, present only when ok=false"
    }
  ],
  "ok": true | false,
  "blockingCount": 0
}
```

`jinn doctor` makes NO network mutation. It MAY read from RPC to
verify reachability.

### 4.6 `jinn fund-requirements`

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "requirements": [
    {
      "role": <WalletRole>,
      "address": "0x...",
      "asset": <AssetRole>,
      "haveWei": "decimal string",
      "needWei": "decimal string",
      "reason": "human-readable",
      "blocks": "bootstrap" | "run" | "submit-intent" | "claim-rewards",
      "details": {
        "tokenAddress": "0x... or null",
        "tokenSymbol": "OLAS" | "stOLAS" | "ETH" | ...
      }
    }
  ],
  "satisfied": false
}
```

`requirements[].details.tokenSymbol` is the ONLY place token symbols
appear in the introspection surface (together with `jinn version`).
When `satisfied === true`, `requirements` is an empty array.

### 4.7 `jinn version`

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "client": { "version": "0.1.0", "commit": "09ced7af" },
  "protocol": { "phase": "phase-1b", "specVersion": 1 },
  "network": "testnet",
  "deployments": {
    "digest": "sha256:...",
    "artifacts": [
      { "name": "token", "path": "contracts/deployment-phase1a-token-baseSepolia-fast.json", "sha256": "..." }
    ]
  },
  "tokens": {
    "native": { "symbol": "ETH", "decimals": 18 },
    "bond":   { "symbol": "stOLAS", "address": "0x...", "decimals": 18 },
    "reward": { "symbol": "stOLAS", "address": "0x...", "decimals": 18 }
  }
}
```

`tokens` is the normative token resolution table. Every other verb's
output uses role names and defers here for symbol lookup.

## 5. Exit codes

| Code | Meaning | Envelope `code` field |
|---|---|---|
| `0` | Command completed as requested | n/a |
| `10` | Funding required | `funding_required` |
| `11` | Invalid invocation or missing required input (flag, config, deployment, environment tool) | `invalid_invocation` |
| `20` | Bootstrap advanced but not complete; re-invoke to continue | `bootstrap_incomplete` |
| `30` | Chain state conflict; reconcile recommended | `reconcile_needed` |
| `40` | Transient RPC / network error; caller should retry | `transient_error` |
| `50` | Fatal, unrecoverable | `fatal` |

Any exit code not in this table is a defect. Agents MAY treat any
unknown code as equivalent to `50`.

## 6. Error envelope

On any non-zero exit, the CLI MUST write a single JSON object to
**stdout** (not stderr — stderr is reserved for logs) and then exit.

```json
{
  "schemaVersion": 1,
  "code": "funding_required",
  "exitCode": 10,
  "message": "Master wallet needs 0.045 ETH more on Base Sepolia",
  "hint": "Send ETH to 0xabc... then re-run.",
  "exampleCli": "jinn fund-requirements --json",
  "details": {
    "role": "master",
    "address": "0xabc...",
    "asset": "native",
    "needWei": "45000000000000000"
  }
}
```

### 6.1 Field semantics

- `schemaVersion` — integer; increments on breaking changes to the
  envelope itself.
- `code` — stable string drawn from the exit-code table (§5). Agents
  switch on this.
- `exitCode` — integer; matches the process exit code. Duplicated
  inside the envelope for consumers that only see stdout.
- `message` — human-readable primary line. Wording may change across
  versions.
- `hint` — optional human-readable follow-up. Wording may change.
- `exampleCli` — OPTIONAL canonical next-command string the agent can
  invoke. When present, an agent retry loop SHOULD prefer re-invoking
  `exampleCli` over parsing `message` or `hint`.
- `details` — verb-specific structured data; schema depends on `code`.
  Agents MUST tolerate unknown fields.

### 6.2 Code → details map

| `code` | `details` schema |
|---|---|
| `funding_required` | `{ role, address, asset, needWei, haveWei }` |
| `invalid_invocation` | `{ field: "flag name, env var, or environment tool", expected: "string" }` |
| `bootstrap_incomplete` | `{ currentStep, nextStep }` |
| `reconcile_needed` | `{ serviceIndex, localStep, chainState }` |
| `transient_error` | `{ cause: "string", retryAfterMs: integer }` |
| `fatal` | `{ cause: "string", stack: "present only when JINN_DEBUG=1" }` |

### 6.3 Backwards compatibility of envelopes

The set of `code` values MAY grow. Existing `code` values MUST NOT
change meaning. The `details` schema for a given `code` MAY grow
(new fields), but existing fields MUST NOT change shape or name
without a `schemaVersion` bump.

## 7. Behavioral rules

### 7.1 Headless-first

Every verb MUST run to completion given flags and environment
variables alone. Prompts are permitted only when a required value
is missing AND `stdin` is a TTY. On a non-TTY with a missing
required value, the verb MUST exit `11` with envelope
`code: "invalid_invocation"` and an `exampleCli` naming the flag
that would have satisfied it.

- Secrets MUST come from environment variables or `--password-fd <N>`
  (read the password from file descriptor N). Secrets MUST NOT be
  accepted as command-line flag values.
- Config MAY be supplied via `--config -` (stdin).

### 7.2 JSON-by-default on non-TTY

When `process.stdout.isTTY === false`, `--json` is implicit. When
stdout IS a TTY, the CLI emits human-readable text unless `--json`
is explicitly set. The `NO_COLOR` environment variable MUST be
respected for the human mode.

### 7.3 Dry-run and confirmation

Every verb in §2.3 MUST support `--dry-run` and `--yes` as defined
in that section. Dry-run MUST NOT emit any transaction and MUST
exit `0`. Confirmation-required verbs without `--yes` on a non-TTY
MUST exit `11`.

### 7.4 Idempotency

Every verb marked "Yes" in §2.1 or §2.3 MUST be safe to call twice.
Specifically:
- `submit-intent` identity key: `(creatorMultisigAddress, desiredStateId)`.
  Re-posting the same key returns the existing on-chain intent id
  and exits `0`.
- `claim-rewards` zero-delta: pulling zero rewards is `exitCode: 0`,
  not `transient_error`.
- `fleet scale --to N` is target-state: running it twice with the
  same N is a no-op.
- `fleet retire <i>`: already-retired is a no-op.

`withdraw` is explicitly NOT idempotent; each invocation emits a
fresh sweep transaction.

### 7.5 Token resolution boundary

No verb other than `jinn version` and `jinn fund-requirements` MAY
emit a concrete token symbol or token contract address in its
output. All other verbs use role names (`native`, `bond`, `reward`).

### 7.6 Private internals

The following MUST NOT appear in any verb output:
- Environment variable names (`JINN_TESTNET_*`, etc.).
- Absolute file paths under `~/.jinn-client/` or the installation
  directory.
- Backend contract names (`JinnRouter`, `JinnDistributor`,
  `MechMarketplace`, `Safe`, `OLAS`, `stOLAS`).
- Internal module paths or class names.

Violations of any of these rules are defects.

## 8. Log line shape

`jinn logs` and the daemon's own stderr output use a single-line
JSON form:

```
{"ts":"2026-04-14T12:30:00Z","level":"info","component":"bootstrap","msg":"advanced","step":"service_staked","serviceIndex":0}
```

`ts`, `level`, `component`, `msg` are required. Anything else is
component-specific and agents MAY ignore it.

## 9. Versioning

- `schemaVersion: 1` is the initial published version.
- Additive changes (new verbs, new optional response fields, new
  `code` values) do NOT bump `schemaVersion`.
- Removing or renaming any verb, required field, `code` value, or
  role enum value bumps `schemaVersion` to `2` and requires a new
  dated spec file.
- The CLI MUST expose its supported `schemaVersion` via
  `jinn version` under `protocol.specVersion`.

## 10. Compatibility with legacy entrypoints

During transition, the existing `npm run start` / `npm run status` /
`npm run withdraw` entrypoints continue to function. They are
considered legacy and are not part of this spec's contract. A later
spec may retire them.

## 11. Open questions

- Whether `jinn logs` reads from a file, a socket, or the daemon's
  HTTP API. Not decided; does not affect the spec surface.
- Whether `keys backup` supports multiple output formats (plain
  mnemonic, JSON bundle). Defer to implementation.
- Exact wording of `attention.kind` strings. The enum is fixed but
  the `hint` text is free-form.
- How `jinn version` obtains the commit hash when running from a
  published npm package rather than a git checkout. Out of scope
  for v1.

## 12. References

- `docs/planning/2026-04-jinn-client-surface.md` — discovery and
  vocabulary design pass.
- `docs/planning/2026-04-jinn-mvl-on-olas.md` — protocol-level MVL
  proposal this spec aligns with on terminology.
- `client/src/config.ts` — current config resolution.
- `client/src/main.ts` — current entrypoint the CLI will wrap.
- `client/src/operator-errors.ts` — current friendly-message
  mapping the error envelope will supersede.

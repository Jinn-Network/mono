# client/ cleanup + architectural simplification

**Date:** 2026-04-28
**Bead:** jinn-mono-840
**Scope:** `client/` only. After PR #37 (envelope-v1), PR #38 (default-learning-restorer
→ claude-code-learner), and PR #42 (extension-model specs) landed in close succession.

Three layers, deepest-leverage first. Trivial fixes are applied inline on this branch
and noted under §3. Non-trivial findings are filed as child Tasks of `jinn-mono-840`.

---

## 1. Architectural simplification proposals

### 1.1 Two near-clone Claude-MCP session orchestrators
`client/src/restorer/impls/claude-mcp-prediction/session-orchestrator.ts` and
`client/src/restorer/impls/claude-mcp-prediction-apy/session-orchestrator.ts` are
~95% identical — only the MCP namespace, the submit-tool name, and a couple of log
prefixes differ. Both forked from
`client/src/restorer/impls/claude-mcp-hyperliquid/session-orchestrator.ts:97-209`
(itself a different shape — cadence + market-move trigger).

**Proposal:** extract a `BaseSingleSessionOrchestrator` taking
`{ allowedTools, submissionFlagName, logTag }` and have both prediction variants
configure it. Hyperliquid's cadence-driven loop stays as its own thing for now.

→ **Child Task** (filed below).

### 1.2 Identical "Plan D" verdict stub duplicated across three evaluators
The exact same five-line `verificationOfRestoration` placeholder appears in:

- `client/src/restorer/impls/prediction-v0-evaluator/index.ts:323-329`
- `client/src/restorer/impls/prediction-apy-v0-evaluator/index.ts:319-326`
- `client/src/restorer/impls/portfolio-v0-evaluator/index.ts:697-704`

Each carries identical `TODO(plan-d):` comments. The complementary
"verdict downgrade to REJECTED if `verificationOfRestoration.overall === 'invalid'`"
logic also exists once per evaluator path through
`client/src/restorer/engine/engine.ts:822-836`.

**Proposal:** factor a `verificationStub()` helper into
`src/restorer/engine/verification-stub.ts` so when Plan D lands there is exactly
one site to replace. Defer to the Plan-D Task; do not pre-build a full SDK shape.

→ **Child Task** (filed below).

### 1.3 Dual registry interface in `RestorationEngineOptions`
`client/src/restorer/engine/engine.ts:75-116` exposes both:

- `registry: RestorerImplRegistry` — interface with one method, `resolveImplName`
- `implRegistry?: { findFor(...): RestorerImpl | undefined }`

Engine.ts only *calls* `findFor` (line 433). `resolveImplName` is unused inside
the engine. `client/src/main.ts:626-641` wires the same `RestorerImplRegistry`
instance into both fields, with an existing
`TODO(jinn-mono-cy4): RestorationEngineOptions has redundant registry+implRegistry`
breadcrumb at `main.ts:627`. The `resolveImplName` method on the concrete class
(`registry.ts:96`) literally calls `findFor` and returns `.name`.

**Proposal:** drop the `RestorerImplRegistry` interface + the `registry` option
field. Keep `implRegistry` (or rename to `registry`) with `findFor`. No external
callers of `resolveImplName` exist in `src/`.

→ **Child Task** (filed below — closes / supersedes `jinn-mono-cy4`).

### 1.4 `claude-code-learner` is hard-wired as the universal first-match wrapper
`client/src/restorer/impls/index.ts:147-156` constructs the wrapper *last*
(so it sees all other impls as specialists) but registers it *first*, and
`wrapper.ts:47` returns `true` for every non-evaluation kind. Effect: every
restoration in production now runs through Orient/Strategize/Plan + specialist
+ Debrief/Improve/Memory phases — a structural architectural commitment that
isn't captured in the registry's dispatch config (`byKind` / `default` /
`disabled`) and is not operator-overridable without code changes.

**Proposal:** move "wrap with claude-code-learner" to a dispatch policy on
`RestorerImplRegistry` (e.g. a `wrapWith?: string` config field that
`findFor` honors). Operators who want raw specialist behavior — or to
benchmark the cost of the learning envelope — flip it off via config.

→ **Child Task** (filed below).

### 1.5 `discovery/` and `reputation/` both touch ERC-8004 with overlapping shape
After PR #37, `discovery/registry.ts` was deleted (-247 lines) and the
client now has:

- `client/src/discovery/identity-publisher.ts` (293 LOC) — ERC-8004 IdentityRegistry writes
- `client/src/discovery/agent-resolver.ts` (198 LOC) — agent ID lookups
- `client/src/discovery/subgraph.ts` (110 LOC, mostly stub) — subgraph reads
- `client/src/reputation/registry.ts` (624 LOC) — ERC-8004 ReputationRegistry client
- `client/src/reputation/feedback-hook.ts` (245 LOC) — engine integration

Both directories speak ERC-8004; the split was historical (validation registry
moved into `client/src/validation/`). No single `erc8004/` package owns ABIs +
addresses + clients.

**Proposal:** consolidate under `src/erc8004/{identity,reputation,validation}.ts`
sharing one address resolver + ABI table. Net effect is fewer cross-imports
between `discovery/`, `reputation/`, and `validation/`. Modest payoff — not
urgent — but the new boundaries set during PR #37 are the natural moment
to draw the line cleanly.

→ **Child Task** (filed below).

### 1.6 `discovery/subgraph.ts` is a stub returning empty results
`client/src/discovery/subgraph.ts:1-15` self-documents as a stub waiting for
the operator-rooted subgraph (`jinn-mono-fud`). It is still wired into
`daemon.ts` peer-discovery / remote-artifact backfill, silently returning `[]`.

**Proposal:** either (a) short-circuit at daemon-config level (skip peer-sync
when subgraph is the stub) so log lines reflect reality, or (b) fast-track
`jinn-mono-fud` once the new subgraph schema lands.

→ Linked to existing `jinn-mono-fud`; no new Task filed.

---

## 2. Code-hygiene proposals

### 2.1 Broken e2e: `test/e2e/portfolio-v0.ts`
`client/test/e2e/portfolio-v0.ts:61` imports `assembleAndSignManifest` from
`../src/restorer/engine/manifest-assembly.js`. That file was deleted in PR #37
(`client/src/restorer/engine/manifest-assembly.ts` removed, -144 lines, replaced
by `envelope-assembly.ts`). `yarn e2e-portfolio-v0` no longer runs — the import
fails at runtime. The main `tsconfig.json` excludes `test/`, so `yarn typecheck`
does not catch it.

**Proposal:** either port the e2e to `assembleAndSignEnvelope` (the V1 envelope
path) or delete it if the legacy portfolio loop is no longer the canonical path.
The newer `test/e2e/claude-code-learner-portfolio-v0.ts` may already supersede
its intent.

→ **Child Task** (filed below).

### 2.2 `TODO(build-info)` placeholders ship in real testnet envelopes
`client/src/restorer/engine/engine.ts:903-908` populates the executor block with:

```ts
implVersion: '1.0.0',
clientGitSha: 'dev',
codeDigest: 'sha256:' + '0'.repeat(64),
```

Two separate `TODO(build-info)` comments. These envelopes are anchored on-chain
via `claimDelivery(evidenceHash)`, so the placeholder values are persistent
public data. `scripts/write-dist-build-meta.mjs` already exists as the build hook;
plumbing it through is a small task.

→ **Child Task** (filed below).

### 2.3 `bin/jinn-mcp.ts` "temporary compatibility shim"
`client/src/bin/jinn-mcp.ts:3` documents itself as a temporary shim that
emits a deprecation line and forwards to `jinn mcp`. No removal date or
deprecation horizon is recorded. Either (a) date the shim with a target
removal release, or (b) delete it now if no callers remain on the old bin.

→ **Child Task** (filed below).

### 2.4 Stale "Plan N ships X — Plan M handles Y" doc comments (fixed inline)
PR #38 left planning-document language in source — e.g.
`restorer/impls/claude-code-learner/index.ts:7-8` ("Plan 2 ships shim … Plan 3
handles registry wiring") and `restorer.ts:18-22` ("Plan 2 supports() returns
true … Plan 3 wraps this"). Plan 3 has shipped (the wrapper is registered);
the comments rotted on merge.

→ **Fixed inline** on this branch.

### 2.5 "previous … was deleted with PR #37 cleanup" breadcrumbs (fixed inline)
PR #37 review-comment language survived into source comments at
`restorer/engine/engine.ts:925-930` and `intents/posting-service.ts:148-151`.
This is commit-message content; it rots as soon as one more PR lands on top.

→ **Fixed inline** on this branch.

### 2.6 `scripts/status.ts:80` typecheck error — `Property 'role' does not exist` (fixed inline)
`yarn tsc --noEmit -p tsconfig.test.json` failed on this single line:
`recentActivity` rows expose `kind`, not `role`. Trivial rename.

→ **Fixed inline** on this branch.

### 2.7 Repeated `TODO(self-bond)` and `TODO` in earning sweep paths
`client/src/earning/stolas-claim.ts:8` and `client/src/earning/orphan-sweep.ts:186`
both flag known follow-ups (Safe-batched claim for self-bond mode; sweep ERC-20
balances on abandoned Safes). Out of scope for the V1 envelope cleanup but
worth one tracking issue so they aren't forgotten when `staking_mode: self-bond`
gets exercised.

→ **Child Task** (filed below).

---

## 3. Mechanical cleanup

| Item | Resolution |
|------|------------|
| `yarn typecheck` (main) | Clean before and after this branch's edits. |
| `yarn tsc -p tsconfig.test.json` | Was failing on `scripts/status.ts:80` (TS2339 `role`). **Fixed inline**. |
| `yarn test` | 1634 passed / 2 skipped. |
| `yarn e2e-portfolio-v0` | **Broken** — see §2.1. Filed as child Task. |
| Stale planning-doc comments at PR #38 surfaces | **Fixed inline** — see §2.4 / §2.5. |
| Stale "previously … deleted with PR #37" comments | **Fixed inline** — see §2.5. |
| `TODO(plan-d)` comments × 3 evaluators | Tracked in §1.2. |
| `TODO(build-info)` × 2 in engine.ts | Tracked in §2.2. |
| Dead `RestorerImplRegistry.resolveImplName` | Tracked in §1.3. |

No lint script exists for `client/`; `yarn typecheck` is the only static gate.

---

## Out of scope

- Operator-experience audit — `jinn-mono-964`.
- Substrate-vs-specialists architectural fork — `jinn-mono-bea`.
- Pluggable-restorer implementation — `jinn-mono-7zz`.
- New ERC-8004 subgraph deploy — `jinn-mono-fud` (referenced in §1.6).

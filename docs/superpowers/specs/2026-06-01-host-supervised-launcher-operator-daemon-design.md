# Host the supervised launcher+operator daemon (clear the M1 supply gap)

- **Version:** 0.1
- **Date:** 2026-06-01
- **Author:** ritsu (drafted with Claude)
- **Status:** Proposed — output of a brainstorming session; implementation plan follows via `writing-plans`.
- **Shape:** `chore` (infra/ops) — resolves [#661](https://github.com/Jinn-Network/mono/issues/661).
- **Related:**
  - [#661](https://github.com/Jinn-Network/mono/issues/661) — the issue this spec resolves (and reframes; see §8).
  - [Milestone 1 tracker (#605)](https://github.com/Jinn-Network/mono/issues/605) — the gate this serves.
  - [#815](https://github.com/Jinn-Network/mono/issues/815) / [#901](https://github.com/Jinn-Network/mono/issues/901) — the AI-units cost-protection throttle (already shipped; see §5).
  - [#927](https://github.com/Jinn-Network/mono/issues/927) — update `check-milestone-1.ts` to the two-gate rule (the stale-criteria fix referenced in §8).
  - [#929](https://github.com/Jinn-Network/mono/issues/929) — re-pin M2 to claude-code + Haiku.
  - [#792](https://github.com/Jinn-Network/mono/issues/792) — agent-EOA nonce race (why one wallet must run in one process).
  - [`deploy/railway-operator-codex/README.md`](../../../deploy/railway-operator-codex/README.md) — the existing recipe this generalizes from.

## 1. Problem

Milestone 1 ("48 hours of paired settlement", [#605](https://github.com/Jinn-Network/mono/issues/605)) requires, for 8 consecutive UTC-aligned 6h blocks: every block has ≥2 distinct operators each earning ≥2 tJINN, plus a 48h aggregate of ≥30 tJINN/operator. The clock resets the moment any block fails.

The binding constraint is **supply liveness**, not operator count. The 2026-05-27 00:00–06:00 UTC block failed because the SWE-rebench v2 **task generator paused for ~20.5h** ([#605 read-of-snapshot](https://github.com/Jinn-Network/mono/issues/605)): 0 tasks created, 0 attempts, 0 verdicts — the pipeline was silent end-to-end. When no tasks are being created, every operator starves and the block fails regardless of how many daemons are staked. (Conditional pass rate is already 100% whenever ≥2 services are even registered — [#637](https://github.com/Jinn-Network/mono/issues/637) — so the activity checker is not the bottleneck.)

That generator runs today on a **local machine, started manually**. Laptop sleep, reboots, network drops, or simply forgetting to restart it produce supply gaps that fail blocks and reset the 48h clock. A single unsupervised machine is the single point of failure for the whole network's task supply.

A secondary concern: the operator's claude-code/Haiku solver should run always-on **without redlining the Claude subscription's weekly cap**. (As of [#929](https://github.com/Jinn-Network/mono/issues/929) the always-on fleet has standardized on claude-code + Haiku for zero-marginal-cost operation.)

## 2. Goal / Non-goals

**Goal.** Move the operator's existing local daemon — which is *both* the SWE-rebench v2 launcher/generator *and* a solver, on one identity — onto a **supervised, always-on, independently-networked host** so task creation never gaps again, with the solver side bounded to a sustainable share of the Claude subscription.

**Non-goals.**
- Building a throttle. The cost-protection throttle already exists and is well-calibrated (§5).
- Standing up *additional* operators. The original #661 framing (more operators) is superseded by the supply-liveness diagnosis (§8). The second distinct operator M1 needs comes from the existing fleet on independent infra.
- Supply redundancy via a second independent launcher. That requires a second wallet + second launch; recorded as a future enhancement (§7).
- Root-causing the epochs 946–964 simultaneous dropout — tracked separately ([#917](https://github.com/Jinn-Network/mono/issues/917), [#580](https://github.com/Jinn-Network/mono/issues/580), [#925](https://github.com/Jinn-Network/mono/issues/925)).
- Activity-checker tuning (conditional pass rate is 100%).

## 3. Topology: one daemon, one wallet, both roles

The operator's local launcher and solver are **the same daemon process and the same wallets**, confirmed in code:

- On startup the daemon walks `~/.jinn-client/solvernets/launched/` and, for each owned record where `status === 'launched' && generatorEnabled === true`, spawns the matching generator ([`client/src/main.ts:2376`](../../../client/src/main.ts), gate at [`client/src/solver-types/swe-rebench-v2.ts:834`](../../../client/src/solver-types/swe-rebench-v2.ts)).
- The *same* `jinn run` process claims as a solver via its `joinedSolverNets` config entries.
- Both roles act through the daemon's single agent EOA + service Safe.

Self-solving is an **anticipated, legitimate mode**, not a workaround: [`client/src/adapters/mech/adapter.ts:585-595`](../../../client/src/adapters/mech/adapter.ts) — "the creator running the solver role is legitimate … the creator later claims its own task" (when `maxClaims > 1`).

**Implication:** because the two roles share a wallet, they *must* run in one process. Splitting one key across two processes/boxes causes nonce races ([#792](https://github.com/Jinn-Network/mono/issues/792)). So the deliverable is a **single hosted daemon**, not a launcher box plus an operator box. The generator makes no LLM calls, so co-locating the solver does not change the generator's behavior; only the solver side draws the subscription, and that is already throttled (§5).

## 4. Design: generalize the codex recipe to a hosted claude-code/Haiku daemon

The committed [`deploy/railway-operator-codex/`](../../../deploy/railway-operator-codex/README.md) recipe already runs the full `jinn run` (all roles, one process, Railway volume at `/data`, `restartPolicyType=ON_FAILURE` × 10, config-as-code at `deploy/railway-operator-codex/railway.toml`). It is **solver-only** today (joins SWE-rebench v2 as `roles: ["solver"]`; no launched record → no generator) and **codex-specific** (installs the Codex CLI, injects `CODEX_AUTH_JSON`).

This spec generalizes it into a **claude-code/Haiku launcher+solver recipe**. New directory: `deploy/railway-launcher-operator/` (fork; leave the codex recipe in place as a reference). Changes from the codex recipe:

1. **Auth swap.** Drop the Codex CLI from the image; inject `CLAUDE_CODE_OAUTH_TOKEN` (base64 or raw, per Railway secret conventions) instead of `CODEX_AUTH_JSON`. The Claude CLI is already in the runtime stage. This single token both authenticates Haiku *and* keeps the AI-units throttle engaged headless (§5).
2. **Launched record materialization.** The box must carry the operator's owned SWE-rebench v2 launched record at `~/.jinn-client/solvernets/launched/<manifestCid>.json` with `status: "launched"` and `generatorEnabled: true`, so the generator spawns on boot. The launched dir resolves under `config.earningDir` (`solvernets/launched`, [`client/src/main.ts:2393`](../../../client/src/main.ts)). **Open decision for the plan:** materialize from an env var (mirrors `CONFIG_TEMPLATE_JSON`, durable on the volume after first boot) vs. ship on the volume directly. Recommendation: env var for parity with the existing config-seed pattern.
3. **Config.** `CONFIG_TEMPLATE_JSON` includes the `joinedSolverNets[<cid>]` entry (with the load-bearing `contract: { id, version }` field — [#674](https://github.com/Jinn-Network/mono/issues/674)), `harness: "claude-code"`, `model: "claude-haiku-4-5-20251001"`.
4. **Vetted pool artifact.** The generator runs in admission mode `required` and needs the validated pool ([`client/src/solver-types/_swe-rebench-v2-validated-pool.ts:713`](../../../client/src/solver-types/_swe-rebench-v2-validated-pool.ts)). **Open decision for the plan:** fetch from IPFS at boot (the launch publishes it) vs. carry on the volume. Recommendation: IPFS-fetch at boot so the box is reproducible and the artifact is not duplicated into env/volume.
5. **Keystore.** The operator's single wallet keystore + `JINN_PASSWORD` as Railway secrets, durable on the volume.
6. **Funding + Stage-1 faucet gap.** Fund the agent EOA with Base Sepolia ETH (gas + task-creation fees) and the Safe with OLAS for the bond. `JINN_AUTO_TESTNET_FAUCET=1` only fires inside Stage 2, so a cold-start zero-balance EOA stalls at `awaiting_funding` ([`deploy/railway-operator-codex/README.md`](../../../deploy/railway-operator-codex/README.md) §First-boot funding). For a **wallet migration** (§6) this is moot — the wallet is already funded and staked. For a fresh wallet, drip the EOA manually past the Stage-1 minimum first. (The "auto-faucet should cover Stage 1" sub-fix is filed as its own follow-up; not in scope here.)
7. **Supervision + heartbeat.** Keep `restartPolicyType=ON_FAILURE`. Add a liveness signal so a silent stall (process up but not creating tasks) is detectable — minimally, alert on extended absence of `JinnEmitted`/task-creation activity. **Open decision for the plan:** reuse an existing daemon health signal vs. an external uptime check on the indexer's task-creation rate.

## 5. The throttle is already shipped (verify, don't build)

The cost-protection throttle is [#815](https://github.com/Jinn-Network/mono/issues/815)'s **AI-units claim gate** ([`client/src/daemon/ai-units-gate.ts`](../../../client/src/daemon/ai-units-gate.ts), calibration in [`client/src/spend/ai-units.ts`](../../../client/src/spend/ai-units.ts)). It is purpose-built for this: "the universal cost language for the M1 cost-protection throttle", pegged so 100 units = 10% of a 6h-block-equivalent spend on the GPT-5.4-mini baseline.

- **It engages automatically for claude-code.** `resolveCredentialId('claude-code', …)` returns `anthropic:subscription` when `CLAUDE_CODE_OAUTH_TOKEN` is set, `ANTHROPIC_API_KEY` is set, or `~/.claude/` exists on disk ([`client/src/spend/credential.ts`](../../../client/src/spend/credential.ts)). [#901](https://github.com/Jinn-Network/mono/issues/901) added on-disk detection specifically "so stock subscription installs get a credential and the AI-units gate engages by default", and corrected the earlier "subscription = 0 units" bug so subscription-auth harnesses *are* metered.
- **Default calibration is already on target.** Haiku 4.5 costs `(50k × $0.001/1k) + (20k × $0.005/1k) = $0.15/task` ([`client/src/harnesses/cost-estimates.ts`](../../../client/src/harnesses/cost-estimates.ts)) → `0.15 / 0.5 × 100 = 30 AI units/task`. At the default ceiling of **100 units/block** (`REFERENCE_CEILING`, [`ai-units.ts:49`](../../../client/src/spend/ai-units.ts)) that is **~3 attempts per 6h block** — right on the M1 calibration target (~1–2 attempts → ~2 tJINN) — and ~2800 units/week ≈ 10% of a baseline weekly cap by construction. (The "~1 unit/task" comment in `ai-units.ts` is stale relative to the current cost table.)
- **Tunable with one env var** if ~3/block proves wrong in practice: `JINN_AI_UNITS_CEILING_OVERRIDE=<perBlock>` (weekly auto-scales to 28×), or `<block>:<week>` for both ([`ai-units.ts:110`](../../../client/src/spend/ai-units.ts)).
- **The headless caveat that matters:** on a Railway box there is no `~/.claude/`, so the recipe **must** inject `CLAUDE_CODE_OAUTH_TOKEN` — otherwise the credential does not resolve, `buildAiUnitsConfig` returns `undefined`, and the gate is silently **off** (unbounded subscription burn). On the local laptop the gate is on automatically.

**Verification (not implementation):** confirm the daemon logs `[ai-units] cap=100/2800 per (block, week)` at boot ([`client/src/main.ts:2488`](../../../client/src/main.ts)), and observe `ai_units_cap_reached` pause/resume behavior across a block boundary.

## 6. Migration: cutover, not parallel

It is the **same wallet**, so it cannot run on the laptop and on Railway simultaneously (nonce races + double-claiming). The migration is a cutover that preserves the existing staked service:

1. Stop the local daemon.
2. Move the keystore, `earning/` state (so the staked service ID is preserved), the SQLite db, and the launched record onto the Railway volume (or seed them via the recipe's env/volume mechanisms).
3. Start on Railway. Confirm the staked service re-appears in `getServiceIds()` and the generator resumes creating tasks.

Reusing the wallet keeps the existing stake/service history. A fresh wallet would mean re-bootstrapping and re-staking (loses history) and is not recommended.

## 7. Tradeoffs & risks (recorded, not hidden)

- **Supply single-point-of-failure.** This one box is now the sole task creator; if it dies, supply stops once the task backlog drains (each task allows `maxClaims` attempts, so there is a buffer). Mitigation: `ON_FAILURE` restart + heartbeat alert + the backlog buffer. The *second* distinct operator M1 requires is provided by the fleet on independent infra, so a single incident on this box does not evict all presence — but it does eventually starve supply, which is why supervision + alerting are load-bearing, not optional.
- **Future supply redundancy.** True supply resilience needs a *second* independent launcher with its own wallet and its own launch (so two creators on different infra). Out of scope here; note it as a follow-up if a single supervised box proves insufficient.
- **OAuth token on a server.** Hosting headless puts a Claude OAuth token in Railway secrets. Accepted tradeoff (same posture as the codex recipe's `CODEX_AUTH_JSON`).
- **Self-solving optics.** The operator both creates and solves on one identity. Legitimate per §3, but note that for M1 "≥2 distinct operators" the operator counts as one; the network still needs a genuinely distinct second operator (the fleet) to pass.

## 8. Issue reconciliation (#661)

Per the engineering handbook's "issues frame problems, not solutions", [#661](https://github.com/Jinn-Network/mono/issues/661) over-prescribed *more operators* when the binding constraint is supply liveness. This spec resolves #661 by reframing it around hosting the supply-critical daemon. Two clean-ups to fold in:

- **#661's acceptance criteria are stale.** They reference the retired "trailing paired streak ≥ 115 checkpoints (≈20%)" rule. M1 was reframed (2026-05-28) to the two-gate tJINN criterion. Recommend updating #661's acceptance language to point at the current rule, and cross-reference [#927](https://github.com/Jinn-Network/mono/issues/927) (which updates `check-milestone-1.ts` from the interim 2026-05-27 single-gate rule to the two-gate rule — `client/scripts/check-milestone-1.ts` still encodes the interim rule today).
- **Service 62 already satisfied the original "≥1 new daemon" clause** (codex, 2026-05-26). The remaining value of #661 is the supply-liveness migration above, not net-new operators.

## 9. Acceptance criteria

- A `deploy/railway-launcher-operator/` recipe (Dockerfile without the Codex CLI; entrypoint materializing keystore + launched record + config; `railway.toml` with `ON_FAILURE` + config-as-code path) plus a README runbook, on `next`.
- The operator's daemon runs on a supervised Railway service: generator creating SWE-rebench v2 tasks continuously, solver claiming within the AI-units cap, single wallet/identity preserved from the local setup.
- Boot log shows `[ai-units] cap=…` (gate engaged headless via `CLAUDE_CODE_OAUTH_TOKEN`).
- No task-creation gap across a full 24h once cutover completes (verified against the indexer's task-creation rate).
- A note appended to #661 recording the service ID(s), host, supervision setup, and the auth/throttle configuration.
- #661's stale acceptance criteria updated (or a one-line pointer to #927).

## 10. Open questions for the implementation plan

1. Launched-record delivery: env-seed (recommended) vs. volume.
2. Vetted pool artifact: IPFS-fetch at boot (recommended) vs. volume.
3. Heartbeat/liveness: reuse an existing daemon health signal vs. external uptime check on task-creation rate.
4. `CLAUDE_CODE_OAUTH_TOKEN` provisioning on a headless box — confirm the token format the `claude` CLI accepts non-interactively, and its refresh/expiry behavior (does it survive container restarts, or need periodic refresh?). This is the highest-risk unknown for headless operation.
5. Whether to keep the codex recipe as-is or deprecate it once the claude-code recipe lands.

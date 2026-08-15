# Changelog

## Unreleased

### BREAKING: learner `codeDigest` migrates to the `learner-public.v1` profile (issue #2118)

- **Every `codeDigest` the learner harness produces changes value.** The freeze
  fence, the delivery envelope, the daemon status panel, and the commit→digest
  revert helper now hash `implStateDir` under one named profile instead of three
  different ad hoc exclusion sets. `learner-public.v1` excludes `.git/`,
  `operator-requests/`, `secrets/`, and `transcripts/`; every other top-level
  path is classified against the ratified table and anything unclassified — plus
  any symlink or special file — fails closed rather than being silently skipped.
- **Pre-migration on-chain digests remain valid history and are permanently
  non-joining.** Nothing is rewritten; no procedure converts a digest across the
  boundary.
- **Operator action: none in the ordinary case** — automatic on upgrade. The one
  exception is an impl-state directory carrying an unclassified top-level path,
  which now raises a `HashProfileViolationError` naming the path.
- Full note, including the version boundary and the remedy:
  [`docs/runbooks/learner-public-v1-digest-migration.md`](../docs/runbooks/learner-public-v1-digest-migration.md).

### Embedded agent surface hidden by default (issue #326)

- **The embedded Claude agent chat surface no longer renders in the operator
  app by default.** The right-rail agent panel (running mode) and the
  "Ask Claude" panel (onboarding) are hidden. The 2026-05-19 v0.1.6 dogfood
  found the surface isn't robust enough for first-time operators — it is the
  only daemon-side surface that strictly requires Claude auth, and its
  action-authority / plugin-scope shape is still in design (#177 / #178).
- **Feature flag: `JINN_ENABLE_EMBEDDED_AGENT`.** Set
  `JINN_ENABLE_EMBEDDED_AGENT=1` (also accepts `true`) to re-enable the
  surface for development. Default is off. When off, the daemon does not
  mount the `/api/agent/ws` bridge and the SPA renders no agent panel; when
  on, the dev-time path works end-to-end as before. (Issue #367: the SPA now
  reads this flag through the injected `window.__JINN_FEATURES__`, the same
  channel as the plug-in builder UI flag — no behaviour change for operators.)
- **Claude-Code-as-a-solver-harness is unaffected.** Operators can still pick
  Claude Code as their SolverNet harness — that path is independent of the
  embedded chat surface and its WebSocket bridge.

### Operator app

- **Plug-in builder UI surfaces hidden by default (issue #327).** The `/build`
  route and the Build top-tab no longer appear in the operator app. Hitting
  `/build` by direct URL redirects to `/overview`. The plug-in substrate stays
  fully live — `jinn solver-plugins publish` / `revoke`, the Ponder indexer,
  the Discovery API endpoints, and the `operator/docs/build/` tree are
  unchanged, so direct-CLI builders following the docs are not blocked. The
  surfaces are gated to keep the operator-app first-run UX focused; they will
  be re-promoted once that UX is solid and plug-in indexing is end-to-end
  populated. Set `JINN_ENABLE_PLUGIN_BUILDER_UI=1` on the daemon to re-enable
  the full builder surface for development and design work — the daemon injects
  the flag into the SPA via `window.__JINN_FEATURES__`.

### SWE-rebench v2 admission

- **Admission semantics bumped from `'2'` → `'3'`.** Operators running the
  public/launched generator MUST re-validate before posting resumes:

  ```bash
  jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad
  ```

  Expected duration: ~1-2h (one gold-patch eval per seed instance).
  Until re-validation runs, the launched generator posts no new tasks
  (admission required; `jinn doctor` reports the pool as stale).
  Note: the seed pool contains 20 instances from common Python repos; typical
  admission rates are 25-40%, so expect 5-8 scorable entries after re-validation.
  Operators can extend the seed list via PR over time.
- **Required admission mode is now the default for launched generators.**
  Local/dev users running `admissionMode: 'python-floor'` keep today's
  behaviour. `jinn doctor` reports pool freshness and prints the exact
  re-validation command when stale.
- **Verdict-time substrate recheck** catches drift between admission and
  grading. Any mismatch (rowHash, imageDigest, HF outage) skips the verdict
  rather than emitting a misclassified FAIL.

## v0.1.5 — Operator App

_Released 2026-05-13_

# v0.1.5 — "Operator App"
2026-05-13 · Suggested bump: patch (first npm `@latest` cut that ships the app-first operator experience)

## Highlights

- Release plumbing fixed so the cut can actually ship. `npm-publish.yml` now installs `contracts/` before the operator gate, the Docker/GHCR workflow accepts the new `v<semver>` tag format alongside legacy `client-v*`, and the CHANGELOG mirror writes through a PR (no more failed direct push to protected `main`).
- SWE-rebench v2 verdict path is structurally correct end-to-end. The eval loop no longer emits verdicts on non-gradeable evals (uy6v.8), the daemon's `verdictCode` default is `Invalid`, not `Pass` (uy6v.7), evaluator-side gating now surfaces a real verdict so the reputation feedback hook fires (uy6v.10), and the `evaluation:<cid>` MetadataSet is published on verdict delivery (n93o).
- Per-operator disks no longer fill in a couple of weeks. The SWE-rebench v2 eval-image cache is bounded by an in-process LRU (uy6v.11).
- Operator app feedback on issue 188 addressed across overview / launcher / catalog / configuration / shell, with dashboard tests refreshed.
- Daemon execution envelope now carries the executor model (`gbut`), giving downstream consumers the model that produced each Solution / Verdict.
- Discovery API no longer 404s for just-launched manifests when no subgraph is configured (#170) — important for fresh launcher records.

## Recovery context

v0.1.4 published as a GitHub Release at `fa8da678` but the npm-publish workflow failed before publish in `release:operator-gate` because contracts dependencies were not installed in the clean Actions checkout. The fix landed as PR #187 *after* the v0.1.4 tag was created, so the v0.1.4 release commit could not retry publish. v0.1.5 cuts from current `main` (`56e84952`) which includes that fix; `@jinn-network/client@latest` becomes `0.1.5` (replacing the stale `0.1.2`). v0.1.4 remains as a Build Notes Release; no `0.1.4` npm artifact exists.

## Changes

### feat
- (#189) feat(uy6v.11): bound swe-rebench-v2 eval-image cache with in-process LRU — @ritsuKai2000
- (#194) feat(gbut): publish executor.model in jinn.execution.v1 envelope — @ritsuKai2000

### fix
- (#170) fix: /v1/solvernets/registry/:cid 404s for just-launched manifests when no subgraph is configured — @ritsuKai2000
- (#183) fix(uy6v.8): SWE-rebench v2 eval loop — no verdicts on non-gradeable evals; source-only patches — @ritsuKai2000
- (#185) fix(release): unblock v0.1.4 publish — @ritsuKai2000
- (#187) fix(release): install contracts before operator gate — @ritsuKai2000
- (#190) fix(uy6v.10): emit verdict in swe-rebench-v2 gating so reputation hook fires — @ritsuKai2000
- (#193) fix(uy6v.7): daemon verdictCode default — Invalid not Pass — @ritsuKai2000
- (#197) fix(n93o): publish evaluation:<cid> MetadataSet on verdict delivery — @ritsuKai2000

### chore
- (#208) chore(2cl.20): bump operator/package.json to 0.1.5 — @ritsuKai2000

### docs
- (#165) docs: clarify terminal unresolved verdicts — @ritsuKai2000
- (#195) docs(uy6v.6): DR — keep self-eval bypass on testnet; revert is a mainnet gate — @ritsuKai2000

### test
- (#168) test: Real-daemon Playwright e2e: lifecycle + operator catalog + empty states + crash recovery (scenarios 2-5) — scenarios 2-4 — @ritsuKai2000
- (#207) test: align verdict code fallback expectation — @ritsuKai2000

### other
- (#192) [codex] address operator dashboard issue 188 feedback — @ritsuKai2000

## Closed this week

- jinn-mono-uy6v.8 (SWE-rebench v2 eval loop — verdicts on non-gradeable evals)
- jinn-mono-uy6v.6 (DR — keep self-eval bypass on testnet)
- jinn-mono-uy6v.9 (Unscorable instances in dataset — quantified)
- jinn-mono-2cl.20.1 (Discovery-stack scope mismatch before release draft)

## Stats

- Window: v0.1.4 → HEAD (2026-05-13)
- 14 commits · 72 files changed, 4444 insertions(+), 772 deletions(-) · 15 PRs · 1 contributor

## Known issues

- jinn-mono-uy6v.7 (Live verdict-success + JINN reward distribution): in_progress. Verdict path is now structurally correct and emitting, but live observation of JINN reward distribution to operator wallets is still gating the v1 public-testnet ship (separate from this Build Notes cut).
- jinn-mono-uy6v.10 (Reputation-feedback hook): PR #190 makes the feedback hook fire on swe-rebench v2 verdicts; live on-chain registry update observation still pending closure.
- jinn-mono-uy6v.11 (Eval-image cache): PR #189 bounded the cache via in-process LRU; long-running operator disk validation still pending closure.

<!-- jinn-release-evidence:v1
release-tag=v0.1.5
release-commit=56e849525ebdbc8efc5a99a8255cead613ef7d80
release-client-prepare=passed
donation-consumption=passed
app-first-testnet-acceptance=passed
-->

## v0.1.4 — Shipping Machine

_Released 2026-05-12_

2026-05-12 · Suggested bump: patch (Captain: override to vX.Y+1.0 if an epic closed in this window)

### Highlights
- Operator onboarding: `jinn run` now owns first-run setup, including keystore-password generation and app-driven Claude sign-in for bare-host operators.
- Discovery API and hosted-subgraph removal: the client now follows the on-chain-first path from the merged 280n stack.
- Engineering handbook v1: the shipping-machine SOP, release-note scaffold, cadence correction, and Run-mode chore conventions are now exercised by a real cut.
- SWE-rebench v2 donation prep: package and gate work for donated execution-data consumption is included, with release gates run before publish.

### Changes

#### feat
- (#63) feat(client): Phase A.2 plug-in surface — @jinn-network/restorer-sdk + Path 1 slot registry + 9 worked examples — @ritsuKai2000
- (#139) feat(2cl.16): auto-close bd issues referenced in merged PR body — @ritsuKai2000

#### fix
- (#131) fix: purge canonical-plugin traces from operator surfaces (jinn-mono-l2zl.15.4.2) — @ritsuKai2000
- (#132) fix(2cl.13): correct bd JSON field references in bd-mirror — @ritsuKai2000
- (#147) fix: friday-triage.yml YAML parse error (embedded python dedent) — @ritsuKai2000
- (#149) fix(2cl.19): Monday scaffold — squash-merge enumeration + stats line + closed-bd list — @ritsuKai2000

#### refactor
- (#153) refactor(280n): land #138/#150 hosted-subgraph removal stack — @ritsuKai2000

#### chore
- (#133) chore(2cl.6): dual-tag releases with v2026.MM.DD alongside v<semver> — @ritsuKai2000
- (#135) chore(2cl.7): harden release gates without slowing canary — @ritsuKai2000
- (#136) chore(2cl.15): allow .claude/skills/ to be tracked in git — @ritsuKai2000
- (#137) chore(2cl.17): document Run-mode declaration convention — @ritsuKai2000
- (#148) chore: drop bd-close-on-merge workflow (manual bd close suffices) — @ritsuKai2000
- (#152) chore: prep v0.1.4 release — @ritsuKai2000

#### docs
- (#66) docs: reconcile Phase 1b roadmap under Phase A umbrella — @ritsuKai2000
- (#128) docs: engineering handbook v1 design + engineering-substrate DR — @ritsuKai2000
- (#146) docs: spec — realign GROWTH §3 around ecosystem builders on the leading open agentic harness + ERC-8004 — @oaksprout

#### test
- (#89) test(engine): cross-impl artifact-row invariant (jinn-mono-6ig7) — @ritsuKai2000

#### other
- (#61) Fix npm publish workflow Foundry setup — @ritsuKai2000
- (#64) Phase A.1: corpus library + gating fix + manifest hygiene + sha256 cache + MCP rewiring — @ritsuKai2000
- (#65) Automatic Base Sepolia earning setup migration — @ritsuKai2000
- (#70) Growth skill stack: cluster-model, growth-watcher, twitter-strategy, growth-day, plus canon promotions — @oaksprout
- (#71) [codex] Improve operator onboarding dashboard flow — @ritsuKai2000
- (#72) [codex] Complete Task and SolverNet migration — @ritsuKai2000
- (#73) growth-day auto-invokes stale feed routines + freshness stamps — @oaksprout
- (#74) Glossary: JINN/veJINN casing rules; ignore growth recruitment docs — @oaksprout
- (#75) [codex] Add one-click Claude Code install — @ritsuKai2000
- (#76) [codex] Implement task-native SolverNet lifecycle — @ritsuKai2000
- (#77) [codex] Implement prediction SolverNet v1 SDK surface — @ritsuKai2000
- (#78) [codex] Deliver Prediction SolverNet task lifecycle phase — @ritsuKai2000
- (#79) [codex] Add Prediction SolverNet Brier scoreboard — @ritsuKai2000
- (#80) Prediction SolverNet operator UX diagnostics — @ritsuKai2000
- (#81) [codex] Surface Prediction dashboard status — @ritsuKai2000
- (#82) [codex] Add Network Tools prediction learner plugins — @ritsuKai2000
- (#83) growth: 2026-05-04 recruit log + Tier A/B/C ranking for growth-day — @oaksprout
- (#88) Operator app: Overview + Configuration page split (operator-shakedown) — @ritsuKai2000
- (#90) growth-day: enforce active-sprint precondition + warm-contacts ladder — @oaksprout
- (#91) Add jinn-adjacent cluster frame and Sprint #1 recruitment learnings — @oaksprout
- (#93) SPEC: tokenomics; canonical-doc process via GitHub Discussions — @oaksprout
- (#94) plugin: simplify claude-code-learner + decouple from Jinn vocabulary — @ritsuKai2000
- (#95) growth: canonical restructure — populate §3, add GTM/channel/sprint sections, cluster-aware skills — @oaksprout
- (#101) [codex] add jinn activity tabs — @ritsuKai2000
- (#102) Agent-harness SolverNet: freeze-mode + SWE-rebench v2 + train/frozen leaderboard — @ritsuKai2000
- (#104) growth: §3 niche+pitch+bridge rewrite, §6.1 token-tolerance rule (PMF-search refinement) — @oaksprout
- (#106) growth: pin §7 currently-testing to swe-rebench v2 (follow-up to #104) — @oaksprout
- (#107) growth: §3 tighten to OSS coding agent contributors + pin swe-rebench v2 + skill hardening — @oaksprout
- (#108) growth + decision: lock swe-rebench v2 as the operational launch SolverNet (DR-2026-05-07-h) — @ritsuKai2000
- (#109) Plan 4 Phase 0+1: capture envelope schema + OTLP receiver + scrub processors — @ritsuKai2000
- (#111) growth: §5 Engage — three ways in → four ways in (contributor) — @oaksprout
- (#112) Revise README for clarity and additional instructions — @oaksprout
- (#121) brand: canonical introduction + stake-claiming voice rule — @oaksprout
- (#123) [codex] Implement telemetry capture publish and readable donation path — @ritsuKai2000
- (#124) Prepare SWE-rebench v2 donation flow for public testnet — @ritsuKai2000
- (#125) Fix canary packaging and daemon liveness blockers — @ritsuKai2000
- (#126) Prepare SWE donation flow for public testnet release — @ritsuKai2000
- (#127) Fix SWE typed payload fallback validation — @ritsuKai2000
- (#134) discovery: DiscoveryAPI interface + OnchainDiscoveryAPI floor + callsite migration — @ritsuKai2000
- (#172) Fix Docker acceptance build context — @ritsuKai2000
- (#184) Fix Docker testnet acceptance gate — @ritsuKai2000

### Closed this week
- jinn-mono-280n.1
- jinn-mono-2cl.13
- jinn-mono-2cl.15
- jinn-mono-2cl.16
- jinn-mono-2cl.17
- jinn-mono-2cl.19
- jinn-mono-2cl.6
- jinn-mono-2cl.7
- jinn-mono-9a4d
- jinn-mono-pgjj
- jinn-mono-uy6v.7

### Stats
- Window: client-v0.1.3 → HEAD (2026-05-12)
- 122 commits · 1278 files changed, 189811 insertions(+), 37079 deletions(-) · 58 PRs · 2 contributors

### Operator-facing notes
- A brand-new operator can run `jinn run` with no env var, no setup, and no input; the daemon now generates a local keystore password when needed and opens the app while bootstrap continues.
- Host operators sign in through the app with `Sign in with Claude`; Docker/container modes still surface the appropriate CLI command because the daemon cannot reach the operator's host browser.
- The old `jinn quickstart` verb has been removed; `jinn run` is the supported zero-to-running path.

### Known issues
- The v1 public-testnet milestone (`jinn-mono-uy6v`) is not included in this cut; it remains the next major waypoint, with open P0 work still tracked separately.
- This is a weekly patch Build Notes release, not a v1 graduation or the `jinn-mono-uy6v` milestone.

## 0.1.3

- Added the v0 testnet cross-chain JINN claim loop, including bundled Sepolia/Base Sepolia MVI deployment artifacts, MockMessenger burn-in support, and canonical OP-Stack verifier canary tooling.
- Added Safe v1.3 inner-revert decoding so permanent claim and delivery races stop retrying with generic `GS013` errors.
- Updated bundled Phase 1b deployment defaults for the proxy-deployable V2 activity checker and JINN MVI testnet stack.
- Added release-gate coverage for contract tests, storage-layout drift checks, and Foundry invariant harness compilation.
- Hardened the local operator release gate for the current adapter API, ERC-8004 stubbed subgraph surface, and forked-chain `setAgentWallet` deadlines.
- Switched the docker testnet acceptance gate from legacy health-check intents to the auto-generated `prediction.v0` loop. The gate now requires both restoration and evaluation success per cycle, gates on cycles produced after `runStartAt`, and uses tighter cycle-shaping params (`JINN_PREDICTION_V0_WINDOW_MS=120000`, `JINN_PREDICTION_V0_RESOLVE_GAP_MS=60000`) so a full restoration→delivery→evaluation→claim round-trip lands inside the 20-minute timeout.

## 0.1.2

- Replaced the `mech-client-ts` IPFS upload dependency with the client’s own Autonolas registry upload path, reducing the packed install footprint and removing the deprecated js-IPFS transitive chain from the release artifact.
- Updated the optional Coinbase CDP SDK used for testnet faucet support.
- Added `jinn intents enable --impl <name>` plus `jinn intents reset <kind>` so operators can switch intent implementations without hand-editing config.
- Removed the default legacy health-check desired state; testnet now relies on the deterministic auto-generated `prediction.v0` intent path by default.
- Added graceful legacy Claude skip behavior (`claude_unavailable`) when auth/quota blocks health-check restoration attempts.
- Fixed no-install invocation so `npx @jinn-network/client@<version> <verb>` works directly via a `client` bin alias.
- Added canonical `jinn mcp` command and kept `jinn-mcp` as a deprecation shim.
- Extended package smoke tests to validate both direct `npx` and legacy `npx -p ... jinn ...` execution paths.
- Includes prior validated canary fixes now rolled into stable:
  - PR #21 default Base Sepolia ClaimRegistry
  - PR #22 idempotent replayed `claimDelivery`
  - PR #23 prediction evaluator support for signed engine manifests

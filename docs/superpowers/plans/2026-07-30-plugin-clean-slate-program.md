# Jinn Plugin Clean-Slate Program

> **For agentic workers:** this is the coordination plan. Implementation runs through the
> component plans in §1, each authored to the superpowers:writing-plans conventions
> (bite-sized tasks, TDD, checkbox steps) and executed with
> superpowers:subagent-driven-development or superpowers:executing-plans. Do not implement
> from this document alone.

**Goal:** implement
[`../specs/2026-07-30-plugin-stack-reconciliation-design.md`](../specs/2026-07-30-plugin-stack-reconciliation-design.md)
(v0.1, reviews resolved, DR pending) — the clean-slate Jinn Plugin built stack-native in
the integration branch, the two platform surfaces it commissions, and the channel cutover
that retires the frozen 0.1.2 trio.

**Architecture:** two new platform packages (a tier-2 sealed trajectory record kind and a
tier-3 native-trace decoder) complete an existing half-contract — the launchers declare
trace format IRIs that nothing can read. On top of them, a new tier-4 product tree hosts
one small stack-composed runtime (capture via the execution recorder and local runtime;
a public-corpus mirror via the discovery client; retrieval and trust filtering; product-side
relevance and projection) exposed over MCP, plus a thin Hermes adapter carrying only what
lives in host hooks. The published trio is frozen throughout and retired only after the
install channel cuts over.

**Tech stack:** TypeScript / Node 22 / Yarn with `portal:` resolution; vitest; SQLite
(`better-sqlite3`, FTS5); MCP (`@modelcontextprotocol/sdk`); Python for the Hermes adapter;
the stack conformance kits.

## Global constraints

- **Branch target:** `integration/evidence-v1` (stacked PR trains; the integration branch
  is not yet in `next`).
- **Kits and fixtures before implementations**; a layer's kit green before dependents build
  on it (principles §9).
- **Guard trio** (package inventory, source-boundary allowlist, packed-types canary + CI
  workflow) ships **with** each new tree, not after (principles §10).
- **The frozen trio is untouchable.** No component may import `@jinn-network/core`,
  `@jinn-network/plugin`, or `@jinn-network/jinn-layer`; the new tree's source-boundary
  allowlist forbids all three by omission and a dedicated assertion names them. Only
  mechanical, content-unchanged relocation is permitted (C0), per spec §4.1.
- **The daemon cutover is not gated by anything here**, and nothing here gates it. The
  `client/` portal surface and five-tree operator image stay intact (spec §4.1).
- Every task ends with typecheck + tests + relevant kits + guards run locally, outputs
  shown (principles §13.3).
- Independent per-component review when a component completes; findings resolved before
  dependents build on it (principles §13.2), **subject to the review-wave cap below**.
- **Review-wave cap (operator decision, 2026-07-31):** at most **two** whole-component
  review waves per component. Wave 1 = first independent review after implementation.
  Wave 2 = one consolidated repair wave (Critical + Important) plus one scoped rereview of
  that wave only. After wave 2, the component is **acceptance-complete**: remaining
  Important/Minor residuals are recorded as dated deferred findings in the plan and do
  **not** block dependents. Critical defects discovered after the cap still escalate to the
  operator. Tradeoff accepted: speed and program throughput over unbounded adversarial
  closure. Phase 0 exception: C0/C1/C3 already exceeded two waves; they are accepted at
  their 2026-07-31 heads under this decision (C1 `7672fc214`, C3 `ec57b5a2f`, C0
  `9ab749c43` after restack when convenient).
- American English throughout. **No product names in tiers 1–3** — the C1/C2 packages must
  not contain the identifiers `plugin`, `jinn-plugin`, or any product name (harness/format
  names such as `hermes` are permitted; they are format identities, precedented by the
  tier-3 launchers).
- **Custody law C1–C5** binds every published package: no key material, no ambient
  authority acquisition, signer objects only, fail-closed verification, trusted-publisher
  provenance.
- Designs are law: a wrong or ambiguous design discovered at implementation time is a
  **finding with a proposed disposition**, recorded as a dated amendment — never a silent
  patch (principles §13.1).

---

## 1. Component plans

Authored per row; executed in the phase order of §2.

| Plan | Scope | Depends on |
| --- | --- | --- |
| `2026-07-30-plugin-c0-adapter-relocation.md` | **#2294 unblock.** Mechanical, content-unchanged relocation of the frozen Hermes adapter directory + `layer-runtime.json` out of `apps/jinn-agent` to the new tree's frozen path; re-point `jinn-plugin-split.yml`, `verify-layer-stable-version.mjs`, and the cold-stock gate. Gate: the mirror dry-run produces a bit-identical slim tree | — |
| `2026-07-30-plugin-c1-trajectory-record.md` | **Tier 2.** `packages/evidence/trajectory` — sealed Trajectory record kind; required `timebase`; no `source.execution`; **direct `@jinn-network/trust-core` dependency**; full derivation attestation surface (build/seal/verify L1–L3); **`TRAJECTORY_RECORD_IDENTIFIER_PROPERTY`**; digest helpers (`RepositorySha256Digest` / `BareSha256Hex`); **`derivedAt`** on predicate; four-layer kit | — |
| `2026-07-30-plugin-c2-trace-decode.md` | **Tier 3.** `packages/evidence/trace-decode` — format-IRI-keyed decoders; **pure handoff** of `BuildTrajectoryDerivationStatementInput` to caller (no signer, no seal, no trust-core); first decoder `claude-code-stream-json` | C1 |
| `2026-07-30-plugin-c3-product-tree.md` | **Tier 4 scaffold.** The `plugin/` tree: workspace layout, `plugin/runtime` package, guard trio + CI workflow, the frozen-trio import assertion, config surface, and the runtime's process skeleton (no capabilities yet) | — |
| `2026-07-30-plugin-c4-capture.md` | Capture path + Trajectory producer from hook feed; **derivation attestation seal** (injected `DsseSigner`, `derivedAt` from finalization instant); durable link at `captureDirectory/derivation-links/<hex>.json`; imports `TRAJECTORY_RECORD_IDENTIFIER_PROPERTY` from C1 | C3, C1 |
| `2026-07-30-plugin-c5-mirror-and-retrieval.md` | Public-corpus mirror (discovery client sync under an exclusive advisory lock, high-water-mark store, source configuration) + retrieval (exact-byte fetch and validation) + **trust filtering, fail-closed**, applied before anything reaches ranking | C3 |
| `2026-07-30-plugin-c6-relevance-and-projection.md` | The product's intelligence: FTS5 index over both planes, ranking, **index-time sensitivity exclusion** via the derivation detector model, and the budgeted, attributed projection with its provenance boundary. Ships adversarial fixtures (instruction-bearing records, stuffed metadata, distractors) alongside golden ones | C2, C4, C5 |
| `2026-07-30-plugin-c7-mcp-and-adapter.md` | The host seam: the runtime's MCP server surface (`corpus_search`, `corpus_fetch`, pickup, capture lifecycle); the Hermes adapter (hooks, first-turn injection, capture feed, `◇` rendering, doctor with the `{name, ok, detail, remedy}` contract incl. the non-user-fixable channel state); the runtime pin file | C6 |
| `2026-07-30-plugin-c8-channel-cutover.md` | **Split at the operator decision of 2026-07-31.** *Gate 1 — local acceptance*, executed on the integration branch as C7's closing gate: real Hermes, `file://` clone install, capture, pickup, the `◇` moment, the doctor precondition matrix, disable/remove — the runtime resolved via `JINN_PLUGIN_RUNTIME_BIN` or a locally packed tarball. *Gate 2 — the cutover proper*: publish the runtime package, re-point the mirror, swap the pin, real npm acquisition on a clean runner, published-artifacts smoke, rehearsal, operator ratification; runtime-residue cleanup; mono-side rollback runbook | Gate 1: C7 only. Gate 2: C7 + #2293 + the branch decision |
| `2026-07-30-plugin-c9-retirement.md` | The retirement train: `npm deprecate` ×3; dismantle `layer-npm-publish.yml`, the lockstep verifier + its two test files, the per-package CI workflows, trio path filters, boundary-test allowlist entries; remove `bundledDependencies` + the bundled-publication gate (post-cutover-stage-5); remove the trees | C8, daemon cutover stage 5 |

## 2. Phases and critical path

- **Phase 0 — three parallel streams:** C0 (relocation), C1 (record kind), C3 (product
  tree scaffold). Independent; C0 unblocks #2294 immediately and need not wait for the
  product.
- **Phase 1 — two parallel streams:** C4 (capture, needs C3 + C1), C5 (mirror +
  retrieval + trust, needs C3).
- **Phase 2:** C6 (relevance + projection) — the first convergence point.
- **Phase 3:** C7 (MCP + adapter) — the product becomes usable end to end.
- **Phase 4:** C8 (channel cutover) — gated additionally on #2293 and operator
  ratification.
- **Phase 5:** C9 (retirement) — gated additionally on daemon cutover stage 5 for the
  client-side couplings.
- **C2 (decoder) runs off the critical path**, any time after C1. Per finding F2 the
  product produces trajectory records from its own live hook feed and never parses a
  transcript to capture; the decoder serves *consumption* of records produced by other
  producers (backend-local attempts), which do not exist in the corpus yet. It lands
  before public-corpus content with native traces needs excerpting.

**Critical path:** C1 → C4 → C6 → C7 → C8 → C9. C3 must land before phase 1 but is small
and parallel to C1. Each phase ends with tests/kits/guards green, the per-component review
done and resolved, and a phase report.

## 3. The PR stack

**No component waits for a merge.** Each component is a branch stacked on its dependency's
branch, and each PR targets **its base branch**, not `integration/evidence-v1`. A component
plan may assume its dependency's code exists *on that dependency's branch* and nowhere else.

```
integration/evidence-v1
├── plugin/c0-adapter-relocation          (root; merges independently, unblocks #2294)
├── plugin/c1-trajectory-record           (root)
│   └── plugin/c2-trace-decode
├── plugin/c3-product-tree                (root)
│   ├── plugin/c4-capture                 ← merges in c1
│   │   └── plugin/c6-relevance-and-projection   ← merges in c2 and c5
│   │       └── plugin/c7-mcp-and-adapter
│   │           └── plugin/c8-channel-cutover
│   │               └── plugin/c9-retirement
│   └── plugin/c5-mirror-and-retrieval
```

Three roots branch straight off `integration/evidence-v1` and can be reviewed in parallel:
**C0**, **C1**, **C3**. Two components have a second parent and merge it in as their first
task, proving the merged head green before building on it: **C4** (base C3, merges C1) and
**C6** (base C4, merges C2 and C5 — the program's convergence point).

**Path ownership across the two roots that both touch `plugin/`:** C3 creates the tree and
owns `plugin/runtime/` plus the tree-level guards and CI; C0 owns `plugin/frozen/` alone.
Neither may create the other's paths, so the roots merge without conflict in either order.

**Restacking.** This repository squash-merges, so when a base lands, children restack with
`git rebase --onto <new-base> <old-base> <branch>` and re-verify (typecheck, tests, the
relevant kits, and the guards) on the restacked head before their PR is re-requested. Every
component plan carries a Restacking section stating its own procedure.

C8's cutover lands as exactly one deploy PR whose description carries the ordering
checklist (runtime published stable **before** the mirror re-point) and the mono-side
rollback statement. No agent self-merge; C8 and C9 are operator-approved.

## 4. Naming decisions (settled here, used everywhere)

- **Packages:** `@jinn-network/evidence-trajectory` (C1),
  `@jinn-network/evidence-trace-decode` (C2), `@jinn-network/plugin-runtime` (C3+) —
  matching each tree's existing scheme (`@jinn-network/evidence-*`,
  `@jinn-network/record-discovery-*`, `@jinn-network/trust-*`).
- **Product tree:** `plugin/` at the repository root, sibling of the future `operator/`.
  The user-facing channel (`hermes plugins install`, `Jinn-Network/jinn-plugin`) locks the
  word "plugin"; the in-repo overload is disambiguated by package name — the new runtime is
  `@jinn-network/plugin-runtime`, distinct from the frozen `@jinn-network/plugin`, and
  daemon-side SolverPlugins keep their own vocabulary.
- **Tree layout:** `plugin/runtime/` (the MCP runtime, npm-published),
  `plugin/adapter-hermes/` (the Python adapter, mirrored to the slim repo, **not**
  npm-published), `plugin/frozen/` (C0's relocated frozen adapter; deleted by C9).
- **Record kind:** `https://jinn.network/records/trajectory/1.0`, media type
  `application/vnd.jinn.trajectory.v1+json`, protocol URI
  `https://jinn.network/protocols/trajectory/1.0` — following the platform record-kind URI
  grammar (`${RECORDS_ROOT}/<segment>/<major>.<minor>`, as benchmarking's records use it).
  The frozen `core` `jinn.trajectory.v1` was a `schemaVersion` literal inside a package,
  never a platform record kind, so there is nothing to collide with. Vocabulary profile:
  `https://jinn.network/profiles/trajectory-vocabulary/1.0` (finding F1 — Jinn-owned,
  citing an upstream snapshot).
- **Runtime pin file:** `runtime-pin.json`, same shape and role as the frozen
  `layer-runtime.json` (`{ package, version, bin }`), read by the adapter without a Node
  toolchain (spec §8.3a).
- **Decoder identity:** decoders are identified by `(formatIri, decoderId, decoderVersion)`;
  `decoderId` is a stable reverse-DNS-free slug (e.g. `hermes-transcript`), `decoderVersion`
  is semver of the decoder package.

## 5. Cross-plan contracts (binding on every component plan)

1. **Untrusted corpus content** (spec §6.3) — corpus records are untrusted input; trust
   filtering runs **before** ranking and is **fail-closed** (rejection excludes the
   record); retrieval absence stays **fail-open** (work proceeds). Projection frames
   content as quoted data behind a model-visible provenance boundary and never relays
   retrieved instructions. Ranking and projection ship adversarial fixtures.
2. **Local privacy** (spec §6.4) — captured records and native traces are written
   owner-only; **index-time sensitivity exclusion** keeps high-band findings
   (credentials, key-shaped material, funds-controlling secrets) out of retrieval
   projections by composing `evidence/derivation`'s detector model — **no second scrub
   engine is built**; retention bounds raw persistence.
3. **Decoder integrity** (spec §7.2) — every sealed trajectory record carries source
   native-trace digest, format IRI, decoder identity + version, vocabulary profile, and
   **required declared `timebase`** (`source-epoch-ns` | `synthetic-ordinal`). The record
   does **not** carry `source.execution`. Execution↔Trajectory discovery uses the Execution
   record's forward link (trajectory identifier on the native-trace entity); cryptographic
   binding uses a **Trajectory derivation attestation** (DSSE-wrapped in-toto Statement,
   predicate `https://jinn.network/attestations/trajectory-derivation/v1` — not a fourth
   evidence record family). Determinism per `(formatIri, decoderVersion)` is enforced by
   the C2 kit's byte→span golden fixtures. **Verification is four-layer** (L1 digest
   identity; L2 DSSE + trust binding; L3 statement/forward-link reference checks; L4 decoder
   replay for span faithfulness only). C1's kit asserts layer distinctions; L4 is not
   implied by sealing or attestation alone.

   *Corrected 2026-07-31 (operator-ratified, C1 trajectory attestation correction).*
   Supersedes the prior contract-3 wording: parent execution reference inside the
   Trajectory record, "Records are DSSE-signed" at the Trajectory JSON layer, and
   two-level verification. **Interface closure (2026-07-31):** C1 depends on
   `@jinn-network/trust-core` (not attestation-issuer); C1 owns
   `TRAJECTORY_RECORD_IDENTIFIER_PROPERTY`; attestation requires calendar-strict `derivedAt`;
   sole statement subject `trajectory.json`; C4 durable link at
   `captureDirectory/derivation-links/<hex>.json` (contract 13); C2 pure handoff of
   `BuildTrajectoryDerivationStatementInput` — C4 build+seal only.
4. **Host seam** (spec §6.2) — MCP carries control and references; **bulk transcript bytes
   move by file path** within the machine boundary. The adapter is itself an MCP client.
   Instances are session-scoped; shared local state is coordinated by SQLite WAL, a
   single capture writer per session, and an exclusive advisory lock for mirror sync.
5. **Fleet safety** (spec §6.2) — per-Hermes-home archives by default; no shared-archive
   writes across concurrent workers. **Mirror sync never blocks pickup**: pickup always
   serves the current mirror; sync is opportunistic and bounded.
6. **Freeze discipline** (spec §4.1) — no feature work on the trio; mechanical relocation
   only; the critical-fix path is the coordinated four-way lockstep bump documented in
   the spec, not an ad-hoc single-package publish.
7. **Channel ordering** (spec §9.3) — the runtime package is published stable on npm
   **before** the mirror re-point lands on `main`; rollback is a **mono-side** revert
   (the slim repo is never hand-edited); the doctor reports a known-outage state, not a
   no-op remedy, when the pin cannot resolve.
8. **Autopilot adoption is not implicit** (spec §4.3) — the extracted Autopilot never
   auto-updates an existing plugin install; fleet adoption requires its own pass and is
   out of this program's scope.
9. **Tier hygiene** — C1 and C2 name no product, carry allowlist source-boundary guards,
   and expose their surfaces through kits proven passable by in-tree fakes.
10. **Health checks measure install state, never capability** *(added 2026-07-31 at
    planning consolidation; raised by C5, corroborated against C7's gate)*. **Any check
    whose answer is the same on every install is a release note, not a health check** —
    it carries zero information and, worse, an always-red or always-amber entry trains
    operators to ignore the colour. A check must measure something install-specific and,
    where the operator can act, name the one command that fixes it; `remedy: null` is the
    honest form of "broken, and nothing you do fixes it" (the spec §9.3 channel-outage
    state). The merged doctor spans C4, C5, C6, and C7, so **one bad check anywhere
    defeats gate C7 for everyone**: each of those plans sweeps its own check list against
    this rule before the gate rehearsal.
11. **Chain-facing dependencies are injected from outside the runtime** *(added
    2026-07-31; resolves C5's F1 and C7's F-C7-4)*. Verifying discovery announcement
    chains needs a `BindingResolver`, which pulls `viem`, which C3's runtime allowlist
    forbids — and correctly so. The tier-4 composition root (the binary, or a thin adapter
    beside it) may depend on `viem`; `plugin/runtime` may not. This matches the stack's
    standing host-injection pattern for chain-facing dependencies and keeps the allowlist
    intact. Until a resolver is injected, the mirror indexes nothing by default and
    reaching the unverified posture requires an explicit, reviewable configuration
    acknowledgement — the consent surface is that flag, not a permanently red check.
12. **Name bounded residuals; do not build machinery that hides them** *(added 2026-07-31
    at consolidation; arrived independently from the C5/C7 doctor ruling and the C4/C7
    stranded-feed ruling)*. Where a gap is genuinely bounded and cannot be closed from
    where the user stands, the discipline is to state it precisely — in the product's own
    voice, beside the surface it limits — rather than adding a mechanism whose real effect
    is to make it less visible. An always-amber health check and a background daemon are
    the same mistake in different clothes. Three residuals ride this rule today and each
    must stay named: the unverified public-corpus posture until a binding resolver is
    injected (contract 11); sealed local evidence growing without a storage bound until
    the local-runtime retention finding lands (spec §7.3); and a final stranded session
    feed when an operator never opens another session (C4).

13. **A marker and the data it describes must share a lifetime** *(added 2026-07-31; the
    pattern bit twice in opposite directions within one planning round)*. Every component
    here keeps a small piece of state *about* a larger store — a last-indexed marker, a
    sync high-water mark, a retention watermark — and both failure modes appeared:
    **too tightly coupled**, where C6 derived `lastIndexedAt` from `max()` over live rows
    so evicting the last record erased the marker and made the exact state its health
    check existed to catch unobservable; and **too loosely coupled**, where C5's
    high-water mark lives in a file separate from the catalog it describes, so a deleted
    or recreated catalog leaves a position pointing at records that are gone and the
    mirror stays permanently empty while reporting green. The rule: a marker must either
    live and die with its data, or be able to **detect that its data was replaced** — a
    generation stamp, not a bare position. Where a component cannot yet self-heal, the
    stuck state must at least be *visible* with a remedy that genuinely repairs it.
    Corollary from the same round: a check that asks "does this store hold anything" must
    read the store **raw**, not through a filtered reader, or a legitimately filtered
    store is misreported as broken and fires the wrong remedy.

14. **A check must distinguish causes that warrant different advice** *(added 2026-07-31;
    derived independently three times in one round)*. A single row covering two states
    with opposite remedies will confidently give the wrong advice to half the operators
    who see it — which is worse than saying nothing, because it is actionable and wrong.
    The three instances: `corpus-index` had to separate trust-filtered-empty (green, names
    the cause, no remedy, defers to the row that owns it) from written-then-emptied (red,
    `rebuildIndex` repairs it); `corpus-mirror` had to read its catalog **raw** rather
    than through the trust-filtered reader, or a legitimately filtered store is
    misreported as wedged and fires the wrong remedy; and `capture-stranded` had to split
    a feed cut short by a hard kill (unsealable, nothing anyone could have done,
    informational) from a feed that was never reached (recovery falling behind, real lost
    work, real remedy) — two causes that had shared one counter. Where the check cannot
    tell the causes apart, it must say what it does not know rather than pick one.

15. **The program runs on `integration/evidence-v1` for as long as it can** *(operator
    decision, 2026-07-31)*. Nothing before C8 gate 2 requires npm, `next`, or #2293: every
    stack dependency resolves through `portal:`, the adapter resolves its runtime through
    `JINN_PLUGIN_RUNTIME_BIN` or a locally packed tarball, and the real Hermes install path
    is exercised with `hermes plugins install file://<clone>`. Component plans must
    therefore keep a **local-only execution path green at every step** and must not
    introduce a step whose only proof is a registry round trip. The one claim a local
    rehearsal cannot make is that the *published* artifact works — that is C8 gate 2's
    entire purpose and the failure class it exists to catch, so no plan may quietly
    substitute a local tarball there.

## 6. Review and verification gates

### Two-wave review cap (operator decision 2026-07-31)

Unbounded adversarial rereview of C1/C3 proved that each repair wave becomes new law and
the next reviewer finds the next adjacent hole. That is valuable for custody/evidence
substrates and also unbounded. The operator accepts the residual risk and caps whole-
component review at **two waves per component**:

1. **Wave 1** — one independent whole-component review after all tasks are checked off
   and mechanical gates are green (typecheck, tests, kits, guards, pack smoke as applicable).
2. **Wave 2** — at most one consolidated repair wave for Critical and Important findings,
   then one scoped rereview of that wave only. After wave 2, the component is
   **acceptance-closed**: remaining Important/Minor findings are recorded as dated
   residuals in the component plan and do **not** block dependents. Critical defects that
   still fail wave-2 rereview escalate to the operator; they are not silently waived.

**Phase 0 closure under this cap:** C0 already had a clean scoped rereview after one fix
wave. C1 and C3 each already exceeded two waves (seven repair waves each through R65 /
R-C3-64) with component CI green at heads `7672fc214` (C1) and `ec57b5a2f` (C3). Further
acceptance cycles on C1/C3 are cancelled. Dependents (C2, C4, C5) may proceed on those
heads. Residual risk: hostile-input / custody edge cases beyond the closed law remain
possible; they will be filed as follow-ups if they surface in dependent work, not as
further C1/C3 acceptance loops.

| Phase | Gate beyond typecheck / tests / guards |
| --- | --- |
| C0 | Mirror dry-run yields a slim tree bit-identical to today's; `verify-layer-stable-version.mjs` green against the relocated pin |
| C1 | Record kind kit green (golden + adversarial); cross-package sealing-equivalence fixture matches `evidence/protocol` digests |
| C2 | Decoder kit green; the in-tree fake proves the kit passable; the `claude-code-stream-json` decoder passes byte→span determinism fixtures on repeat runs and under attribute-order assertions |
| C3 | Guard trio red-lines a deliberate frozen-trio import (negative test) |
| C4 | A real session captures to a sealed record that validates against `evidence/protocol`; retention sweep bounded and observable |
| C5 | Mirror syncs from a fixture archive; trust rejection excludes a record; retrieval validates exact bytes and rejects a digest mismatch |
| C6 | Adversarial fixture set passes: no instruction-bearing record reaches projection unquoted; no high-band-sensitive excerpt is projected; ranking survives a stuffed-metadata distractor |
| C7 | End-to-end in a real Hermes session: `◇ corpus` moment on a seeded archive; doctor green, and each broken precondition names its remedy |
| C8 | The spec's four-layer gate, incl. operator ratification within the 5-minute budget |
| C9 | No workflow, script, or allowlist references the trio; client builds green without it |

## 7. Planning findings and rulings (2026-07-30)

Surfaced by the planning research lanes, recorded per the designs-are-law rule. F1–F3
carry dated corrections into the spec; F4–F6 are findings against other owners.

- **F1 — the GenAI semantic conventions cannot be pinned by version.** The spec (§7.2,
  §8.2) requires the sealed record to declare "the pinned semconv version". Verified
  upstream state: as of core semconv **v1.42.0 (2026-06-12)** every `gen_ai.*` attribute
  was deprecated out of `open-telemetry/semantic-conventions` and moved to
  `open-telemetry/semantic-conventions-genai`, which has **zero releases, zero tags**, a
  README whose versioning section reads `## Schema URL\nTODO`, and **100 of 100
  attributes at `stability: development`**. There is no version string to pin.
  **Ruling:** the record declares a **Jinn vocabulary profile version** — owned and
  semver'd by C1 — which *cites* an upstream commit SHA plus snapshot date. The profile
  is the interpretation contract consumers rely on; upstream is a tracked source, not a
  dangling reference. This preserves the spec's stated intent (the pin exists *because*
  the vocabulary is young) and is buildable. Two vocabulary facts fixed at the same time:
  `gen_ai.system` was renamed **`gen_ai.provider.name`** (core semconv v1.37.0), and
  token usage is `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (not the
  older `prompt_tokens`/`completion_tokens`). The spec carries the dated correction.
- **F2 — the product is a trajectory *producer*, not a transcript parser; the decoder
  leaves the critical path.** The spec sequenced the decoder first ("the host the product
  ships on"), assuming the product would decode Hermes transcripts to excerpt its own
  sessions. Code investigation falsifies the premise: the Hermes adapter captures a
  **live structured hook feed** (`capture_buffer.py` records user turns, assistant turns,
  and tool calls with ids, timings, args and results as they happen), so own-session
  capture produces structured spans directly and never parses a transcript. Two further
  facts make transcript-parsing the *worse* source for own sessions: Hermes's JSON
  session snapshot is **off by default** (`sessions.write_json_snapshots: False`), and
  the snapshot carries neither per-message timestamps nor token counts, both of which the
  canonical `state.db` (and the hook feed) do. **Ruling:** C4 produces
  `jinn.trajectory.v2` from the hook feed; the decoder (C2) serves *cross-producer
  consumption* and moves off the critical path, with **`claude-code-stream-json` as its
  first format** — the format backend-local actually emits, with real reference parsers
  and real fixtures in-tree. The spec carries the dated correction to §7.1.
- **F3 — format identity is three unmapped names; the decoder must close the gap.**
  The launcher declares `envelopeFormat: "hermes-json"` / `"claude-code-stream-json"`
  (bare strings, `launchers/src/contract.ts:34`), the legacy parsers declare
  `sourceFormat: 'hermes-session-json'` / `'claude-code-stream-json'`, and
  `NativeTraceCapture.format.entityId` is an **AbsoluteIri that today is hardcoded** to
  `https://jinn.network/formats/backend-local-supervisor-facts/v1`
  (`assembly/src/evidence-join.ts:181`) and never carries the harness format at all.
  **Ruling:** C2 owns a format-identity registry mapping launcher `envelopeFormat`
  strings to canonical format IRIs, and C2 files a finding against the backend-local
  assembly so attached harness traces carry the right IRI. Decoders key on the IRI.
- **F4 — OTLP JSON has no canonical attribute ordering** (attributes are an ordered
  list; 64-bit ints are decimal strings; ids are hex with unspecified case). Determinism
  (cross-plan contract 3) therefore needs an explicit rule. **Ruling:** the C2 decoder
  contract mandates attributes sorted by key under the stack's existing UTF-16
  code-unit ordering rule, lowercase hex ids, and decimal-string 64-bit fields; the kit
  asserts it. Sealing itself is unaffected — the stack's JCS-once rule already makes the
  authored bytes the record.
- **F5 — message content placement.** The GenAI conventions sanction three patterns and
  recommend, for production, **external storage with references on spans** — which is
  what a content-addressed record already provides. **Ruling (C1):** the trajectory
  record carries structure, timings, tool identities, statuses and usage; message
  content is *not* inlined, and consumers resolve it from the digest-bound native trace
  (or, for hook-produced records, the attached feed artifact). This also keeps sensitive
  content out of the sealed record, complementing the §6.4 posture. A bounded
  content-reference extension (offsets into the source) is a named extension point, not
  v1 scope.
- **F6 — the stack's Hermes launcher emits argv the Hermes CLI rejects.** It passes
  `--json-schema` and `--max-iterations` (`launchers/src/hermes.ts:23,26`); neither flag
  exists in `apps/jinn-agent/hermes_cli/_parser.py`, so any attempt carrying an effort or
  output-schema pin fails at argparse (exit 2). Its `structuredOutputArtifact:
  "out/structured-output.json"` likewise has no producer. Unrelated to this program's
  deliverables. **Ruling:** filed as a finding against the local-backend launcher owners
  (the working argv is in `client/src/harnesses/impls/hermes-agent/adapter.ts:264`); no
  component here depends on it.

## 7a. Planning consolidation (2026-07-31)

All nine remaining component plans were authored in parallel and surfaced roughly sixty
findings. Rulings that change a shared document are recorded as dated corrections in the
owning spec; the rest stay with their plans for the component reviews. The ones that moved
scope:

- **C9/F1 — the retirement disposition splits in two.** Retire the npm identities and
  publish machinery now; let `packages/core` survive as an unpublished portal-only tree
  until the operator recomposition retires its consumers. Spec §4.2 corrected.
- **C0/F2 — the adapter relocation is not purely mechanical.** The directory is a live
  bundled plugin of the fork with 36 Python importers; a committed symlink covers the gap
  until #2294 removes both. Spec §9.1 corrected.
- **C3+C4 — the §6.2 archive-access design unit is resolved by code**, not by choice:
  `openLocalEvidenceRuntime` takes an exclusive lock, so per-operation open/close is the
  only available mode. Spec §6.2 corrected; C3's capability seam carries the prohibition.
- **C6/F12 — the privacy posture had a bypass.** `corpus_fetch` never touches the index,
  so exclusion becomes two enforcement points over one disposition table. Spec §6.4
  corrected.
- **C5 vs C7 — the doctor conflict produced contract 10.** A check whose answer is
  identical on every install is a release note, not a health check; the coordinator's
  first ruling (a third "degraded" severity) was withdrawn in favour of C5's rewrite.
- **C5/F1 + C7/F-C7-4 — chain verification needs `viem`**, which the runtime allowlist
  correctly forbids; binding resolution is injected from the tier-4 composition root.
  Contract 11.
- **C4 — the Trajectory record is stored as an artifact**, not as a new evidence record
  family (a closed, frozen set), and retention cannot delete sealed material at all. Spec
  §7.2 and §7.3 corrected.
- **C2/F9 — determinism forces a declared timebase** for timestamp-free formats. Spec
  §7.2 corrected; C1 gains the field at its component review.
- **Operator-ratified 2026-07-31 C1 Trajectory correction** — supersedes optional
  `source.execution`, two-level verification, anti-forgery span-ID overclaims, and
  record-level DSSE signing of Trajectory JSON. Law: Trajectory derivation attestation
  (in-toto+DSSE via trust-core), four-layer verification, required first-class `timebase`,
  no `source.execution`, C1-owned forward-link IRI, C4 durable `derivation-links/` path,
  C2 pure handoff. Full types in C1 plan §Interface closure (2026-07-31).
- **C8 — a branch precondition nobody had checked:** both publish lanes trigger from
  `next`, which `integration/evidence-v1` is not an ancestor of. Spec §9.3 corrected; the
  sequencing decision belongs to #2293's owner.
- **C0+C8 independently — two workflow test suites gate the paths that reach every
  installed host and no workflow runs either.** Closed by C8's Task 3.
- **C8/F3 — the onboarding design's layer-2 gate was never satisfiable** (`permissions: {}`,
  no secrets, so no model turn). That design is corrected in place.
- **C6/F14 — the native `better-sqlite3` dependency in the install path is a real but
  *precedented* risk**, and should be weighted accordingly. The one-command install has the
  adapter acquire the runtime from npm on the user's machine, so a native module must have a
  prebuild for their platform and Node version or fall back to compiling. This is not new:
  the frozen `@jinn-network/jinn-layer@0.1.2` already depends on `better-sqlite3` and its
  install story works today, which is the strongest evidence available that the risk is
  manageable. C8's cold-stock gate exercises the real npm acquisition on a clean runner, so
  the gate would catch a regression — the finding is a thing to verify at that gate, not a
  reason to reconsider the storage choice.
- **C6's health-check sweep produced an addition, not a deletion** — worth recording because
  it shows contract 10 doing more than pruning. C6 emits no doctor rows itself, but applying
  the rule to what it *could* contribute rejected two candidates as release notes (FTS5
  availability is fixed per install; tokenizer generation self-heals on open) and kept one
  that genuinely varies: index population, which is exactly the state where "pickup returned
  nothing" is ambiguous between an empty index and a query that matched nothing. Keeping it
  forced a real interface addition (`stats(): IndexStats`) so C7 reads a supported surface
  rather than C6's SQLite directly — with a test that records excluded for carrying secrets
  do not inflate the counts.

## 7b. Operator decisions (2026-07-31)

Both open decisions from consolidation are settled, and each changed a plan.

**Stay on the integration branch as long as possible.** C8 splits into a local acceptance
gate (integration-branch, closes C7, proves the *product*) and the channel cutover proper
(needs npm, `next`, and #2293, proves the *channel*). Contract 15 binds every plan to keep
a local-only path green. Recorded recommendation when the branch question does arrive:
land integration into `next` rather than teach the publish lanes a second branch — the
diff is additive (351,713 insertions, 37 deletions, ten existing files touched, `client/`
and every publish workflow untouched), and publishing from a non-mainline branch would
have to be unwound later. Note this is #2293's blocker before it is ours: the entire stack
is absent from `next`, so #2293 cannot execute there either.

**Schedule `packages/core` for removal.** Spec §4.2 now carries a four-gate schedule
rather than an open-ended reprieve. **A first attempt at that section was wrong and is
retracted in place**: it named harvest/mint migration as the blocking work, on the
reasoning that the composition design keeps harvest "as-is" and that harvest is what the
scrub/trajectory cluster serves. Code says otherwise — harvest is commit-echo mining that
manufactures benchmark tasks from upstream commits, and its only `core` dependency is
`canonicalJson` through a one-line façade. The cluster actually serves the harness
execution engine and its capture path, which cutover stages 1–2 and 4 **do** retire. The
residual is narrower and still worth carrying: the stage table retires loops and the
TaskEngine, not modules by name, so gate 2 needs module-level confirmation for
`client/src/captures/`, `conformance/checks/`, `observability/redact-secrets.ts`, `eval/`,
and harvest's `canonicalJson`. Gate 3 is the capability gaps (ML PII, gitleaks pack, scrub
review queue → `evidence/derivation`; the five remaining transcript parsers →
`evidence/trace-decode`, or dropped with their formats declared unsupported).

## 8. Follow-ups registry (recorded once; none block the program)

From spec §11: the seeding/curation coordination that gives retrieval its value floor
(operator call, tracked with this program); the local-runtime retention finding (filed
against the owning design); optional derivation detector contributions (ML PII, gitleaks
pack, review-queue store); optional measurement re-home to the benchmarking tree; the
parked SolverPlugin distribution session; the #2294 checklist items 2–3 that C0 touches.

## 9. Out of scope

Everything the spec's §13 names: no outbound publication, mint lane, or consent surface;
no multi-host adapters beyond Hermes; no hosted retrieval service, embeddings, or model
calls in the retrieval path; no distillation or skill surfaces; no SolverPlugin
distribution design; no protocol changes to frozen record families; no migration of trio
code. Additionally: #2293 (the stack publish path) is program-adjacent, not program work.

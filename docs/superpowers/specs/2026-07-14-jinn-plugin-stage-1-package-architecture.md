# Jinn Plugin Stage 1 — Package Architecture

- **Version:** 0.1 (approved in planning session 2026-07-14)
- **Date:** 2026-07-14
- **Author:** Ritsu (planning session, Claude Fable 5)
- **Shape:** `design`
- **Parent:** `docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md` (approved);
  PR #1651 roadmap (unmerged — blocker for implementation issues).

## 1. Decision

**Approach C — contract core now, strangler-fig migration.** A new, pure product package owns
the contracts and the product workflow as new code (no file moves); `client/packages/harness-layer`
is re-scoped to the adapter bundle + composition root; implementation mass migrates in Stage 2.

Rejected: **A** (fix harness-layer in place — keeps it client-bundled and forces the largest
shared-infra extraction first); **B** (full extraction now — big-bang move of ~40 files that
collides with the open distillation PR stack #1543–#1554 and front-loads migration before any
product gap closes; B remains the Stage 2 destination).

## 2. Package identity

- **Name:** `@jinn-network/plugin`
- **Location:** `packages/plugin` (top-level yarn project, sibling of `sdk`/`indexer`; **not** a
  client workspace member). Consumed via `portal:` with the "build first" CI pattern
  (`sdk-ci.yml` precedent).
- **Publication:** private in Stage 1 — workspace-isolated, independently buildable; npm
  publication deferred (the CLI ships inside `@jinn-network/client`).
- **Pair:** the pip package `jinn-plugin` (`apps/jinn-agent/plugins/jinn/`) remains the Hermes
  **host adapter**.

## 3. Public API

**Entry:** `src/index.ts`; subpath export `./testing`.

**Library API:**

```ts
createJinnPlugin({ corpus, evidence, contribution, localLearning, skills, config }): JinnPlugin

plugin.session(meta): PluginSession
  .firstTurnPickup(firstMessage) -> { contextBlock?, suggestions[], markers }
  .noteUserTurn/.noteAssistantTurn/.noteToolCall   // or batch events at end
  .end(outcome, events?) -> { episodeRef, eligibility, summary }

plugin.history(query)      // derived view: episodes + contribution + distilled skills
plugin.explain(sessionRef) // what Jinn surfaced/did in that session
plugin.skills.{install,list,uninstall}
plugin.distill.{run,status,runs}
plugin.contribution.{ledger,status,veto}
```

**Process API (cross-language contract):** the `jinn-layer` CLI verbs map ~1:1 onto the library
API and return versioned JSON. `jinn-layer contract --json -> { contractVersion }` is checked by
host adapters at session start (mismatch degrades with an instructive message — closes the
#1380 skew class). Typical session cost: two process calls (first-turn pickup, session end).

## 4. Ports (five)

| Port | Stage 1 behavior | Adapter (Stage 1) | Excluded |
|---|---|---|---|
| `CorpusPort` — search/get | first-turn pickup, `/corpus`, agent tools | shim over `harness-layer` consume (discovery + IPFS + cache) | ranking, payment, publication |
| `EvidencePort` — put/list/get episodes, retention | session-end persistence; distiller + history reads | shim over the captures-dir store | remote storage, indexing |
| `ContributionPort` — recordMineable, ledger, mintStatus, veto | background contribution; inspection surfaces | shims over mineable-trace store, mint pool (read), capture-publish ledger | mint validation (Docker F2P/P2P) and chain publication — **sidecar-owned** |
| `LocalLearningPort` — run/status/list | `/distill` surfaces; distilled skills in history | shim over rung-1 distiller pipeline | network distillation (rung 3) |
| `SkillsPort` — install/list/uninstall | corpus skill install, `.jinn-ref` fencing | shim over skills-install machinery | skill lifecycle manager (Stage 2), hub |

**No `HostPort` object** — the host side is the driving direction, realized as the
`PluginSession` API (in-process) and the CLI verbs (cross-process); host capabilities the core
needs (skills dir, state home) are constructor config. **No `HistoryPort`** — history is a
derived view (product-design invariant) computed from Evidence + Contribution + LocalLearning.

**Error model:** adapters may throw; the core converts to typed outcomes
(`ok | degraded | unavailable` + reason). The process API always exits 0 with a JSON status
envelope for product-level failures (usage errors excepted). Retrieval fails open; contribution
queues; nothing crashes into the host session.

## 5. Type ownership

The package owns the product schemas: **`EpisodeV1`** (complete-trajectory episode — superset
of today's `CapturedTask`: all user/assistant turns, tool calls, skills loadout, token cost,
per-record privacy/retention field, lineage hooks), `KnowledgeHit`, `EligibilityVerdict` (cheap
candidate verdict; authoritative validation is sidecar-side), `SessionSummary`, `HistoryEntry`.
Adapters map to/from infra types and handle legacy `CapturedTask` reads.
**Dependency direction: `harness-layer` imports schemas from `@jinn-network/plugin` — never the
reverse.**

## 6. Dependencies

- **Allowed (runtime):** `zod`. **Dev:** `typescript`, `vitest`. `node:crypto` permitted; no
  `node:fs`/`net`/`child_process` in `src/`.
- **Forbidden:** anything under `client/src/**`, `packages/{sdk,indexer,indexer-enrichment}/**`,
  `apps/**`, `viem`, `@modelcontextprotocol/sdk`, DB drivers, transport clients, `process.env`
  reads (config injected).

## 7. Boundary enforcement

1. **Physical:** separate yarn project — undeclared bare imports fail typecheck.
2. **Architecture tests:** vitest forbidden-import test inside the package
   (`client/test/architecture/api-daemon-boundary.test.ts` precedent) + reverse tests in
   consumers (client/harness-layer import only the public entry, no deep paths).
3. **CI:** own paths-filtered workflow (Node 22: `yarn typecheck && yarn test && yarn build`)
   plus a client-compat job (`sdk-ci.yml` precedent).

## 8. Testing model

`./testing` exports `InMemory{Corpus,Evidence,Contribution,LocalLearning,Skills}` and a
contract-test kit per port (`describeCorpusPortContract(makeAdapter)` …). The core's tests and
the Stage 1 acceptance harness run entirely on in-memory adapters (lifecycle without daemon,
chain, network, or real host); real adapters run the same kits in `harness-layer` tests with
network mocked.

## 9. Composition roots

- **Production:** the `jinn-layer` CLI bin (stays in `harness-layer`) wires core + real
  adapters and carries the process API. The daemon never links the core in-process.
- **Test:** in-memory wiring in `./testing`.
- **Python host adapter:** hooks + rendering + fs glue only; its retrieval policy moves into
  the core (`pickup.py` becomes transport around `jinn-layer session pickup`).

## 10. Responsibility placement

| Responsibility | Home |
|---|---|
| End-to-end workflow, product state/lifecycle, retrieval decisions, episode assembly, eligibility candidate-verdict, history derivation, summary composition, action definitions, presentation state, ports, public API | `packages/plugin` |
| In-session event buffering, hook wiring, TUI rendering, `$HERMES_HOME` glue, skills-dir writes | Hermes host adapter (pip `jinn-plugin`) |
| Corpus/discovery/IPFS mechanics, scrub, captures store, publish/anchor, distiller engine, mineable-trace + mint-pool stores | Jinn Core adapters (`harness-layer` shims over `client/src`) |
| Wiring, CLI process API, env/config parsing | composition root (`jinn-layer` bin) |
| Mint validation (Docker), chain publication, HarvestLoop | sidecar daemon (outside plugin) |
| Marketplace/SolverPlugin authoring types | SDK (untouched) |
| Skill lifecycle manager, attribution, multi-host adapters, npm publication | outside Stage 1 |

## 11. Migration (foundation work, sequenced against the open PR stack)

Scaffold package + CI → schemas + ports + in-memory kit → core workflow with tests → adapter
shims in `harness-layer` → CLI verbs rewired to the core (+ contract handshake) → Python adapter
switched to the new verbs → architecture tests land. No existing file moves; `harness-layer`
edits are additive shims + CLI wiring (merge order coordinated with #1543–#1554).

## 12. Boundary requirements compliance (prompt's 15)

Own package+manifest (§2) · intentional entry (§3) · no internal-path consumer imports (§7.2) ·
explicit minimal deps (§6) · no host/daemon/indexer/dashboard imports (§6–7) · host/network
adapters outside (§4, §9–10) · no type leaks (§5) · DI, no globals (§3, §6) · in-memory
instantiation (§8) · lifecycle without daemon/chain/network/host (§8) · boundary tests (§7) ·
independent build/typecheck/test (§7.3) · disable returns host to stock (product design §4.8) ·
host presentation consumes plugin state (§3, §9) · external failures are typed outcomes (§4).

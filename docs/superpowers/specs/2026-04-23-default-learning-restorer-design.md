# Default learning restorer — design spec (alignment draft)

**Version:** 1.0-alignment  
**Date:** 2026-04-23  
**Author:** adrianobradley + Claude  
**Tracks:** `jinn-mono-2zk` (default learning restorer — scope + product shape)

This document is a **fresh alignment draft**. It supersedes earlier sections of this file that described a long-lived Frink `loop.sh` process, vendored `workingDir/_loop/` materialisation, and multi-day Frink scheduling inside one intent. If anything here disagrees with your intent, call it out explicitly — that is the point of this revision.

---

## 0. Terminology: where “promotion” comes from

**Promotion** is not a Jinn-protocol term. It is borrowed from the **Pi self-improving agent overview** you shared: there, **Learning** produces *candidate* changes (prompts, code, extensions), and a **promotion gate** decides whether those candidates become the **active** system for *future* behaviour.

In this spec it means the same thing, scoped to Jinn directories:

- **Learning** may write proposals and scratch patches under `workingDir` (or a staging subtree).
- **Promotion** is the governor step that **merges or rejects** those candidates into **`implStateDir`** — the only place durable self-improvement is allowed (see §8).
- If the word feels opaque in product copy, we can alias it in the UI as **“Persist learner changes”** or **“Apply”**; the spec keeps **promotion** as the precise name for the gate between *candidate* and *durable*.

---

## 1. Purpose

Ship a **default `RestorerImpl`** for Jinn that:

1. Runs as **one orchestrated execution** per `RestorerImpl.run(ctx)` (one intent, one window, one coherent trace).
2. Uses a **Pi-based** governor (phases, sub-agents, skills, extensions) rather than a bash `exec` loop as the primary harness.
3. Emits **OpenTelemetry** for Jinn-side correlation (traces + structured logs), and relies on **Pi’s built-in session JSONL + compaction** for transcripts and summaries — **no second copy** under `workingDir/logs/` (§5).
4. Produces normal Jinn **working-directory artifacts** (docs, code, declared outputs) for harvest.
5. **Improves itself for the next intent** by reading and writing **only** under the operator’s **`implStateDir`** (and the ephemeral `workingDir` during the run, with an explicit **promotion** step into `implStateDir`).

**Non-goals (v0):**

- A separate “memory product” (vector DB, consolidation service, or mandatory Frink-style notebook pipeline). **Persistent state is `implStateDir`.** Optional append-only JSONL under `implStateDir` is allowed but not required.
- Changing Jinn protocol, on-chain artifacts, or engine state machines.
- Unrestricted self-modification across the whole monorepo or global install.

---

## 2. Product shape: monorepo package + thin client wrapper

| Piece | Responsibility |
|--------|-----------------|
| **New package** in `jinn-mono` (e.g. `packages/jinn-default-learner`, publishable as `@jinn-network/default-learner`) | Pi package: governor extension, phase prompts/skills, **promotion gate** (§0), OTel for Jinn correlation (§5.1), **Pi-native** session/history/compaction (§5.2 — no duplicate log tree), allowed-path enforcement. |
| **`@jinn-network/client`** | Thin `RestorerImpl`: resolve paths, spawn or embed Pi runner once per `run(ctx)`, forward `AbortSignal`, harvest `RestorationOutput`, ensure OTel export shutdown. |

The default restorer **is** this package; the client only adapts Jinn’s `RestorationContext` to the package entrypoint.

---

## 3. Execution model: single run, many internal phases

Inside **one** `run(ctx)`:

1. **Governor** starts a trace and loads **run invariants** (constitutional snapshots — see §6).
2. Phases run in order, with possible **inner loops** (e.g. execute → repair → execute) bounded by time and by governor policy:
   - Design  
   - Planning  
   - Execution  
   - Evaluation  
   - Learning  
   - Promotion (apply or reject candidate changes)  
   - Finalise (sync promoted state into `implStateDir`, prepare `workingDir` for harvest)
3. **Sub-agents** (Pi subprocesses / sub-sessions / delegated turns) are allowed with **shallow depth** (e.g. orchestrator → phase agent → worker). They share the same trace via **linked spans** or child spans.

This is **not** “one Frink slot = one intent”; it is **one Pi-orchestrated run** that completes before `run()` returns.

---

## 4. `workingDir` vs `implStateDir`

| | **`ctx.workingDir`** | **`ctx.implStateDir`** |
|---|----------------------|-------------------------|
| **Lifetime** | Ephemeral per intent attempt; engine may clear between attempts. | Persistent for this operator + this impl across intents. |
| **Purpose** | **Episode**: scratch, builds, intermediate files, and **deliverables** for the current intent (what packaging / harvest reads). | **Self**: operator-private copy of the learner — prompts, Pi extensions, orchestrator helpers, pinned deps, anything that should make the **next** `run()` better. |
| **Improvement across intents** | Indirect: only what **promotion** copies or merges into `implStateDir`. | **Direct**: this is the only durable write target for self-improvement (see §8). |

**Bootstrap:** At run start, the governor **reads** `implStateDir` (and optionally seeds `workingDir` from it). At run end, after promotion, **durable changes** must live under `implStateDir`; `workingDir` may still contain ephemeral junk that is not harvested.

---

## 5. Telemetry: OpenTelemetry (Jinn) + Pi’s own session storage (no duplicate log tree)

Jinn does **not** have Frink’s notion of a long-lived outer loop with discrete `session-*.log` / `lab-notebook.jsonl` files next to `loop.sh`. The harness is **one `run(ctx)`** driving Pi. So we **do not** recreate Frink’s `workingDir/logs/` mirror of session transcripts — **Pi already persists** conversation history, tree structure, and compaction behaviour.

### 5.1 OpenTelemetry (Jinn-side correlation)

Use OTel for what Pi does **not** own: tying work to **Jinn** identity and lifecycle.

- **Tracer:** one **root span** per `RestorerImpl.run()` (or per intent attempt id).
- **Child spans:** governor phases, promotion, sub-agent delegations, as needed.
- **Attributes (minimum):**  
  `jinn.intent.kind`, intent id / cid if available, `jinn.working_dir`, `jinn.impl_state_dir`, package name + version, selected agent backend; **`pi.session.path` or `pi.session.id`** once Pi creates a session, so operators can jump from a trace to Pi’s JSONL on disk.
- **Logs:** engine-relevant events (phase boundaries, promotion outcome, path-policy violations).

**Export:** OTLP / stdout is operator-configured. Optional **small** Jinn-only local sink (e.g. one JSONL line per `run()` under `implStateDir/` with `trace_id` + `pi_session_path`) is allowed if we need grep without a collector — **not** a full duplicate of Pi’s transcript format.

### 5.2 Pi-native logs, summaries, and retention (single source of truth)

Per upstream Pi (`@mariozechner/pi-coding-agent`, documented in [pi-mono `packages/coding-agent` README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) and [pi.dev](https://pi.dev/docs)):

- **Sessions** auto-save as **tree-structured JSONL** under **`~/.pi/agent/sessions/`**, organised by working directory (see README **Sessions** section and [`docs/session.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md) for format).
- **Compaction** (lossy summaries of older context while retaining full history in the JSONL file) is **Pi’s** mechanism — see [`docs/compaction.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md). We do **not** ship a parallel `summarize_session.py` unless Pi’s hooks prove insufficient.
- **Overrides:** operators can set `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) or pass **`--session-dir <path>`** so session files for default-learner runs live under e.g. **`implStateDir/pi-sessions/`** instead of the global home directory — keeps intent-scoped or operator-scoped data next to `implStateDir` without inventing a second log format.

**Time-based compression / pruning** of old session files: if Pi does not ship automatic gzip+retention like Frink’s `find … -delete` on `logs/compressed/`, that is **out of scope for v0** unless implemented as a **Pi extension** or a documented **operator cron** against the chosen `--session-dir`. We do not duplicate Frink’s gzip tree under `workingDir`.

**Frink analogy (intent, not layout):** we still want the *operator experience* of “logs, summaries, long-term trimming” — that maps to **Pi session JSONL + compaction + optional session-dir under `implStateDir`**, not to a second copy under `workingDir/logs/`.

---

## 6. Constitutional snapshots (run invariants)

To avoid “changing the exam while sitting it,” the governor **freezes** at **run start**:

- Goal / intent snapshot (from `intent.json` or equivalent).
- Evaluation rubric snapshot for **this** run (even if minimal in v0).
- Promotion policy version / thresholds.
- **Editable scope:** explicit allowlist of path prefixes the learner may write to (see §8).

During the run, **Learning** may **propose** changes to rubrics or policy for **future** runs; **Promotion** must not swap the active rubric used to judge **this** run’s outcome after evaluation has begun. (Exact ordering of “evaluate → learn → promote” is implementation detail; the invariant is **no mid-run redefinition of success criteria**.)

---

## 7. “Memory” — intentional minimalism

There is **no** separate memory subsystem in v0.

- **Longitudinal signal** = files under `implStateDir` (code, prompts, extension manifests, optional `ledger.jsonl`).
- **Episode signal** = files under `workingDir` + **Pi session JSONL** (path from §5.2, e.g. under `implStateDir/pi-sessions/` if we set `--session-dir`) + OTel `trace_id` / `pi.session.*` attributes for cross-linking.
- **Frink-inspired sub-agents** may be used for narrow tasks (review, diff sanity, “should we promote?”) but their outputs are **artifacts**, not a dedicated memory layer.

If we add `ledger.jsonl`, it is **optional**, append-only, and lives under `implStateDir`; it is not a prerequisite for v0.

---

## 8. Self-modification and allowed paths

The learner **may change its own behaviour**, including **code** and **Pi extensions**, not only prompts.

**Writable (promotion targets):**

- **`ctx.implStateDir/**`** — primary. Treat as the operator’s **private implementation workspace**: full or partial Pi package tree, extensions, skills, local `node_modules` if vendored here, etc.
- **`ctx.workingDir/**`** — allowed during the episode; anything intended to survive must be **promoted** into `implStateDir` before `run()` returns (or in a final sub-phase).

**Read-only:**

- Jinn client install (except paths explicitly mirrored into `implStateDir`).
- Engine, contracts, and the rest of the monorepo **outside** `implStateDir`.
- Global toolchains except as invoked by the agent (no requirement to sandbox the host).

**Pi ecosystem:** The learner may **read** public Pi docs, example extensions, and community patterns to inform proposals. **Writes** from those explorations must land only under **`implStateDir`** (or `workingDir` then promote), never “random” repo paths.

**Published npm package** (`@jinn-network/default-learner`) is the **seed** when `implStateDir` is empty or on first run; after that, **operator truth** is whatever lives in `implStateDir`, upgraded intentionally (e.g. operator runs `yarn` / copies a new seed) — not silently overwritten by the engine on every run.

---

## 9. Borrowing from Frink (content, not harness)

| From Frink | Use in this design |
|------------|---------------------|
| `prompts/modes/*.md`, base prompts | Phase templates in the Pi package (design / plan / execute / evaluate / learn). |
| Domain hooks, skills | Pi skills or small scripts invoked from Execution / Learning. |
| Sub-agent patterns | Shallow delegation inside **one** run; outputs = files + OTel child spans. |
| Session logs / notebook / gzip retention | **Do not duplicate** — use **Pi’s** `~/.pi/agent/sessions/` (or `--session-dir` under `implStateDir`) + compaction; optional operator cron for old files if Pi does not prune. |
| `loop.sh` / `exec "$0"` scheduling | **Not** the primary model; optional internal “micro-restart” only if Pi supports it without spanning multiple `run()` calls. |

---

## 10. Client integration

1. **Registry:** `default-learner` is the **default** restorer new operators rely on; exact **precedence** vs kind-specific impls (`claude-mcp-*`, baselines) is a **product decision** documented in `buildRestorerImpls` and operator config. (This spec does **not** mandate “first” vs “last” until product locks it; implementation should match whatever `jinn-mono-2zk` + operator UX agree on.)
2. **`run(ctx)`:** construct OTel root span → invoke package `runIntent(ctx)` with `workingDir`, `implStateDir`, `abort`, deadlines → harvest → end span → flush exporters.
3. **Auth:** Agent backend (Claude / Codex / Cursor) is selected per operator environment; auth preflight remains consistent with existing `jinn` UX (exact verbs for non-Claude backends may be follow-up work).

---

## 11. Harvest and delivery

- **No change** to the engine packaging contract: harvest reads **`workingDir`** per existing kind conventions (`OUTPUTS.json`, etc.).
- Internal episode folders (e.g. `workingDir/.episode/`) are **implementation details** unless a kind explicitly includes them in declared outputs.
- **Self-improvement artifacts** that must **not** appear on-chain stay under **`implStateDir`** only.

---

## 12. v0 acceptance criteria (draft)

- [ ] One `run()` = one Pi-orchestrated run with governor phases and frozen invariants.  
- [ ] OTel root span + phase spans for every run; path violations logged; **Pi session** persisted per Pi defaults or `--session-dir` under `implStateDir` (§5.2); **no** duplicate Frink-style `workingDir/logs/` transcript mirror.  
- [ ] All durable self-edits confined to `implStateDir` (+ promotion from `workingDir`).  
- [ ] Next run for the same operator loads from `implStateDir` and sees promoted changes.  
- [ ] Package lives in `jinn-mono` as a separate publishable unit; client depends on it.  
- [ ] No protocol / engine state-machine changes.

---

## 13. Open questions (for you to confirm)

1. **Registry precedence:** Should `default-learner` win every kind until the operator enables a specialised impl, or the inverse?  
2. **Partitioning `implStateDir`:** By `intent.kind` only (`implStateDir/<kind>/…`), or single tree for all kinds?  
3. **Pi embedding:** Spawn `pi` CLI vs in-process SDK — preference for v0?  
4. **Promotion atomicity:** File-level atomic replace, git snapshot, or simple copy-merge?  
5. **`--session-dir` default:** Global `~/.pi/agent/sessions/` vs `implStateDir/pi-sessions/` (recommended for operator isolation) vs per-intent subdir — pick one for v0.  
6. **Cross-intent ledger:** Optional one-line append under `implStateDir/` per `run()` with `{ trace_id, pi_session_path }` for grep without OTLP — yes / no for v0?  
7. **Long-term session pruning:** Rely on Pi / extension / documented cron only — confirm no Jinn-owned gzip mirror.

---

## 14. Summary

| Topic | Decision |
|--------|-----------|
| Harness | Pi governor, single `run()` |
| Telemetry | OpenTelemetry (Jinn correlation) **+** Pi session JSONL / compaction / optional `--session-dir` — **no duplicate** Frink log tree under `workingDir` |
| Episode workspace | `workingDir` |
| Durable self | `implStateDir` only |
| Memory product | None in v0; files + optional JSONL |
| Self-modification | Allowed (code + extensions), path-restricted |
| Frink | Prompt/skill patterns; not primary loop |
| Delivery | Existing harvest / packaging |

---

*End of alignment draft.*

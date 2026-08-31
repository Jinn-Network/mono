# Jinn Local Execution Backend v1

**Date:** 2026-07-27

**Status:** design approved section-by-section in session; architecture and adversarial review
findings resolved; written review pending

**Shape:** `design`

**Scope:** the reference binding of the Task Execution Protocol's backend contract — a
product-neutral component stack that executes sealed Tasks on one machine by spawning agent
harness CLIs under durable supervision: workspace provisioning, executor launching, attempt
custody, honest recovery, typed deliveries, and the evidence-capture join

**Out of scope:** implementation plan and sequencing beyond design granularity; the marketplace
binding and the daemon engine's venue/execution carve (declared impact only); scheduling, retry
policy, and acceptance (application concerns); container/VM isolation (follow-up); remote
execution; evaluation methods (the profiles design's domain)

Companion designs in this stack:

- `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (TEP — the
  contract this backend implements; §12 recovery rules, §14 verbs, §16.1 local-binding
  obligations, §25 Autopilot migration)
- `docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md` (profiles —
  evaluation-as-task, run pinning, discovery-visible facts)
- `docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md` and the
  evidence substrate merged on `integration/evidence-v1` (recorder, repository, local runtime,
  attestation issuer — consumed, never redefined)
- `docs/superpowers/specs/2026-07-23-autopilot-v2-marketplace-session-backend-design.md`
  (the `SessionExecutionBackend` interface it defined is subsumed here per TEP §25; its
  application-side content — adoption receipts, correlation, trust boundary — stands)
- `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` (discovery — not a
  dependency of this backend; deliveries become discoverable via sources operated above it)

## 1. Problem statement

The repo has three local execution stacks and none implements the TEP backend contract:

- **Autopilot (V1 dispatcher + V2 lifecycle)** shares one spawn primitive
  (`spawnCoordinatorSession`) but has no outcome custody at all. Attempt manifests record only
  `preparing | running | exited` plus a PID; a dead PID is reclassified `exited` with zero
  inspection of what the session accomplished (`attempt-workspace.ts:1282-1295`); outcome is
  inferred entirely from GitHub facts on a ~2-hour staleness timer, so a crashed session and a
  slow one are indistinguishable; there is no typed result (the agent mutates GitHub and
  Autopilot re-reads it); there is no cancel verb anywhere in the code; and the parent–child
  exit binding is an in-memory listener, so a dispatcher restart orphans manifests in `running`
  and strands committed-but-unpushed work — the known production failure mode.
- **The daemon's `TaskEngine`** has a genuinely good durable state machine (SQLite `task_runs`,
  optimistic-concurrency transitions, persist-before-invoke, idempotent per-state
  `recoverInFlight`) — but it is venue-coupled (claim/deliver states interleaved with
  execution), takes structured objects rather than sealed bytes, has no first-class cancel, a
  determinism hole at `RUNNING` (a crash mid-run loses the outcome: the daemon cannot
  `waitpid` children it no longer owns, so recovery re-spawns the agent from scratch), and
  capability declaration scattered across half a dozen hot-path gates.
- **The `SessionExecutionBackend`** from the marketplace-session design *is* implemented on
  `origin/next` (`packages/autopilot/src/lifecycle/session-execution-backend.ts`,
  `makeLocalSessionExecutionBackend`, and `marketplace-session-backend.ts`) — and its local
  `recover` returns `completed` on a dead PID, the liveness-only bug in live code, while its
  `cancel` SIGTERMs a bare PID. So this design migrates live code paths, not a paper interface
  (§17).

Every gap is a TEP obligation: honest `observe`, mandatory `recover` with
`matching | absent | contradictory`, idempotent cancel, deliveries from durable records, and
never inferring success from liveness. This design defines the backend that closes them once,
for every product.

## 2. Decision and rationale

**The backend is designed from first principles as a product-neutral component stack** — the
same architecture move as the Evidence Protocol's capture/repository/discovery split — and the
existing products (Autopilot, the daemon's marketplace pipeline) become consumers whose
specifics never leak into it:

```text
Products              Autopilot · daemon marketplace pipeline   (retry, acceptance, scheduling — never here)
Backend assembly      TEP verbs; imperative and policy-free
  Workspace           per-attempt directory contract; two-phase provisioning;
  Provisioner         input materialization from sealed bytes; declared-outputs harvest
  Executor Launcher   task profile → hermetic harness invocation (claude-code, codex,
                      hermes, cursor); LaunchPlan; result-envelope interpretation
  Attempt Supervisor  process custody: shim, WAL-intent journal, fingerprints,
                      group-kill ladder, reconciliation-based recovery
```

The decomposition is production-validated (§3): Nomad's task-driver architecture is
near-isomorphic to it component-for-component, and the survey found a hard correlation — every
system that merges the launcher into the execution call (BuildKit, the GitHub Actions worker)
has no crash recovery, because merging leaves no serialized attempt description to recover
against.

Rejected alternatives:

- **Shape the backend around Autopilot's current machinery.** Autopilot is in flux, and its
  machinery is the *worst* conformance candidate (no outcomes, no results, no cancel). It
  adopts first (§11), but as a consumer walkthrough, not a design driver.
- **Promote the daemon's `TaskEngine` to the contract.** Its state machine conflates venue and
  execution; carving it is real work that belongs with the marketplace-binding design, and its
  `RUNNING` hole needs the supervisor regardless.
- **A standalone supervisor daemon** (containerd's topology). Unnecessary: the attempt shim
  (§6.1) gives outcome custody that survives host restarts, so the backend can be a library
  embedded in whatever product hosts it. The shim is the only new process this design
  introduces. One consequence made normative in §5: because the backend is an embedded library
  with a durable state root, exactly one instance may own a state root at a time — enforced by
  an exclusive lock, since `seq` monotonicity and the whole recovery model rest on a single
  writer.

## 3. Standards and production-practice audit

Two research passes: supervision mechanisms, then job-runner architectures, agent runtimes, and
batch-API state models. What is taken, from where:

| Source | Status | What is taken |
| --- | --- | --- |
| containerd shim architecture | production, universal | outcome custody delegated to a per-workload process that shares fate with the work, not the manager; persisted exit status; reconnect-by-walking-disk |
| runc / libcontainer | production | `(pid, start-time)` fingerprint as the PID-reuse guard — no liveness conclusion from a bare PID |
| Kubernetes kubelet / CRI | production | recovery by enumeration + reconciliation (re-list, rebuild, trim reality to records); identity-tagging reality at spawn; imperative policy-free runtime interface ("no transition uninstructed"); status truthfulness (never author an exit code) |
| Nomad task drivers | production | the near-isomorphic component split; `Capabilities` + `Fingerprint` two-channel declaration; Stop ≠ Destroy; reattach-failure → `lost`, never success; alloc-dir workspace contract; typed TaskEvents with `FailsTask` |
| Temporal | production | liveness only from durable signals (timeouts, heartbeats) — process death produces no event; first-terminal-wins per attempt nonce; heartbeat progress records |
| systemd | production | the stop ladder (TERM → grace → KILL → verify-empty) applied to the tracked set; PID files as anti-pattern |
| GitLab Runner custom executor | production (maintenance) | per-stage contract with distinct build-failure vs system-failure exit codes; harvest as a distinct always-run stage with on-success/on-failure variants |
| GitHub Actions runner | production | the process-boundary supervisor validation; the JSON-command/response-file/opaque-state launcher-contract template; the orphaned-process cancellation bug as the group-kill motivation |
| Bazel REAPI | production | outputs declared at submit; missing declared output = recorded omission, not failure; digest-at-harvest; stdout/stderr as first-class digested outputs; phase timestamps in the result |
| BuildKit executor | production | `ValidExitCodes` declared by the launcher; a distinct "actually started" event; the no-recovery counterexample |
| GA4GH TES | standard | executor/system blame (already in TEP); COMPLETE-includes-upload; `view` split keeping logs out of cheap polls |
| Kubernetes Job `podFailurePolicy` | production | blame stamped by the killer at kill time (`DisruptionTarget`), never post-hoc forensics; disruption grants a free retry (application-side here) |
| AWS Batch / ECS | production | first-class per-attempt records (`attempts[]`); preparation time excluded from the executor's deadline; coarse code + categorized reason two-granularity taxonomy |
| Slurm | production | the durable accounting row outliving the scheduler; exit:signal pairs; ran-too-long vs never-started distinction (payload detail here) |
| GCP Batch / Cloud Run Jobs | production | `UNEXECUTED`'s guarantee — terminal `rejected` means never-executed, making resubmission safe |
| Claude Code headless / Agent SDK | production | the typed result envelope (limit-exhaustion distinct and resumable); `--bare` hermetic invocation; documented SIGTERM teardown; per-run session state via `CLAUDE_CONFIG_DIR`; NDJSON stream teed as it streams |
| Codex CLI / cloud | production | two-phase provisioning (setup with network+secrets → sealed agent phase, secrets scrubbed); `--output-schema`; hermeticity flags |
| ACP (Agent Client Protocol) | emerging standard | cancel as a protocol event confirmed by a terminal `cancelled` stop reason; stop-reason enums; capability negotiation at init |
| E2B / Modal sandboxes | production | environment as addressable resource; expiry that preserves evidence (`onTimeout: pause` posture); detach/reattach handles |
| Crash-consistency literature (ALICE, fsync studies) | research | atomic publish = temp + fsync + rename + dir-fsync; failed fsync is poison; WAL-intent asymmetry (record intent first, make action independently discoverable) |
| Evaluation Runner design (`integration/evidence-v1`) | approved design, unimplemented | `interruptionBehavior` re-execution-safety declaration; seal-once prepared-bytes checkpoint; `recoveryAdvice`; its evaluator-adapter core composes and its host-orchestration half is superseded (§10.4, §17) |

## 4. Design tenets

1. **Outcome custody shares fate with the attempt, never with the host.** The shim is the only
   new process; the backend is a library.
2. **Records first; reality reconciled to records, never promoted over them.** Terminal records
   are absorbing; live processes contradicting them are killed and the contradiction surfaced.
3. **Liveness is never evidence of outcome; absence of process is never evidence of
   completion.** There is no code path from PID absence to a terminal state without an outcome
   record or a reconciliation classification.
4. **Imperative and policy-free** (CRI's rule): the backend applies no transition uninstructed.
   Retry, scheduling, acceptance, and budgets live in applications; custody policy (kill
   ladders, grace windows) lives in the supervisor; nothing else holds policy.
5. **Product-neutral components with their own contracts**, independently testable against the
   conformance kit. A launcher with state is a supervisor smell; a supervisor that knows what a
   harness is has leaked.
6. **Cancel is never the outcome channel.** Idempotent; outcome — including completed-during-
   cancel — is read only from observe/deliveries; state disposal is a separate retention act.
7. **TEP's frozen vocabulary is untouched.** Backend-internal phases, blame reasons, and
   preemption ride as observations and payload detail, exactly where TEP put them.

## 5. Component stack and responsibilities

| Component | Owns | Never touches |
| --- | --- | --- |
| Attempt Supervisor | process custody, journal, phases, recovery, cancellation, deadline enforcement, harvest invocation | harness semantics, git, GitHub, marketplaces, evidence record contents |
| Workspace Provisioner | the per-attempt directory contract, two-phase provisioning, input materialization, output collection mechanics | spawning, outcome interpretation |
| Executor Launcher | LaunchPlan (argv/env/cwd/validExitCodes/result contract), harness capability declaration, result-envelope decoding | spawning, retry, secrets beyond declared forwards, state |
| Backend assembly | TEP verbs, observation projection, Delivery assembly, `capabilities()`, the evidence join | scheduling, queues, settlement, application authority |

One or more backend instances per hosting product, each scoped to one execution role and carrying
its own private state root, attempt namespace, executor identity, and purpose-scoped keys. A host
that composes solver and evaluator roles therefore creates two instances with disjoint roots and
keys; it does not multiplex roles through one root or widen the backend API. **Exactly one
instance may own any one state root at a time**: on startup the assembly takes an
exclusive advisory lock on `meta/backend.lock` (flock, held for process lifetime) and holds it
across all `submit`/`recover` work; a second instance finding the lock held MUST fail
`submit`/`recover` with `backend-unavailable` (capacity detail: "state root locked by a live
instance") rather than proceed — the single-writer guarantee `seq` monotonicity and recovery
depend on. Nothing prevents pointing a fresh instance at the root once the prior lock is
released.

The **assembly is the capacity gate**: it counts live attempts (from the journal fold) against
the instance's configured concurrency and rejects `submit` over the ceiling. The backend never
schedules: backpressure is a typed `submit` rejection — `backend-unavailable` with capacity
detail — not queueing policy. (The `backend-unavailable`-for-a-full-backend category fit is
recorded as a TEP follow-up, §20; the alternative is a dedicated `capacity-exhausted`
category.)

## 6. The Attempt Supervisor

### 6.1 The attempt shim

One small process per attempt between the supervisor and the harness — the containerd-shim
pattern for plain processes. **The shim is spawned by the supervisor with `JINN_ATTEMPT_*`
already in its own environment**, so the attempt identity is present continuously from the
instant the shim process exists — through the pre-exec window and into the harness (env is
inherited across fork and only reset at the harness's exec) — closing the invisible-orphan gap
that a harness-only tag would leave open between fork and exec. Its contract is behavioral (v1
ships it as a self-contained Node script in the backend package):

1. Becomes session/process-group leader (`setsid`); on Linux sets child-subreaper so
   daemonizing grandchildren re-parent to it, not init. On Linux the shim additionally places
   the harness subtree in a delegated cgroup where available, so the harness's fate is bound to
   the attempt, not merely co-grouped.
2. **Traps SIGTERM/SIGINT/SIGHUP and ignores them**: the shim is a group member and must
   *survive* signals aimed at the harness subtree, because it is the sole outcome recorder on
   every path (normal exit, cancellation, deadline). It relays a cancellation to the harness
   subtree, never to itself.
3. Writes its `(pid, start-time)` fingerprint plus the attempt nonce to `meta/shim.json`
   (atomic write). Every liveness conclusion passes through this fingerprint; a bare PID is
   never trusted.
4. Execs the harness with the same attempt identity in its environment; secret forwards are
   resolved from `secrets/` **here, at exec, and never written to `meta/`** (§8.1).
5. Touches `meta/heartbeat` periodically with a monotonic timestamp alongside wall-clock.
6. Waits on the harness; on exit writes `meta/outcome.json` —
   `{attemptId, nonce, exitCode, termSignal, startedAt, finishedAt}` — via temp-file, fsync,
   rename, directory-fsync (a failed fsync is poison, not a retryable blip). Then reaps
   stragglers, courtesy-kills the group, and exits.

A restarted supervisor has lost `waitpid` rights over its former children forever; the outcome
file is readable regardless of who is alive. Group-kill ordering uses zombie-pinning: the shim
does not reap the harness leader until after the group signal, so the PGID cannot be recycled
under the kill. **Fate-sharing is best-effort, not absolute** (tenet 1 restated honestly): a
`kill -9` of the shim, or an OOM kill, can remove the custodian while the harness lives on. The
Linux cgroup binding narrows this; on macOS and cgroup-less Linux it is a named residual (§12),
and recovery has a defined action for it (§6.4: live group members under a dead shim → kill
ladder, then `lost`).

### 6.2 The journal

Append-only, per-attempt, typed events:
`{attemptId, seq, type, time, displayMessage?, details{}, failsAttempt?}` — machine details
plus human message (the Nomad TaskEvents shape), uncapped in storage, capped only in list
views. Rules:

- **Intent before action.** `spawn-intended` — carrying the serialized LaunchPlan (§8.1) — is
  appended and fsynced before fork/exec; `spawned` (with the shim fingerprint) after. A
  dangling intent is benign (recovery probes reality); an untracked action is an invisible
  orphan, which env-tagging closes.
- **The journal is the source of truth; TEP observations are its projection.** The backend
  emits CloudEvents from journal events; a rebuild re-emits identical (`source`, `id`) pairs
  per TEP §10.1. **A journal event's fsynced append strictly precedes emission of its projected
  observation** — so a crash can never leave a consumer holding a `(source, id)` the rebuilt
  stream will not re-emit identically. `seq` is a durable per-attempt monotonic counter derived
  from the last intact journal record (`max(seq)+1` after a torn tail), never an in-memory
  counter. Storage engine (JSONL with torn-tail tolerance vs SQLite events table) is an
  implementation profile; the contract is the event shape, the append-before-emit ordering, and
  the pure fold.
- **Per-attempt terminal uniqueness** is enforced at append: a second terminal for one nonce is
  rejected and flagged (TEP fold rule 4's first-terminal-wins, enforced at the source) — with
  the one sanctioned exception that a `lost` prior terminal may be superseded by a corrective
  terminal without flagging (§6.4, TEP §10.4 rule 6).
- **A submission-scoped log segment**, keyed by Submission URI, holds `submission-accepted`,
  `submission-rejected`, and `submission-closed` events — the facts that exist before (or
  without) any Attempt. A rejected Submission is therefore durable and distinguishable from a
  never-seen one after restart, and `observe(SubmissionUri)`/`watch(SubmissionUri)` (which TEP
  §14 requires backends accept) have a defined substrate.

### 6.3 The attempt record

The durable per-attempt document, folded from the journal plus harvest, synthesizing the best
production shapes (Batch `attempts[]`, Nomad events, TES logs, Slurm accounting):

- identity and lineage: attempt URI, nonce, task digest, submission URI, attempt number
  (injected into the executor env), `supersededBy`/`priorAttempt` annotations where the
  application declares them;
- phase timestamps: created / prepare-started / exec-started / exec-finished / harvested /
  recorded — preparation and harvest never bill against the execution deadline;
- outcome: exit code **and** signal, the launcher's decoded result envelope, blame verdict
  `{blame: task|infrastructure, reasonCode, message, matchedRule}`, optional `recoveryAdvice`
  (`retry-safe | resume-with-session | do-not-retry` — a deliberate three-value reduction of the
  Evaluation Runner design's five-value enum, since the two extra values there,
  `retry-step`/`operator-action-required`, are application-policy distinctions above this
  backend), and the declared `interruptionBehavior`
  (`repeatable | recoverable | nonrepeatable`) in force;
- outputs manifest: per artifact `{path, sizeBytes, sha256, mediaType?}`; stdout/stderr and
  the teed harness transcript as digested first-class entries;
- executor identity: harness name/version, advertised capability strings, harness session ID,
  shim fingerprint, workspace path, resolved LaunchPlan digest;
- resource usage where cheap (elapsed per phase; peak memory when the platform offers it).

### 6.4 Recovery

`recover` folds the journal to expected state, probes reality — shim fingerprint and
process-group scan for liveness, then the outcome file (nonce-checked) — and classifies per TEP
§12.2. "Fingerprint alive" throughout means *the shim* fingerprint verified against the process
table; a live group member without a live shim is the distinct dead-shim case below.

| Journal phase | Reality shows | Classification → action |
| --- | --- | --- |
| engaged, no spawn-intent | no process, no outcome | **absent, never-executed** → `rejected` (resubmission-safe, §7.2) — nothing ever ran |
| spawn-intended | no process, no outcome | **absent** → `lost`, blame infrastructure |
| spawn-intended or running | env-tagged live process/group, no live shim | **orphaned** → run the kill ladder (custody is unrecoverable — no shim can capture the outcome), then `lost`; append a reconciliation event naming the killed PIDs |
| running | shim fingerprint alive, no outcome | **matching** — resume supervision; re-arm relative timers from `exec-started` on the monotonic clock (§6.6) |
| running | outcome file present (nonce matches), process gone | **matching (late)** — ingest the outcome, append the terminal event |
| running | outcome file present, **nonce mismatch** | **stale/foreign** — ignore the outcome file (treat as absent); reconcile as if no outcome |
| harvesting | process gone | **resume** — re-run harvest idempotently (`out/` is frozen once the process is gone), then record and terminalize |
| recording | Delivery checkpoint present | **resume** — re-write the Delivery from the seal-once checkpoint (§9.1), never re-assemble; emit `delivery-recorded`, terminalize |
| terminal | shim-fingerprint-verified survivors alive | **contradictory** — fail loud; terminal record wins; survivors get the kill ladder; reconciliation event appended |
| two non-`lost` terminals, one nonce | — | **contradictory** — first by `seq` wins; persistent flag |
| prior `lost` + a later corrective terminal | outcome recovered from disk | **corrected** — accept the corrective terminal, **no** `contradictory` flag (TEP §10.4 rule 6) |

Recovery never blind-respawns: agent work is side-effecting, `interruptionBehavior` may be
`nonrepeatable`, and retry is the application's decision through a new Submission. The corrective
row is the one sanctioned terminal-to-terminal transition; every other is `contradictory`.

### 6.5 Cancellation

Idempotent and never the outcome channel. On an already-terminal attempt, `cancel` returns a
`CancelAck` naming the terminal state. Otherwise: append `cancel-requested` → emit the
observation → **the supervisor tells the shim to cancel, and the shim signals the harness
subtree — never itself** (the shim traps and survives these signals, §6.1, so it remains the
sole outcome recorder): SIGTERM to the harness subtree → configurable grace (default 10 s,
overridable) → SIGKILL to the subtree → poll until the subtree is empty, **bounded by a
configurable ceiling** (default 30 s). The shim writes the true `meta/outcome.json` on every
path — a natural `exit 0` that races ahead of the kill is recorded as such, which is exactly
what lets `delivered`/`failed` legitimately stand (TEP §12.1); death by our signal is recorded
as the cancellation. Then **harvest still runs** on whatever `out/` holds → terminal
`cancelled` unless the recorded outcome says otherwise. If the poll ceiling elapses with the
subtree non-empty (an un-killable escapee, §12), the supervisor terminalizes anyway —
`failed[infrastructure]` with a "residual live processes" annotation carrying the surviving
PIDs — rather than hanging non-terminal (the §12 "named honestly" posture applied to a
terminal). Records and workspace are kept; disposal is retention policy (Stop ≠ Destroy).

### 6.6 Deadline enforcement and heartbeats

With `deadlineEnforcement: active`, the supervisor arms a timer from the Submission deadline
(execution phase only) and on expiry runs the cancellation ladder with terminal `expired`
(explicit terminal observation, clock-skew grace first, per TEP §10.4 rule 5). Relative
durations (`maxAttemptDurationMs`) are re-armed after restart from `exec-started` on a
**monotonic clock** where the platform offers one, so a backward wall-clock jump across restart
cannot misfire them. One honest limit, stated so `active` is not over-promised: if the
supervisor is *down* when the deadline passes and the orphaned harness's shim records a
`delivered` outcome after it, recovery ingests that outcome as `delivered` — active enforcement
bounds wall-clock only while the enforcer is alive; the deadline miss during downtime is
surfaced on the terminal, not silently converted to `expired`. Heartbeat staleness (default
interval 15 s, stale after 3 missed) is observational in v1: it emits a degradation
observation; killing a hung but undeadlined harness is application policy expressed through
`cancel`.

## 7. The Workspace Provisioner

### 7.1 The per-attempt directory contract

```text
<attemptsRoot>/<attemptId>/
  input/          read-only after provisioning: sealed Task bytes verbatim, the
                  dispatch-context artifact (TEP §9.3), resolved input artifacts
  work/           executor cwd and scratch — plain dir or git worktree at an exact OID;
                  the only dir the executor may assume writable
  out/            the delivery contract: only files here are collected
  logs/           stdout/stderr/harness NDJSON — written by the backend, outside the
                  executor's write surface; survive executor death; streamable mid-run
  harness-state/  per-attempt harness session home (CLAUDE_CONFIG_DIR / CODEX_HOME);
                  transcripts supervisor-owned, keyed by attempt, never by cwd hash
  secrets/        0700; injected credentials; never collected or listed; wiped at terminal
  tmp/            TMPDIR; wiped at terminal
  meta/           backend-owned, read-only to the executor: shim.json, heartbeat,
                  outcome.json, the journal, the attempt record
```

Rules: **env-var indirection only** (`JINN_ATTEMPT_*` plus attempt identity — concrete paths
are never promised, so isolation modes can change under the same contract); **retention is
per-directory** (`meta/`, `logs/`, `out/`, `harness-state/` survive into the durable store;
`secrets/` and `tmp/` wiped immediately at terminal; `work/` GC'd under TTL and disk-floor
knobs); fresh directory per attempt, attempt ID in the path. A **per-attempt cumulative disk
quota** is enforced during execution (not only at harvest), and `meta/` is placed so that a
data-dir fill in one attempt cannot deny an outcome write in another (a reserve, or a distinct
device where configured) — so one attempt's disk-fill cannot poison a sibling's `outcome.json`
into a false `lost`.

### 7.2 Two-phase provisioning

The **setup phase** runs with the provisioner's authority — network and credentials available:
resolve declared input descriptors by digest with re-hash on fetch (`content-corruption` on
mismatch; capability grants for gated inputs), materialize the profile's workspace kind (plain
dir by default; a detached git worktree at an exact OID for repository/session profiles —
provisioner implementations are selected by profile), write secrets into `secrets/`. Then the
boundary: the **execution phase** receives only the launcher's allowlisted environment —
setup-phase credentials never ride into the harness env beyond declared forwards (the Codex
cloud split, applied locally).

A failure during provisioning is terminal **`rejected`**, carrying the never-executed
guarantee that makes resubmission safe. An infrastructure failure after execution starts is
`failed[infrastructure]`. The line is `exec-started` in the journal.

### 7.3 Input materialization

Sealed Task bytes are handed to the executor exactly as sealed (TEP §16.1 — the bytes are the
Evidence Task artifact; no projection). The dispatch-context artifact is written into `input/`
and registered in the evidence capture's input set (§10.1), closing the anti-retro-claiming
loop. `input/` is read-only after setup; a mutation detected at harvest is an integrity
violation recorded in the attempt record.

### 7.4 Harvest

Supervisor-invoked, always-run — after success, failure, cancellation, and deadline expiry —
and gated on a **verified-empty harness group on every path** (not only the cancel path), so a
stubborn background child cannot still be writing `out/` while harvest digests it:

- Collection is from `out/` only: the Task's declared output paths plus the `out/` tree. A
  missing declared output is a **recorded omission, not a failure** — the outcome verdict
  comes from the exit record and result envelope, never from output presence.
- **Every entry is resolved with `O_NOFOLLOW`/realpath, and any symlink whose target escapes
  `out/` is rejected, not dereferenced** — recording an integrity violation on the attempt
  (mirroring `input/`-mutation handling). This closes the exfiltration path where a hostile
  executor plants `out/creds → ../secrets/token` or `out/key → ~/.ssh/id_rsa`; harvest running
  before the terminal `secrets/` wipe would otherwise collect them. (Secret *content* the
  executor deliberately copies byte-wise into `out/`, or emits to stdout, cannot be prevented
  by the backend — that containment is application/evidence scrubbing, stated honestly in §12,
  not something the `secrets/` wipe covers.)
- Everything collected is digested at collection; stdout/stderr and the teed transcript are
  digested as first-class evidence artifacts.
- `delivered` is set only after harvest completes **and** the Delivery is durably written
  (TES's COMPLETE rule meeting TEP §16.1's durable-before-announced). Harvest failure on an
  otherwise-successful run is `failed[infrastructure]`, with collected partials recorded.
- Recovery re-runs harvest idempotently (§6.4 harvesting row): with the process gone `out/` is
  frozen, so re-collection is deterministic and never drops outputs a partial harvest missed.

## 8. The Executor Launcher

### 8.1 The contract: launchers plan, the supervisor spawns

A launcher is a pure function from **`(TaskView, workspace paths, attempt identity)`** to a
**LaunchPlan**. The **TaskView** is what the assembly hands the launcher after parsing the
sealed bytes (TEP §14's "parsed views alongside" pattern): the parsed Task, the **effective
merged requirements** (Task requirements ⊎ the Submission's requirements map, resolved by the
profiles design's §5.1 comparison classes — the launcher never re-reads raw sealed bytes), and
the resolved, digest-pinned profile document. This is the path by which Submission-level run
pinning — `harness`, `model`, `loadout`, `isolationPolicy`, and `effort` as a floor — reaches
the invocation; it is the reason the launcher's input is a *view*, not the Task alone, and it
is how a Submission's `effort` (§11.1) becomes an argv/env flag rather than being silently
dropped.

The LaunchPlan: `{argv, env, cwd, validExitCodes, blameExitCodes?, resultContract,
interruptionBehavior}`.

- **`env` carries secret forwards as references into `secrets/` (handles), never resolved
  values.** The shim resolves them at exec (§6.1 step 4); resolved secret values are never
  written to `meta/`. This is what keeps the journaled plan free of secrets and is also why
  plan determinism holds (§16) — secret *values* rotate, secret *references* do not.
- **`validExitCodes`** declares which exit codes are non-failing; **`blameExitCodes`** is an
  ordered first-match rule list mapping specific exit codes (and death-by-signal) to
  `{blame: task|infrastructure, reasonCode}`, with the default — no rule matched, exit outside
  `validExitCodes` — being `blame: task`. The matched rule is recorded as the attempt record's
  `matchedRule`. The supervisor needs zero per-harness knowledge to fill the blame verdict.

It never spawns; the supervisor executes the plan through the shim, and **the LaunchPlan is
serialized into the journal with the spawn-intent** (secret references, not values) — recovery
holds the exact invocation, not a recipe for recomputing one.

Obligations: **hermetic invocation always** (`--bare`-class flags; context injected explicitly
via flags and provisioned files; harness state pointed at `harness-state/`); **environment
discipline** (the existing allowlist base, attempt identity, workspace indirection; secrets
only as declared reference-forwards from `secrets/`; secret-shaped ambient keys stripped
categorically); **run-pinning enforcement** (the profiles design assigns the local binding the
`enforced` posture — the pinned harness/model/loadout is what actually runs, or `submit`
rejects; loadouts are materialized and digest-verified in the provisioner setup phase, §7.2,
fail-closed); **two-channel capability declaration** (static: supported task profiles, media
types, structured-output and resume support, `interruptionBehavior` defaults, and the
`runPinning` comparison-class support the profiles design requires on `BackendCapabilities`;
dynamic: `probe()` for binary/auth/version readiness).

### 8.2 Result interpretation

The launcher owns decoding the harness's terminal envelope — the one place harness knowledge
touches outcomes — under one hard precedence rule: **the exit code and termination signal are
authoritative for the fail/not-fail axis.** An exit outside `validExitCodes`, or death by
signal, is `failed` (blame per `blameExitCodes`) and can **never** be overridden to `delivered`
by a printed envelope — the exit record is the one signal a harness cannot forge, so a harness
that prints `{"subtype":"success"}` and then exits 1 or segfaults is `failed`, not a
successful delivery. The envelope may only *refine* the outcome **within** the not-failed class.

- claude-code mapping (envelope refining a within-`validExitCodes` exit): `success` →
  `delivered` (outcome `fulfilled`); `is_error` / `error_during_execution` → `failed[task]`;
  **limit exhaustion (`error_max_turns`, `error_max_budget_usd`) → `delivered` with outcome
  `partial`** and a limit-exhausted reason plus `recoveryAdvice: resume-with-session` —
  exhaustion is distinct and resumable, never generic failure. The continuation is
  application-side: a new Submission referencing the prior session artifact, using the harness's
  own resume. (A `delivered`/`fulfilled` run whose `out/` is empty is still `delivered` with an
  empty outputs manifest — presence of outputs is never the verdict, §7.4 — so an honest empty
  result and a lying one are distinguished by the exit record, not by output count.)
- A process exit *within* `validExitCodes` with no terminal envelope falls back to the exit
  record: not-failed, outcome `fulfilled`, no envelope refinement. The envelope is preferred
  evidence for the outcome *shade*, never required, and never authoritative over the exit
  record for fail-vs-not-fail.
- **Structured output**: when the task profile declares an output schema, the launcher passes
  it through (`--json-schema` / `--output-schema`) and the validated object is collected as a
  first-class output artifact alongside the envelope, never instead of it.
- **Correlation annotations**: harness name/version, advertised capability strings from
  `system/init`, and the harness session ID enter the attempt record.

### 8.3 v1 launchers

Four real: **claude-code** (generalizing the daemon's `ClaudeCodeHarnessAdapter` and
Autopilot's coordinator spawn, which collapse into one launcher — what made the coordinator
spawn special was application authority, which stays in Autopilot), **codex**
(`exec --json` + schema flags), **hermes**, **cursor** (`cursor-agent` headless — parity with
Autopilot's existing runtime selection). Plus the conformance kit's deterministic **fake
launcher**. The set is open: adding a launcher is implementing the contract, never a backend
or protocol change.

### 8.4 What launchers never do

Spawn, retry, touch secrets beyond declared forwards, interpret outputs beyond the declared
result contract, or hold state.

## 9. The backend assembly

### 9.1 TEP verbs

- **`submit(taskBytes, submissionBytes)`** — validate and seal-check both documents;
  byte-exact idempotency per TEP §12.2 (same key + identical bytes → existing ack; same key +
  different bytes → `submission-conflict`); **honor-or-reject every Submission requirement**
  against `capabilities()` before any Attempt exists — a mandatory requirement, an `attempts`
  bound outside the declared `{maxTotal: 1..1, maxConcurrent: 1..1}` v1 support, an
  `evaluationRequirements` block with no interpreting deployment profile, or a `closeAt` the
  backend cannot honor is a typed `unsupported-requirement`/`submission-rejected`, journaled to
  the submission-scoped segment (§6.2) and never a silent degradation (TEP §8). On acceptance:
  emit `submission-accepted`; mint the Attempt URI (random `urn:uuid` at engagement, TEP
  §9.2/§16.1; journaled); emit `attempt-engaged` (pinning this backend as the authoritative
  observation source, carrying the dispatch-context descriptor); provisioner setup → launcher
  plan → journal spawn-intent → shim spawn. `closeAt` and deadline expiry, when honored, emit
  `submission-closed`/`expired` respectively.
- **`observe(ref)`** — the journal fold: derived state plus log position; distinguishes
  running, terminal, and unknown; structurally cannot infer success from liveness.
- **`watch(ref, cursor?)`** — optional; resumable tail over the observation projection,
  cursoring on the fixed-width sequence.
- **`cancel`** — §6.5. **`recover`** — §6.4's report.
- **`deliveries` / `fetchDelivery`** — list and fetch exact sealed Delivery bytes. The
  Delivery is assembled at the recording phase from the attempt record: outcome verdict,
  output descriptors, evidence references, `supersedes` for same-Attempt re-deliveries.
  **Seal-once checkpoint**: the Delivery bytes are assembled once and checkpointed with the
  §6.1 atomic-publish discipline (temp + fsync + rename + dir-fsync), then reused verbatim on
  any recovery — never re-assembled (re-assembly with fresh timestamps would orphan the digest;
  the client engine's `manifest_generated_at` lock is this rule's precedent). A torn checkpoint
  is recovered by re-read, never re-assembly. Durably written before `delivery-recorded` is
  emitted.
- **`preflight()`** — optional: launcher probes, provisioner probes (roots writable, disk
  floor), shim self-test (a no-op attempt through the full path). Application-level preflight
  (Autopilot's credential attestation) layers above.

### 9.2 Observation projection

Journal events project deterministically onto TEP observation types (`submission-accepted`,
`attempt-engaged`, `attempt-started`, `progress`, `cancel-requested`/`-acknowledged`,
`execution-observed`, `delivery-recorded`, `attempt-terminal` with blame and reason).
Backend-internal phases ride as `progress` payload detail. Rebuilds re-emit identical
(`source`, `id`) pairs.

### 9.3 `capabilities()`

Assembled, not hand-maintained: task profiles = launcher declarations ∩ provisioner workspace
kinds; media types and artifact ceilings from provisioner config; `cancel`/`watch`/`preflight`
true; `confidentialInputs: true` (the setup phase resolves capability grants, §7.2);
`fetchArtifact: true` (harvest holds artifact bytes locally); `evidenceCapture` from recorder
availability (§10.2); `signedObservations`/`signedDeliveries` from trust-layer key configuration
(unsigned in a local trust domain — core-vs-profile as everywhere); `deadlineEnforcement:
active`; `attempts` bounds = `{maxTotal: 1..1, maxConcurrent: 1..1}` in v1; and a **`runPinning`
block** declaring the comparison classes the binding enforces (the profiles design requires this
on `BackendCapabilities`) plus the harness inventory from registered launchers, with the
`enforced` posture. Dynamic readiness lives in `preflight`, not `capabilities()` — statements
vs proof, per TEP §15.

## 10. Evidence integration

### 10.1 The recorder join

TEP §16.1 placed Evidence Capture "in the supervising control plane beside the executor" — the
Attempt Supervisor is that control plane:

| Evidence component | Join point |
| --- | --- |
| Evidence Task artifact | The sealed Task bytes in `input/` — same sha256, no projection |
| Recorder captured inputs | The `input/` set including the dispatch-context artifact — what makes the marketplace `dispatch-binding` check possible |
| Runtime Specification / Observation | The journaled LaunchPlan (planned) and shim/journal facts (ran) |
| Evidence Results | The harvest manifest digests — the Result binds the same sha256 the Delivery outputs carry |
| Finalization receipt | `{family, digest}` + Execution ID into the Delivery's `evidenceRecords`/`executionIds`; the supervisor emits `execution-observed` with the Execution `urn:uuid` |
| Repository / journal / catalog | Consumed via injected contracts: `runtime.repository` (`EvidenceRepository`) and `runtime.catalog` (`EvidenceCatalogReader`) are contract types the host wires; indexing-await is a narrow assembly-owned port the host implements over the `evidence-local-runtime` composition's `awaitIndexed` — so `assembly` types against contracts and the injected port, never against the composition package directly (§15) |

### 10.2 Capture posture

`evidenceCapture: none | available | always`. Local trust domains may run without capture or
best-effort; under `always` (which the marketplace profile requires), a capture failure is
`failed[infrastructure]` — evidence is not optional where settlement-grade consumers depend on
it. The recorder's `finalize` receipt must precede `delivered` (its `{family, digest}` and
Execution ID go into the Delivery); catalog *indexing* does not gate `delivered` — the assembly
awaits the receipt, not the projection.

### 10.3 Evaluation is the same backend

There is no separate evaluation runner process model. An evaluation is an evaluation-profile
Task executed as an ordinary Attempt — same shim, journal, harvest — whose Delivery output is
the evaluator-signed Result Evaluation Statement (profiles design §9). The daemon already runs
evaluations through its one engine; this design makes that the architecture rather than a
coincidence.

### 10.4 Evaluation Runner design reconciliation

The approved-but-unimplemented Evaluation Runner design (`integration/evidence-v1`,
2026-07-26) splits at its own §5 ownership boundary:

- **Composes as-is** (the evaluation harness's normative core): the evaluator-adapter contract
  (§11 `evaluate(…) → CompletedEvaluation`), evaluator registrations (§10, including
  `interruptionBehavior` §10.3, adopted stack-wide by this design), and the Attestation Issuer
  composition (§17) producing the signed Result Evaluation — byte-identical to the evaluation
  Delivery payload the profiles design requires. Its "operational failure never becomes a
  failing verdict" rule (§18) is the profiles design's unscorable taxonomy, aligned. The
  delivered verdict is a DSSE envelope signed by the **evaluator Agent's key** (profiles §9.2),
  which arrives to the harness as a `secrets/` reference-forward resolved from a
  `capabilityGrant` — a deliberate change from the Runner's host-controlled signer isolation
  (its §5.5/§23.4), now that signing happens inside the executor rather than a host-side Runner.

  > **Amended 2026-08-03 (`25924bd4a`): this in-executor signing premise is reversed.** The
  > sandbox holds no signing key — the evaluation harness launcher grants `secretForwards: []`
  > (`evaluation-harness/src/launcher.ts:94-95`) and the composition layer rejects any grant
  > on the evaluator-sealed input (`client/src/daemon/native-evaluator-composition.ts:291-293`)
  > — because an untrusted sandbox is not a place to put signing capability. The sandbox instead
  > writes an **unsigned** Result Evaluation statement to `out/verdict`; the **host** parses it,
  > re-serializes it to canonical bytes, and refuses to seal/publish unless the reserialized
  > bytes are byte-identical to what the sandbox wrote
  > (`client/src/daemon/native-evaluator-composition.ts:343-345`, fail-closed on mismatch) —
  > then the host seals the DSSE envelope with the evaluator Agent's key. This preserves the
  > same integrity property (the delivered verdict is exactly what the sandboxed evaluation
  > produced, unmodified) without ever handing signing capability to executor-controlled code.
  > The reversal is sound and not reopened by this note; it is recorded here because two
  > approved designs (this one and the
  > [operator-daemon composition design](./2026-07-30-operator-daemon-composition-design.md#4-the-composed-operator-runtime--loop-map))
  > still describe the superseded in-executor-signing shape.
  >
  > **Further amended 2026-08-30, recording the 2026-08-12 repair
  > (`f32da275a`, PR #2580): the re-serialization half of the note above is
  > superseded; its conclusion stands.** The host does
  > *not* re-serialize the statement to canonical bytes and compare. That guard
  > compared the harness's output against trust-core's compact JCS encoding,
  > while the harness writes the attestation family's pretty spelling, so the two
  > could never agree and every real evaluation threw. The host now checks the
  > producer's own spelling (`canonicalAttestationJsonBytes`, the encoder
  > `buildResultEvaluationPayload` writes with) and seals *the sandbox's exact
  > bytes* via `sealSignedPayload` — still fail-closed on mismatch. The integrity
  > property is unchanged and in fact strengthened: the DSSE payload is now the
  > graded file itself rather than a re-encoding of it. The grant-free and
  > no-key-in-sandbox premises are also unchanged. Cite these by symbol, not by
  > line: the file is now `operator/src/daemon/native-evaluator-composition.ts`
  > (renamed from `client/` on 2026-08-16 in `5a4b537cf`), the grant rejection is its
  > `stateBackedProvisioner` `setup` guard ("evaluator-sealed Submission must
  > remain grant-free", formerly cited `:291-293`) and the byte check is in the
  > same provisioner's `harvest` path (formerly cited `:343-345`);
  > `secretForwards: []` is set in `evaluation-harness/src/launcher.ts`'s
  > `launcherCapabilities` helper (formerly cited `:94-95`).
- **Superseded** (the host-orchestration half, all unimplemented): the durable-job premise
  (§1, §3.4), `EvaluationAttemptCheckpointStore` and the recovery ladder (§14.3, §15),
  `attemptId` idempotency (§8.1), `EvaluationReceiptV1` (§19), the
  `network.jinn.evaluation.attempt.*` event vocabulary (§7.2), the cooperative-cancellation
  chain (§15.5), and the execution-provider abstraction (§5.4, §13) — each is the generic job
  this backend performs once (journal/recovery, Attempt URIs, Delivery, TEP observations, the
  cancellation ladder, provisioner+launcher).

Three of its ideas are adopted stack-wide (§3, last row): `interruptionBehavior`, the
seal-once prepared-bytes checkpoint (§9.1), and `recoveryAdvice` (§6.3).

## 11. Consumers

### 11.1 Autopilot (first adopter; TEP §25 made concrete)

Everything that makes Autopilot itself stays above the backend: reality-check triage, the
branch-claim CAS, draft-PR opening, project fields, scheduling caps and allowlists, review
flow, adoption. The middle changes: instead of `createAttemptWorkspace` +
`spawnCoordinatorSession` + an in-memory `trackChild`, Autopilot seals a session-profile Task
(workflow kind, issue snapshot, skill scenario, and the `repository-state` input descriptor —
repo URL plus the immutable claim OID, which is requester-neutral and legitimate Task content
per TEP §25) and submits with deadline, `effort`, and an idempotency key; `effort` and the
harness pin ride the Submission requirements map (§8.1). The repository-workspace provisioner
materializes the detached worktree at the claim OID; the host-configured local
mirror/reference-repo (so worktrees stay cheap) is provisioner configuration, not Task content.

- **Credentials become explicit**: the attempt-scoped GitHub token moves into `secrets/` with
  a launcher-declared forward. The backend never originates or requires GitHub authority;
  local Autopilot grants push authority to its own sessions, marketplace tasks never carry it
  — same Task profile, different Submission-side grants: the open-fleet boundary, kept.
- **The stranded-work class closes structurally**: dispatcher restart → `recover()` → the
  reconciliation table. A dead session is `lost` or `failed` with its worktree retained under
  retention policy and a journal showing which phase it reached; the drift sweep consumes
  attempt records instead of PID-plus-git forensics. `markAttemptExited`-on-dead-PID,
  `isPidAlive` capacity counting, and the three-value `processState` retire; correlation
  annotations carry `claimOid`/`expectedHead`/`prNumber`.
- **Results become typed**: the session emits the **required `patch` artifact** into `out/`
  (the `repository-work/1.0` family and its session sub-profile mandate it — profiles §6.3/§8,
  and a sub-profile may not drop a parent obligation; it is the diff of claim base → terminal
  head), so the Delivery is structurally valid against its own profile. Branch push remains an
  additional application-side channel, not the protocol result. The Delivery also carries the
  summary artifact, terminal head annotation, decoded terminal envelope, and evidence
  references.

### 11.2 The daemon engine (boundary declared; details with the marketplace-binding design)

The `TaskEngine`'s states split on inspection: `DISCOVERED/CLAIMED/WAITING/DELIVERING/
COMPLETE/RACE_LOST` are venue states and stay with the marketplace pipeline;
`PRE_SNAPSHOT/RUNNING/POST_SNAPSHOT` collapse into the backend's provision→execute→harvest;
`PACKAGING` and delivery (envelope assembly, IPFS, chain calls) become the marketplace binding
consuming backend Deliveries. Evaluations change nothing. This spec freezes only the boundary.

## 12. Security considerations

| Concern | Answer |
| --- | --- |
| Secrets at rest / in flight | `secrets/` 0700, never collected or listed, wiped at terminal; launcher-declared reference-forwards only, resolved at exec by the shim and never journaled (§8.1); categorical env stripping (existing blocklist discipline) |
| Secret leak into transcripts | **Not fully defended, stated honestly**: the teed `logs/` and `harness-state/` transcripts are digested and retained (§7.4), so a harness that echoes a forwarded secret leaks it past the `secrets/` wipe. The `secrets/` wipe is not the whole secret-custody guarantee; transcript secret-scrubbing belongs to application/evidence scrubbing (TEP §20's malicious-producer posture) |
| Application authority | The backend forwards grants mechanically; it never originates, persists, or infers credentials (the evidence layer's authority rule, §7 of its architecture, adopted) |
| Workspace escape | Harvest from `out/` only, with `O_NOFOLLOW`/realpath on every entry and rejection of any symlink escaping `out/` (§7.4) — closes `out/creds → ../secrets/token` exfiltration; `input/` immutability checked at harvest; path-traversal guards on declared output paths (existing `OUTPUTS.json` guard kept) |
| Process escape | Linux cgroup binding where available; group-kill with zombie-pinning; subreaper on Linux; macOS/cgroup-less residual named honestly: double-forking escapees are detectable (orphaned group members) but not always killable — the cancel poll is bounded (§6.5) so an escapee yields a terminal-with-residual-PIDs annotation, never a hang |
| Custodian killed | Fate-sharing is best-effort (§6.1); a `kill -9`/OOM of the shim while the harness lives is handled by recovery (§6.4 orphaned row: kill ladder → `lost`), not silently mis-read as success |
| Two writers on one state root | Exclusive `meta/backend.lock` (§5); a second instance fails `backend-unavailable` — no double recovery, no double spawn, no `seq` collision |
| Observation injection | Payloads carry identifiers and bounded text, never task or artifact content (TEP §10.2); the journal is backend-owned; the executor cannot write `meta/` |
| Outcome forgery | `outcome.json` lives in `meta/` outside the executor's write surface; the nonce binds it to the attempt and is checked before ingest (§6.4); a spoofed success envelope cannot override a failing exit code (§8.2); contradictions surface as `contradictory`, never silently merge |
| Disk exhaustion | Per-attempt cumulative quota enforced during execution; `meta/` outcome writes isolated from data-dir pressure (§7.1) so one attempt's fill cannot false-`lost` a sibling; retention TTLs + disk-floor eviction on `work/`; artifact-size ceilings from `capabilities()` |

## 13. State formats and serialization

Sealed documents (Task, Submission, Delivery) follow the stack discipline exactly: I-JSON, JCS
once at sealing, sha256 exact bytes, DSSE where the deployment profile requires signatures.
Backend-internal state (journal, attempt record, shim files) is versioned, torn-tail-tolerant,
and additive-evolution (unknown fields ignored); its schemas are implementation-profile
concerns beneath the frozen contracts of §14. Observations are CloudEvents structured JSON per
TEP §10.

## 14. Frozen interfaces

1. The four-component split and each component's never-touches column (§5), and the exclusive
   state-root lock with `backend-unavailable` on contention.
2. The shim contract: env-tagged from fork, signal-surviving sole outcome recorder,
   fingerprint, atomic outcome file, group leadership, zombie-pinned kill ordering,
   exec-time-only secret resolution (§6.1).
3. Journal semantics: intent-before-action, fsynced-append-before-emission,
   durable-`seq`-from-journal, source-of-truth-with-projection, per-nonce terminal uniqueness
   with the `lost`-correction exception, the submission-scoped segment, the event shape
   (§6.2).
4. The attempt-record field set at §6.3's granularity, including `interruptionBehavior` and
   `recoveryAdvice`.
5. The reconciliation table and its classifications (§6.4) — including the never-executed →
   `rejected` row, the orphaned-under-dead-shim row, the harvesting/recording resume rows, the
   nonce precondition on ingest, and the `lost`-correction exception; no blind respawn.
6. Cancellation semantics: idempotent, non-outcome, subtree-signal ladder sparing the shim,
   bounded poll with terminal-on-ceiling, harvest-after-cancel, keep-state, published grace
   and poll defaults (§6.5).
7. The workspace contract: directory set, env-var indirection, per-directory retention,
   two-phase provisioning, `rejected`-means-never-executed, per-attempt quota with `meta/`
   isolation, the symlink-guarded verified-empty harvest (§7).
8. The TaskView definition (parsed Task ⊎ Submission effective requirements ⊎ resolved
   profile), the LaunchPlan shape with reference-only secret env, its journaling with
   spawn-intent, hermetic-invocation and environment-discipline obligations, run-pinning
   enforcement, two-channel capability declaration (§8.1).
9. Result-interpretation rules: exit code/signal authoritative for fail-vs-not-fail;
   envelope refines within the not-failed class only; limit-exhaustion → `partial` +
   resumable; structured output alongside, never instead (§8.2).
10. The TEP verb semantics of §9.1, including the seal-once Delivery checkpoint.
11. The evidence join points and the `evidenceCapture` posture rules (§10.1–§10.2).
12. Evaluation-as-same-backend and the Evaluation Runner split (§10.3–§10.4).

## 15. Packages

```text
packages/task-execution/backend-local/
  supervisor/    shim, journal, reconciler, cancellation ladder — depends on nothing above
                 shared sealing/typing utilities; no harness, git, or evidence imports
  workspace/     provisioner contract + dir and worktree implementations
  launchers/     launcher contract + claude-code, codex, hermes, cursor
  assembly/      the TaskExecutionBackend implementation wiring the three, plus the
                 evidence join (evidence contracts only; bindings injected by the host)
```

Extraction-ready throughout: `supervisor` is deliberately the most dependency-free component;
no component imports application trees; evidence enters as contracts with concrete bindings
injected by the hosting product (the `evidence-local-runtime` composition).

## 16. Conformance

The kit precedes the implementation and lives as the `backend-local` slice of
`@jinn-network/task-execution-testing` (the stack's existing kit package), with the **fake
launcher** as its backbone: a contract-conforming launcher whose plans script exit codes,
envelopes, output writes, and timing per fixture — `SimpleRunner`'s role, reborn as a contract
fixture.

- **Golden journals**: valid; torn-tail; contradictory terminals; duplicate nonces; dangling
  intents; `seq` resumption after a torn tail; rebuild re-emitting identical (`source`, `id`)
  observation pairs; the submission-scoped segment surviving restart (a rejected Submission
  stays rejected).
- **The reconciliation table as fixtures**: every §6.4 row a scenario with scripted process
  reality — including engaged-no-intent → `rejected`, orphaned-under-dead-shim → kill ladder +
  `lost`, harvesting-resume re-collecting outputs a partial harvest missed, recording-resume
  from the checkpoint, nonce-mismatched outcome ignored, and `lost`-correction without a
  `contradictory` flag.
- **Shim contract**: outcome-file atomicity (kill -9 between temp and rename), fingerprint
  verification against PID reuse, group-kill with zombie-pinning, subreaper adoption,
  signal-survival (shim ignores the cancel TERM and still records a raced-ahead success),
  env-tag present from fork (pre-exec window probe).
- **Launcher contract**: plan determinism (same inputs, byte-identical plan — which the
  reference-only secret env makes possible), hermeticity (a plan varying with ambient env
  fails), statelessness; **result interpretation**: success-envelope + out-of-range exit →
  `failed`; limit-exhaustion → `partial` + `resume-with-session`; within-range exit with no
  envelope → `fulfilled`; structured output alongside the envelope.
- **Workspace**: per-directory retention, secrets and tmp wiped at terminal, `input/`
  immutability violation detection, `rejected` never-executed guarantee, **symlink-in-`out/`
  escaping the tree → rejected + integrity violation**, per-attempt quota breach, spawn-time
  env discipline (no secret-shaped ambient keys, no setup-phase credentials in the harness
  env), and a journal/attempt-record grep proving no `secrets/` byte-content ever lands in
  `meta/`.
- **Backend-level**: the TEP conformance kit run against this binding — the reference
  implementation is the TEP kit's first real consumer; two-instances-one-root → second fails
  `backend-unavailable`; `attempts` outside `1..1` → `unsupported-requirement`.
- **Cancellation races**: cancel-vs-finish (recorded outcome stands), cancel-on-terminal
  idempotency, harvest-after-cancel and harvest-after-expiry, un-killable group member →
  bounded poll → terminal with residual-PIDs annotation, cancel during provisioning →
  `rejected`.
- **Evidence join**: capture `always` failure → `failed[infrastructure]`; receipt fields
  present in the Delivery; the dispatch-context artifact present in the recorder's captured
  inputs; seal-once checkpoint reuse across a scripted crash, including the torn-checkpoint
  re-read variant.

## 17. Declared impact

Impact only; migration mechanics are separate specs.

- **Autopilot**: `attempt-workspace`/`coordinator-session`/cleanup-classification machinery
  superseded by backend consumption; the session CLI stays (application authority); the V1
  dispatcher's spawn path migrates or retires with it.
- **Client**: harness adapters become launchers; the legacy `runner/` retires; `SimpleRunner`'s
  role moves into the conformance kit's fake launcher; the `TaskEngine` carve per §11.2 lands
  with the marketplace-binding design; engine path config generalizes to a backend state root.
- **The 2026-07-23 `SessionExecutionBackend` interface** is subsumed (TEP §25); its
  application-side content stands.
- **The Evaluation Runner design** on `integration/evidence-v1` is superseded in its
  host-orchestration half per §10.4; its implementation plan should build the evaluator-adapter
  core as an evaluation harness under this backend instead. A follow-up PR on that branch
  amends the design's status header and the application-layer index accordingly.
- No marketplace contract changes; no protocol changes.

## 18. Sequence

1. `supervisor` + conformance kit;
2. `workspace` + `launchers` (claude-code first);
3. `assembly` + TEP kit green;
4. Autopilot adoption;
5. daemon execute-step adoption (with the marketplace-binding design).

## 19. Explicit non-goals

Scheduling, queues, retry policy, acceptance, budgets (applications); settlement and venue
mechanics (marketplace binding); container/VM isolation classes (follow-up — the contract's
`isolation[]` capability leaves room); remote execution; evaluation methods and specs (the
profiles design); evidence record semantics (the Evidence Protocol); discovery; a hosted
service; Windows support.

## 20. Non-blocking follow-ups

- Container/VM isolation launcher classes (the `isolation[]` capability made real).
- The `integration/evidence-v1` amendments: Evaluation Runner spec status header, its
  implementation plan supersession note, and the application-layer index entry.
- Resume-as-retry profile conventions (how a new Submission references a prior session
  artifact portably).
- Heartbeat-driven hang policy beyond observation (application-configurable kill-on-stale).
- Windows process custody (job objects as the group/subreaper analog).
- A compiled shim variant if the Node shim's signal fidelity proves limiting.
- A TEP follow-up on the error taxonomy: whether an up-but-full backend deserves a dedicated
  `capacity-exhausted` category rather than riding `backend-unavailable` with detail (§5).
- Transcript secret-scrubbing (known forwarded values redacted from `logs/`/`harness-state/`
  before digest) — currently application/evidence-side, per §12's honest statement.

## Appendix: sources

Production systems and standards: containerd runtime-v2/shim docs and issue #6771; runc
libcontainer state model; Kubernetes CRI design proposal, kubelet/PLEG, Job API and
podFailurePolicy; Nomad task-driver plugin contract, task-runner internals, filesystem/alloc
docs, restart/reschedule; Temporal activity timeout/heartbeat/task-token docs; systemd service
supervision and MAINPID validation; GitLab Runner executor interfaces and custom executor
docs; GitHub Actions runner architecture, container-hooks ADR, cancellation reference and
issues #2128/#2607; Bazel remote-apis `remote_execution.proto`; BuildKit `executor.go`; GA4GH
TES v1.1; AWS Batch job states/retries and ECS stopped-task codes; Slurm job state codes; GCP
Batch/Cloud Run Jobs; OpenHands runtime docs; SWE-ReX; E2B and Modal sandbox docs; Claude Code
headless/Agent SDK/teardown docs; Codex CLI/cloud docs; Agent Client Protocol; Cursor cloud
agents API; Devin API; ALICE (OSDI '14) and fsync-failure (ATC '20) crash-consistency papers;
jmmv.dev on macOS process groups; execa/pm2 issue trackers.

Internal: the companion designs in the header; `integration/evidence-v1` head `f65880c4e`
(evidence substrate, `2026-07-25-jinn-local-evidence-runtime-design.md`,
`2026-07-24-jinn-execution-recorder-design.md`, `2026-07-26-evaluation-runner-design.md`,
`2026-07-25-evidence-layer-architecture.md`, `2026-07-27-evidence-application-layer-index.md`);
`packages/autopilot/src/{dispatcher,lifecycle}/` (coordinator-session, attempt-workspace,
implementation-executor, active-runtime, controller); `client/src/harnesses/` (engine,
persistence, state, packaging, delivery, registry, learner adapters), `client/src/runner/`,
`client/src/adapters/{adapter,local,mech}`, `client/src/daemon/` (daemon, delivery-watcher,
watchdog-loop, freeze-fence).

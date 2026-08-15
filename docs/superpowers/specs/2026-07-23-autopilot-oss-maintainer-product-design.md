# Autopilot for OSS Maintainers

- **Date:** 2026-07-23
- **Status:** product design approved; written review pending
- **Shape:** `design`
- **Scope:** package the existing Autopilot lifecycle as a self-hosted,
  single-repository product for open-source maintainers

## 1. Summary

Autopilot already polls GitHub, claims eligible issues, creates isolated
attempts and early draft PRs, coordinates implementation and independent
review, routes blocking findings through child issues, observes native merge
gates, and recovers from GitHub-visible state.

This design turns that internal repository tool into an installable product
without redesigning its lifecycle.

The product promise is:

> Autopilot learns how your repository works.

Autopilot supplies the structured work loop. The Jinn Plugin runs inside the
worker environment and supplies the learning relationship: it retrieves
relevant experience and retains the resulting episodes through its own
contracts. Autopilot configures that composition but does not take ownership
of Jinn's retrieval, storage, privacy, contribution, or publication policy.

V0 is a thin, self-hosted product shell around the current engine:

```text
autopilot init
autopilot doctor
autopilot start
```

The standalone product's canonical destination is a dedicated
`Jinn-Network/autopilot` repository. The first boundary-hardening work lands
in `jinn-mono`; extraction happens only after Autopilot is self-contained and
passes a non-Jinn repository fixture. After cutover, `jinn-mono` becomes an
ordinary consumer rather than a second source tree.

The maintainer continues to use GitHub and their normal coding agent. A
repository-local maintainer skill pack makes issue filing, triage, and
lifecycle explanation Autopilot-aware. The engine and its authority-bearing
workflow skills remain inside the installed Autopilot distribution.

## 2. Existing foundation

The current implementation is already the V0 product core:

- GitHub is polled on a continuous cadence.
- Human-created, triage-complete issues become eligible work.
- Git branches, PRs, reviews, checks, and structured markers are the
  authoritative lifecycle facts.
- Branch-native compare-and-swap claims prevent duplicate implementation.
- Each attempt receives an isolated worktree, manifest, credential boundary,
  and early draft PR.
- Implementation, independent review, review-finding children,
  reconciliation children, CI-failure children, and merge recovery use one
  lifecycle.
- Project Status is a derived view. The Project remains an inbound
  human-intent surface for `Blocked on`, `Effort`, and `Priority`.
- `observe`, `recover`, `status`, and issue/PR explanation already exist as
  operator mechanics.
- Autopilot supports a Hermes worker runtime in which the Jinn Plugin can run.

The missing product layer is packaging and generalization:

- `@jinn-network/autopilot` is private and versioned `0.0.0`.
- installation currently assumes a checkout of this monorepo;
- repository, organization, default-branch, Project, remote, and workflow
  conventions are hard-coded in several engine and skill surfaces;
- credentials, the live Git capability probe, and the supervisor are
  configured manually;
- workflow skills and canonical instructions are loaded from this repository;
  and
- no external-maintainer `init`, `doctor`, start/stop, upgrade, or managed
  skill-installation experience exists.

Productization removes those assumptions while preserving the lifecycle that
already works.

## 3. Product decision

### 3.1 Primary user

The initial user is an open-source maintainer with:

- one existing public GitHub repository;
- a GitHub Project they are willing to configure for Autopilot, or permission
  to create one;
- a self-hosted machine on which Autopilot can run continuously;
- GitHub credentials for implementation and, preferably, an independent
  review identity; and
- an already authenticated agent runtime.

The maintainer's interactive coding agent is independent of the Autopilot
worker runtime. They may use Cursor, Codex, Claude, or another supported
skill-capable host for ordinary repository work and issue authoring.

### 3.2 Initial runtime

V0 uses Hermes with the Jinn Plugin for Autopilot worker sessions. This is the
currently complete composition behind the product promise. Additional worker
runtimes can be added only when they provide an equivalent Jinn Plugin
integration. The V0 configuration schema accepts `hermes` as its only worker
runtime value; multi-runtime breadth is not a V0 acceptance requirement.

### 3.3 Primary outcome

The scarce resource is maintainer attention. The primary longitudinal product
metric is:

> Maintainer corrections per accepted PR decline as the repository
> accumulates completed work.

Issue completion rate, latency, and cost remain supporting measures. V0 may
show honest trends from GitHub evidence, but it does not claim that Jinn
caused an improvement until attribution exists.

### 3.4 Product hierarchy

The product develops in three layers:

1. **Headline:** Autopilot learns how your repository works.
2. **Mechanism:** the repository accumulates durable operational experience
   through the Jinn Plugin.
3. **Network advantage:** useful public experience can increasingly
   complement repository-local experience.

The second and third layers explain the compounding advantage. They do not
replace the first-layer maintainer promise.

## 4. V0 scope

V0 is:

- self-hosted;
- one repository per Autopilot process;
- CLI-installed and CLI-operated;
- GitHub-native;
- Project-backed for human triage;
- Hermes-based for worker execution;
- composed with the Jinn Plugin;
- background-first; and
- conservative about merge authority.

V0 does not:

- add interactive `/implement #N` execution;
- redesign issue discovery, eligibility, claiming, review, child work,
  integration, merge, or recovery;
- replace GitHub Projects;
- introduce a private task database or hosted control plane;
- operate multiple repositories from one process;
- manage Jinn corpus, privacy, contribution, retrieval, or publication
  policy;
- silently rewrite maintainer-edited skills; or
- require a special benchmark or Jinn task format for normal OSS work.

## 5. User journey

### 5.1 Install and initialize

From an existing repository, the maintainer installs the public package and
runs:

```text
autopilot init
```

Initialization:

1. discovers the repository owner, name, remote, and default branch;
2. discovers or creates the selected GitHub Project;
3. validates or provisions Autopilot's opinionated Issue Types and Project
   fields;
4. configures implementation and optional independent-review identities;
5. configures the Hermes worker runtime with the Jinn Plugin;
6. installs the maintainer skill pack into the selected coding-agent host;
7. writes versioned, repository-local, non-secret configuration; and
8. prepares machine-local state without activating the poller.

Initialization is idempotent and non-destructive. It shows proposed GitHub
changes before applying them and refuses to rewrite contradictory existing
fields automatically.

### 5.2 Verify

The maintainer runs:

```text
autopilot doctor
```

The doctor verifies the complete path:

- package and configuration compatibility;
- repository and default-branch resolution;
- GitHub authentication and repository permissions;
- implementation and review identity separation;
- Project identity, field types, and required options;
- branch/ref publication capabilities;
- runtime availability and authentication;
- Jinn Plugin availability in the worker environment;
- state, log, and worktree directory safety; and
- sufficient local disk capacity.

Every failure is classified as blocking or degraded and includes one concrete
remedy where possible. The current live Git capability probe becomes a doctor
check rather than a manual runbook ceremony.

### 5.3 Operate

The primary commands are:

| Command | Responsibility |
| --- | --- |
| `autopilot start` | Run the repository's continuous background lifecycle after preflight |
| `autopilot stop` | Stop new polling without destroying shared or recoverable work |
| `autopilot status` | Show health, capacity, active work, holds, and recent failures |
| `autopilot explain issue <N>` | Explain an issue's derived state and blockers |
| `autopilot explain pr <N>` | Explain a PR's derived state and blockers |
| `autopilot logs [attempt]` | Follow engine or attempt logs |
| `autopilot observe` | Expose the current read-only lifecycle mode |
| `autopilot recover` | Expose the current reconciliation-only lifecycle mode |
| `autopilot skills update` | Propose a managed maintainer-pack update as a repository diff |
| `autopilot upgrade` | Upgrade the engine with compatibility and rollback checks |

`start` owns repository-scoped process, log, state, and worktree locations.
Stopping or upgrading never deletes branches, PRs, manifests, logs, or
recoverable attempts.

### 5.4 Work normally

The maintainer talks to their normal coding agent and uses the maintainer
skills to file or triage work. Autopilot continues to discover work by polling
GitHub; no additional "send to Autopilot" action or dispatch label is added.

The initial acceptance journey is:

> Existing OSS repository → initialize Autopilot → pass doctor → file and
> triage an issue through the maintainer skill → Autopilot discovers and
> claims it → a safe draft PR progresses through implementation and
> independent review → an approved merge-ready PR is returned to the
> maintainer.

A maintainer whose GitHub and model credentials already exist should reach
the first claimed issue within 15 minutes.

## 6. Architecture and ownership

```text
maintainer's coding agent
        │
        │ repository-local maintainer skills
        v
GitHub issues + Project triage
        │
        │ shared source of truth
        v
GitHub refs + PRs + reviews + checks
        ^
        │ poll / claim / publish / recover
        │
self-hosted Autopilot engine
        │
        │ engine workflow pack
        v
Hermes worker + Jinn Plugin
```

### 6.1 GitHub

GitHub remains the only shared lifecycle state:

- issues, Issue Types, labels, and body markers;
- inbound Project triage fields;
- claim branches and review refs;
- draft and ready PRs;
- native reviews and checks;
- branch protection and CODEOWNERS; and
- human holds and structured comments.

The CLI does not introduce a second task catalogue, queue database, or
authoritative status store.

The opinionated V0 Project profile is the current Autopilot profile:

- human-created work carries one of the supported work-shape Issue Types;
- `Blocked on` accepts `Nothing`, `Human`, or `Another issue`;
- `Effort` accepts `Low`, `Medium`, `High`, `XHigh`, or `Max`;
- `Priority` accepts `P0` through `P4`; and
- `Status` is paint-only and presents `Todo`, `In Progress`, `In Review`, and
  `Done`.

Initialization discovers the concrete field and option identifiers at run
time. Configuration stores the resolved mapping, not Jinn's current node IDs.

### 6.2 Repository-local configuration

Initialization writes `.autopilot/config.json`. It is schema-versioned and
safe to commit. It contains:

- repository identity;
- default branch;
- Project owner, number, and field mappings;
- runtime selection;
- concurrency and polling configuration;
- maintainer skill host and pack version;
- merge policy; and
- other non-secret policy controls already supported by the engine.

Current Jinn-specific constants become explicit configuration or
repository-derived values. The configuration schema rejects unknown or
contradictory values rather than silently falling back to the Jinn
repository.

### 6.3 Machine-local state

Machine-local, owner-only state contains:

- GitHub implementation and review credentials;
- runtime and model authentication references;
- capability attestations;
- process identity;
- attempt worktrees and manifests;
- logs and incremental read caches; and
- Jinn Plugin state.

Secrets never enter repository configuration, generated prompts, status
output, or logs.

### 6.4 Maintainer skill pack

The maintainer pack is installed into the selected coding agent's
repository-local skill directory and may be committed with the repository.
V0 contains:

- `file-issue` — turn a maintainer's observation into a concise,
  triage-complete issue with binary acceptance criteria;
- `triage-for-autopilot` — inspect existing issues and make selected work
  Autopilot-ready without changing the engine's eligibility rules; and
- `explain-autopilot` — explain issue, PR, and service state through the CLI's
  read-only surfaces.

The installed pack records its source version. Updating produces an
inspectable repository diff and refuses to overwrite local modifications
without an explicit maintainer decision.

### 6.5 Engine workflow pack

The authority-bearing workflow pack ships inside the Autopilot distribution:

- `implement-issue`;
- `review-pr`;
- `fix-child`;
- `reconcile`; and
- `autopilot-runtime`.

These skills are implementation methods, not user entry points. They continue
to fail closed without an Autopilot-issued attempt manifest and validated
authority. They are upgraded with the engine so their session verbs and
lifecycle contract cannot drift independently.

### 6.6 Jinn Plugin boundary

Autopilot ensures that the configured worker environment contains and can load
the Jinn Plugin. Inside the worker, the plugin owns:

- retrieval from local and public knowledge;
- evidence capture and retention;
- corpus and contribution policy;
- privacy and publication behavior; and
- plugin-specific degradation and diagnostics.

Autopilot does not inspect or mutate those internals. Plugin retrieval failure
degrades according to the plugin's own fail-open contract and must not stop
ordinary agent work.

### 6.7 Repository ownership and extraction

The canonical product repository is `Jinn-Network/autopilot`. It owns:

- the engine and public CLI;
- generic maintainer and engine workflow packs;
- the lifecycle contract and operator documentation;
- package publication and release notes;
- external product issues and contribution guidance; and
- repository-independent fixtures and canaries.

`jinn-mono` retains:

- `.autopilot/config.json` as a product consumer;
- installed generic maintainer skills;
- Jinn-specific policy extensions, including any additional human-surface or
  release rules; and
- Jinn Plugin implementation and integration ownership outside Autopilot.

Extraction is staged because the current package still reads Jinn-specific
root canon, skills, paths, remotes, and Project constants. The extraction gate
is:

> Autopilot can initialize, observe, and run its test lifecycle against a
> non-Jinn repository fixture without reading a file outside its package or
> falling back to a Jinn-specific constant.

The extraction preserves relevant file history. Cutover establishes one
canonical source: the old `packages/autopilot` implementation is removed from
`jinn-mono`, and Jinn's dogfood installation consumes the released standalone
package. A temporary split mirror may validate packaging before cutover, but
it is never an independently editable source.

## 7. Preserved lifecycle

The V0 data flow is:

1. The maintainer uses `file-issue` or `triage-for-autopilot`.
2. The skill creates or updates an issue with a supported Issue Type, binary
   acceptance criteria, dependency facts, and the required triage fields.
3. The engine polls GitHub. An open, triage-complete, unblocked issue with no
   existing claim or PR becomes eligible under the current rules.
4. Autopilot wins the existing branch-based claim and creates the early draft
   PR, isolated worktree, selected credential boundary, and attempt manifest.
5. Hermes starts with the engine workflow pack and the Jinn Plugin.
6. The implementation workflow checkpoints durable branch progress and
   delivers the PR.
7. An independent reviewer approves the exact head or creates blocking child
   work.
8. Review-finding, reconciliation, and CI-failure children re-enter the same
   lifecycle and publish append-only progress to the parent branch.
9. CI, branch protection, CODEOWNERS, human holds, and native reviews remain
   authoritative.
10. The Project Status painter derives the human-visible view from Git and PR
    facts.
11. A later worker may benefit from the experience retained by the Jinn
    Plugin.

No V0 product component can bypass the claim gateway, issue an unmanifested
implementation session, or create a parallel implementation protocol.

## 8. Merge policy

External maintainers should not grant merge authority merely by installing
Autopilot. V0 adds one repository-level policy:

```json
{
  "mergePolicy": "manual"
}
```

Supported values are:

| Policy | Behavior |
| --- | --- |
| `manual` | Default. Autopilot implements, reviews, repairs, observes CI, and stops at an approved merge-ready PR. It never invokes a merge. |
| `safe-auto` | Explicit opt-in. Preserve the current exact-head, claimless merge behavior and every independent-review, CI, mergeability, CODEOWNERS, and human-hold gate. |

Under `manual`, `MERGE-READY` is a stable terminal service state until the
maintainer merges, closes, or changes the PR. `status` and
`autopilot explain pr` identify it as ready for maintainer action.

V0 does not add per-issue merge overrides. Repository-wide policy is the one
authority surface.

## 9. Failure handling and operational safety

### 9.1 Startup

`start` refuses active mode when the doctor finds a blocking failure,
including:

- missing claim permissions;
- an invalid or contradictory repository mapping;
- malformed Project fields;
- conflicting implementation and review identities;
- a failed branch/ref capability gate;
- an unusable worker runtime; or
- unsafe local state paths.

Degraded Jinn retrieval or public-corpus availability is reported but does not
block agent execution.

### 9.2 Runtime

- A failed GitHub snapshot causes a mutation-free cycle.
- Rate-limit pressure causes bounded backoff rather than partial decisions.
- A worker failure preserves the claim branch, draft PR, manifest,
  checkpoints, and logs.
- Recovery derives shared state from GitHub, never from a PID or the presence
  of a local directory.
- Session commands continue to reject stale or contradictory authority.
- Manual-merge mode never schedules a merge action.

### 9.3 Stop and upgrade

`stop` prevents new cycles and gives active workers an opportunity to reach a
durable checkpoint. A forced stop still preserves shared and recoverable
state.

`upgrade`:

1. stops new claims;
2. checks configuration and state-schema compatibility;
3. retains the previous runnable engine;
4. updates the engine and managed skill-pack source;
5. reruns doctor; and
6. resumes only after verification succeeds.

A failed upgrade restores the previous runnable version. It does not mutate
GitHub lifecycle state as rollback.

### 9.4 Cleanup

Cleanup remains host-local, PID-aware, and exact-path-scoped. Live,
unpublished, escaped, or ambiguous work is retained. Stopping, uninstalling,
or changing merge policy is never a cleanup event.

## 10. Verification

Existing lifecycle tests remain the foundation. Productization adds four
layers.

### 10.1 Package verification

Install the published CLI in a clean environment and verify:

- public package and binary integrity;
- initialization idempotence;
- config-schema validation and migration;
- credential isolation;
- managed skill installation and update conflict behavior;
- start/stop behavior; and
- failed-upgrade rollback.

### 10.2 Repository fixture

Initialize a repository outside `Jinn-Network` and verify:

- repository, organization, branch, Project, remote, and field identifiers
  come from discovery or configuration;
- no Jinn repository defaults survive as silent fallbacks;
- doctor catches every broken precondition; and
- the maintainer pack creates triage-complete work against the configured
  repository.

### 10.3 Live disposable-repository journey

Against a disposable GitHub repository and Project:

1. file and triage an issue;
2. observe exactly one implementation claim and one early draft PR;
3. complete implementation and independent review;
4. exercise at least one blocking child-work round;
5. force a process restart after a durable checkpoint;
6. prove recovery without duplicate work; and
7. reach merge-ready.

Merge-policy canaries prove:

- `manual` leaves the approved, green PR unmerged indefinitely; and
- `safe-auto` merges only an exact, independently approved, green, clean, and
  policy-eligible head.

### 10.4 Composite worker journey

Run one real Autopilot attempt with Hermes and verify that:

- the worker loads the Jinn Plugin;
- plugin failure does not crash the Autopilot lifecycle;
- a successful worker session records an episode through the plugin; and
- Autopilot does not read or rewrite plugin-owned corpus state.

This is a composition test, not a duplication of the plugin's own test suite.

## 11. Graduation and measurement

The V0 release gate is:

> An external maintainer with an existing public repository, GitHub access,
> and model credentials can install Autopilot, initialize it, verify it, file
> a ready issue through their coding agent, and receive a reviewed merge-ready
> PR without editing Autopilot source or Jinn-specific configuration.

Product and safety metrics are:

- installation-to-first-claim time;
- eligible-issue-to-delivered-PR rate;
- duplicate or contradictory claims: **zero**;
- unsafe or unauthorized merges: **zero**;
- review rounds and blocking findings per accepted PR;
- human escalations per accepted PR;
- worker/runtime failure and recovery rate; and
- maintainer corrections per accepted PR over repository age.

The longitudinal comparison uses earlier and later work within each
repository. It does not claim causal learning until an attribution design can
separate Jinn intervention from task mix, model changes, maintainer behavior,
and ordinary repository evolution.

## 12. Approaches considered

### 12.1 Selected: installable CLI

Publish an installable CLI that discovers, configures, verifies, operates, and
upgrades the existing engine.

This is the smallest approach that creates a real maintainer product while
preserving one lifecycle implementation and one update channel.

### 12.2 Rejected for V0: repository starter kit

Copy an `.autopilot` directory, skills, and supervisor scripts into each
repository.

This is quick to assemble but makes every installation a fork. Engine
upgrades, security fixes, config migration, and skill synchronization become
repository maintenance work.

### 12.3 Rejected for V0: container appliance

Ship the complete system as a container with mounted repository state.

This improves environmental reproducibility but makes coding-agent CLI
authentication, local worktrees, GitHub credentials, and the Jinn Plugin
integration harder. It may become an optional deployment form after the CLI
contract stabilizes.

### 12.4 Deferred: interactive execution

An interactive maintainer agent could eventually request an Autopilot claim
and execute the resulting manifest-bound attempt in the current session.

The safe form requires the background scheduler and interactive client to use
one claim gateway. A skills-only implementation that creates its own branch
and PR would introduce a second lifecycle authority and is rejected.
Interactive execution is not required to productize the existing
background-first loop.

## 13. Delivery boundaries

This product design is implemented as a sequence of independently releasable
slices, not one coupled rewrite:

1. **Configuration boundary:** replace Jinn-specific repository, branch,
   Project, remote, path, and policy constants with validated configuration
   while preserving the current internal entry point.
2. **Self-contained engine:** co-locate the engine workflow pack, lifecycle
   contract, templates, and tests with the package; pass the non-Jinn fixture
   and extraction gate.
3. **Standalone cutover:** preserve the relevant history in
   `Jinn-Network/autopilot`, establish standalone publication, remove the
   duplicate source from `jinn-mono`, and make Jinn's installation consume the
   released package.
4. **Initialization and doctor:** add idempotent discovery/provisioning,
   machine-local credential references, and the end-to-end preflight.
5. **Maintainer pack:** generalize, package, install, and safely update the
   three repository-local maintainer skills.
6. **Service shell:** add start, stop, status, logs, upgrade, and
   repository-scoped local process/state management.
7. **External canary:** graduate through the disposable-repository and
   composite Hermes-plus-Jinn journeys.

Each slice keeps the existing lifecycle test suite green and can be reviewed
without requiring a later slice to make it safe. The implementation plan may
stack PRs, but no PR may carry two lifecycle authorities or temporarily fall
back to Jinn-specific defaults for external repositories.

## 14. Design invariants

1. **Productize; do not redesign.** V0 wraps the existing lifecycle.
2. **GitHub remains authoritative.** Local state is cache, evidence, and
   recoverable execution state, never shared lifecycle truth.
3. **One claim gateway.** Every implementation attempt begins with the same
   branch-native authority protocol.
4. **Skills have distinct audiences.** Maintainer skills express intent;
   engine skills execute manifest-bound methods.
5. **Manual merge by default.** Installation does not imply merge authority.
6. **Jinn remains a plugin boundary.** Autopilot composes with it without
   absorbing its knowledge policy.
7. **Secrets stay machine-local.** Repository configuration is safe to commit.
8. **Stop and upgrade preserve work.** Process control is not lifecycle
   rollback or cleanup.
9. **Improvement claims remain legible.** Trends are reported honestly;
   attribution is not implied.
10. **One canonical repository after cutover.** `Jinn-Network/autopilot` owns
    the product; `jinn-mono` dogfoods a release and carries only
    repository-specific configuration and extensions.

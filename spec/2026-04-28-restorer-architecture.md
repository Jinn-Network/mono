# Restorer Architecture: Substrate-First vs Specialists-First — ADR

> Version: 1.1
> Date: 2026-04-28 (rev 2026-04-28: vocabulary retarget — "plug-in" → "external impl"; renamed file ref)
> Author: Captain (opus, dispatched on jinn-mono-bea)
> Status: Proposed (not yet adopted)
> Supersedes: v1 (vocabulary-only retarget; conclusion unchanged)
> Audit: surfaced 2026-04-27 from PR #38 review session
> Sibling specs:
> `spec/2026-05-external-restorer-impls.md`,
> `spec/2026-05-executor-trust-boundary.md`,
> `spec/2026-05-schema-versioning.md`,
> `spec/2026-05-registry-discovery.md`,
> `spec/2026-04-21-agentic-data-substrate.md`,
> `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md`

## Vocabulary note (2026-04-28)

v1.1 retargets "plug-in" → "external impl" throughout (matching the
other extension-model specs on this branch and the codebase's
established `RestorerImpl` / `impl` vocabulary; avoiding collision
with the unrelated existing `jinn plugin install` verb that installs
the Jinn MCP server / skill into AI hosts). The two literal references
to `client/plugins/default-learner/` and "the Claude plugin" in §7
step 5 are NOT renamed — those name a real Claude Code plugin, a
distinct surface from the operator-supplied `RestorerImpl` flow this
ADR composes with.

## 1. Purpose and scope

PR #38 (default-learner) introduced a wrapper-around-specialists model:
a `DefaultLearningWrapper` first-match-claims every `(kind, type)` pair
and delegates the inner Execute step to the specialist via a two-pass
protocol (`IntentSessionInputs.adapterEnv`). That shape was an
implementation choice in Plan 3 of the PR, not a deliberate
protocol-level architectural decision. This ADR makes the call.

The Captain has already separately decided that default-learner does
not become the registry default (it ships opt-in, drops the "default"
framing). This ADR answers the deeper question PR #38 surfaced:

> Is the executor a learning **substrate** that wraps specialists, a
> set of **specialists** with learning as an optional service, or a
> hybrid where operators pick per kind?

The four extension-model specs (`spec/2026-05-*.md`) and the audit
output (`jinn-mono-j75`) all assume a per-impl identity. PR #38's
wrapper assumes a substrate identity in front of those impls. Those
two assumptions are not compatible without one of them yielding. This
ADR picks specialists-first and routes learning as a per-impl service.

### 1.1 In scope

- The high-level architecture choice between substrate-first,
  specialists-first, and hybrid.
- The constraints the choice imposes on the engine's impl-resolution
  rule, the trust boundary, the external-impl loader, and
  kind-versioning.
- The disposition of PR #38's wrapper code given the choice.
- The composition story for operator-supplied restorers
  (`jinn-mono-7zz`) under the chosen model.
- The opt-in compositional layer above the specialists-first
  architecture (Phase A.2 plug-in surface) is defined in
  `spec/2026-04-30-plug-in-surface.md` and does not change this ADR's
  decision; the `claude-code-learner` impl simply gains a publicly
  pluggable internal pipeline while remaining one impl among many at
  the registry level.

### 1.2 Out of scope

- The internal mechanics of any specific learner (Pi phases,
  promotion gate, constitutional snapshots) — these live in the
  default-learner design spec and are unaffected by this ADR provided
  they are confined to one `RestorerImpl`.
- The corpus / dataset productisation mechanics. The agentic-data
  substrate spec is informative input; this ADR does not commit to
  any of its tiered protocol changes.
- Kind-major cuts, naming churn (`jinn-mono-juw` / GH#43), and CLI
  verb shapes. Those land on their own beads.

### 1.3 Non-goals

- This is not a replacement for the default-learner design spec. It
  scopes where the learner sits; it does not redesign its internals.
- This is not a Phase 2 spec. The decision below holds the seams the
  trust-boundary spec already opened (out-of-process impls), but
  does not pre-commit Phase 2 mechanics.

## 2. The fork (recap)

Three options were on the table. The framing below restates them in
the language of the existing extension-model specs so the rejection
or acceptance lines up with the contracts those specs already define.

### 2.1 Option 1 — substrate-first

A learning loop is the universal envelope around restoration.
Specialists become Execute-step impls inside the loop
(Orient → Strategize → Plan → Execute → Debrief → Improve → Memory).
The learning loop holds protocol-visible identity; specialists are
selected by the substrate and invoked via an internal handoff.

This is PR #38's current shape, just opt-in instead of default. The
wrapper's `supports()` first-match-wins; once the wrapper claims a
`(kind, type)`, its inner specialist runs through the wrapper's
`adapterEnv` two-pass protocol.

### 2.2 Option 2 — specialists-first

Restorer impls remain the protocol-visible unit. Each kind has its own
specialist(s) implementing the existing `RestorerImpl` interface
(`client/src/restorer/types.ts`). Learning is a per-impl service
layer: an impl can use a learner library or call out to a learning
service, but it owns its own `run(ctx)` semantics and identity.

A learner-style impl is one impl among many in `buildRestorerImpls`
(or an operator-supplied external impl via `restorers.externalImpls`);
it does **not** sit between the engine and other specialists.

### 2.3 Option 3 — hybrid

Both shapes coexist. A wrapper substrate is one engine path;
direct-to-specialist is another. An operator picks per kind via
config which path applies.

## 3. Decision

**Option 2 — specialists-first.**

The protocol's unit of identity, trust, and discovery is the
`RestorerImpl`. Learning is a per-impl service layer that an impl
opts into; it does not become a wrapper that sits between the engine
and other impls. PR #38's `DefaultLearningWrapper` is repositioned
into a kind-specific learner impl (or scope-narrowed to the kinds
the bundled Pi harness was actually validated against), not retained
as a first-match envelope across every kind.

The status quo registration shape in
`client/src/restorer/impls/index.ts` continues — a flat list of
impls, each declaring `supports({ kind, type })`. The external-impl
loader extends this list at boot from `restorers.externalImpls` per
`spec/2026-05-external-restorer-impls.md`. There is no second engine
path.

## 4. Rationale

The decision is forced by four contracts the four sibling specs
already define. Option 1 violates all four; Option 3's flexibility
collapses to either Option 1 or Option 2 once those contracts apply.

### 4.1 Trust boundary is per-impl

`spec/2026-05-executor-trust-boundary.md` §3 / §4 / §5 binds:

- A capability allow-list (chains, signer selectors, RPC methods,
  rate limits) to one manifest, signed by one signer key.
- An `implStateDir` and a per-impl `secrets/` bag to one impl name.
- Revocation (§5.6) to one signer or one manifest CID, with cascade
  to every impl signed by a revoked key.

A substrate that interposes between the engine and a specialist
either (a) presents its own identity to the boundary — collapsing
many specialists' allow-lists into one wider allow-list, which is the
exact pattern §3.5 forbids; (b) inherits the specialist's identity
dynamically — which is not a model the boundary spec defines and
would require redesigning §5.4's install-time review (the operator
reviews one manifest, not "wrapper composed with specialist X");
or (c) carries no identity and only operates inside the specialist's
scope — at which point the substrate is a library, not a wrapper,
which is Option 2.

PR #38 implements (a) implicitly: the `DefaultLearningWrapper` runs
under the daemon's PID with whatever credentials the engine's
existing call site grants, and its `IntentSessionInputs.adapterEnv`
hand-off is internal — invisible to the §3 capability scoping. The
codex review (`jinn-mono-8dr`) flagged this in must-fix #5: the
wrapper does not delegate gates to specialists, and its `supports()`
is asymmetric across restoration / evaluation. Both symptoms are the
trust-boundary mismatch surfacing.

### 4.2 External-impl loader is per-impl

`spec/2026-05-external-restorer-impls.md` §3.4 lifecycle:

> 6. **Validate identity.** The returned `RestorerImpl.name` MUST
>    equal `manifest.name`; `RestorerImpl.version` MUST equal
>    `manifest.version`. Mismatch → exclude with
>    `reason: "impl-identity-mismatch"`.
> 7. **Validate `supportedKinds`.** Every kind the impl claims via
>    `supports()` for the kinds in `manifest.supportedKinds` MUST
>    match.

A wrapper that announces `supports()` for a different superset than
its manifest declares fails identity validation. A wrapper that
declares `supportedKinds: ["*"]` (every kind) is not expressible
under §2 of the schema-versioning spec, which requires explicit
`<kind>>=<semver>` entries. A wrapper that wraps another impl whose
manifest exists separately is two manifests for one runtime path —
the loader has no model for that.

The external-impl loader is the integration point an operator-
supplied restorer goes through (`jinn-mono-7zz`). Forcing every
external impl through a substrate wrapper at the engine level either:

- Pre-installs the substrate as a first-party impl outside the
  external-impl flow (privileges first-party over third-party —
  exactly what `jinn-mono-7zz`'s "first-class" goal disallows), or
- Requires every external impl to declare itself substrate-compatible
  (couples third-party authors to one substrate's vocabulary).

Both outcomes are worse than treating the substrate as one more
opt-in impl.

### 4.3 Kind-versioning is per-kind

`spec/2026-05-schema-versioning.md` §2 / §4 routes consumers
(subgraphs, evaluators, third-party readers) on `kind`, not on
substrate. A substrate that wraps every kind has no single
`schemaVersion` it can advertise; it has to announce its inner
specialist's kind, which makes it indistinguishable from the
specialist itself.

The schema-versioning spec also forbids best-effort cross-kind
parsing (§5.1, §5.2). A learning loop that promises to "improve
across kinds" inside one envelope either fragments its trajectory
data per kind anyway (so the cross-kind promise is illusory) or
emits substrate-shaped envelopes that no consumer routes on (so the
trajectories don't ingest into the existing schema-versioned
indexers).

Specialist-shaped trajectories are what every downstream consumer
already knows how to read. That's not a coincidence — the
agentic-data-substrate spec's Tier 1.1 ("canonical trajectory
schema, enforced by the client") is kind-shaped because that's the
shape buyers will actually fine-tune against (`jinn-restore-defi-v1`,
`jinn-restore-prediction-v1`, etc., per §"What we'd sell" v2).

### 4.4 jinn-mono-2zk already chose operator-side, off-chain

The default-learning-restorer design spec
(`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md`)
resolved jinn-mono-2zk with:

- **(B) operator-side for v0** (not buyer-side, not protocol-side).
- **No protocol / engine state-machine changes.**
- **Off-chain only**, confined to `implStateDir`.
- **No ve-JINN tie**, no protocol-emitted training artifacts.

That resolution is structurally Option 2: the learner is one impl
running locally, with a `workingDir` (ephemeral) / `implStateDir`
(durable) split that already follows the trust-boundary's per-impl
filesystem rules. PR #38's wrapper-around-specialists shape goes
**further** than that resolution committed to — it makes the learner
visible to the engine ahead of the specialist, which is closer to a
protocol-side change than the spec authorised.

The cleanest read of PR #38: it shipped option-1 mechanics under a
spec that authorised option-2 mechanics. This ADR realigns them.

### 4.5 The corpus thesis is preserved without the wrapper

The agentic-data-substrate thesis ("every operator's trajectory
data is the corpus") is the strongest pro-Option-1 argument. It is
preserved by Option 2:

- Trajectory emission is an engine-level concern, not a substrate
  concern. Tier 1.1 of the agentic-data-substrate spec puts the
  canonical schema "enforced by the client" — the client is the
  daemon, not any one impl. The daemon already constructs
  `RestorationContext` per attempt and receives `RestorationOutput`
  back; that envelope is the natural place to log structured turns,
  for every impl.
- Specialists produce kind-shaped trajectories. Cross-kind learning
  is a downstream training-time concern (multi-task fine-tuning on
  the corpus), not a runtime architecture concern. The corpus
  doesn't need substrate-vocabulary trajectories to be
  cross-task-trainable; it needs schema-versioned per-kind
  trajectories that downstream training pipelines can mix.
- The challenge → hard-example pipeline (Tier 2.8) routes on the
  evaluator's verdict, which is per-(kind, attempt). It does not
  depend on the substrate's vocabulary.

In short: the corpus is the product, but the corpus is built from
specialists' outputs, not from substrate-wrapped envelopes. Option 2
is the architecture that lets the corpus thesis ship without forcing
a vocabulary onto every impl author.

### 4.6 Why Option 3 is not a real third choice

Option 3 (hybrid) is two engine paths: direct-to-specialist for
some kinds, substrate-wrapped for others. The cost is:

- Two trust models. The trust-boundary spec already cascades
  revocation through one signer set; a substrate adds a third layer
  whose cascade rules are undefined.
- Two `supports()` resolution rules. Today's first-match is already
  fragile (the codex review's must-fix #5 lives here). Adding a
  per-(kind, route) override doubles the cases.
- Two trajectory shapes. Substrate-wrapped envelopes are not
  schema-versioned the same way kind-shaped envelopes are; consumers
  have to learn both.

The only way to flatten Option 3's cost is to demote the substrate
to a service the impl chooses to call — at which point Option 3 is
indistinguishable from Option 2 with a learner library. That is the
form Option 2 already names.

## 5. Composition with the four sibling specs

This section spells out, per spec, what changes and what does not
under Option 2.

### 5.1 With `spec/2026-05-external-restorer-impls.md`

No changes. The external-impl flow already assumes one impl per
manifest, one identity per signer, one `supportedKinds` per impl. A
learner is just one more external impl (or one more in-repo entry in
`buildRestorerImpls`).

An external-impl author writing a learning-flavoured restorer
publishes their own `RestorerImpl`. They MAY internally use a learner
library — Pi, OTel-instrumented session manager, a constitutional
snapshot helper — and the SDK package (§3.6 of the external-impl
spec) MAY re-export those helpers for convenience. The library is
opt-in at the impl-author level, not enforced at the engine level.

### 5.2 With `spec/2026-05-executor-trust-boundary.md`

No changes. The boundary stays per-impl. A learner-flavoured impl
that uses Pi to spawn an inner agent does so inside its own
`run(ctx)` body, using `ctx.signer` / `ctx.rpc` / `ctx.secrets` /
`ctx.fs` capability handles. Pi spawns are subject to the same
boundary as any other side effect the impl performs.

The wrapper-vs-specialist asymmetry the codex review flagged
(must-fix #5) goes away with the wrapper: there is no asymmetric
gate to delegate, because there is no wrapper sitting between the
engine and the specialist in the first place.

### 5.3 With `spec/2026-05-schema-versioning.md`

No changes. The grammar `<domain>.v<major>` continues to identify
each kind. A learner-flavoured impl declares `supportedKinds`
exactly like any other impl (§4.2 entry grammar). It MAY support
many kinds (one entry per kind), but each entry is its own
`<kind>>=<semver>` pair — there is no `*` or "all-kinds"
construction.

Consumer dispositions (§5.2's drop-vs-surface decision rule)
continue to route on `kind`. A learner emits the same envelope shape
its specialist would have emitted; downstream readers do not need to
know an impl is learner-flavoured.

### 5.4 With `spec/2026-05-registry-discovery.md`

No changes. Source A (in-repo `buildRestorerImpls`) and Source B
(`restorers.externalImpls`) continue to be the only two boot-time
sources of impl candidates (§4.3). A learner is one entry in either
source.

The `restorers.disabled` field (§4.1) lets an operator turn off the
in-repo learner if they want to run the bare specialists; they do
not need a wrapper-flavoured config field to suppress substrate
behaviour, because there is no engine-level wrapper to suppress.

## 6. Where learning lives under Option 2

Three plausible shapes; impl authors and operators choose. All
three live inside one `RestorerImpl`'s `run(ctx)` and respect the
trust boundary. None creates a second engine code path.

### 6.1 Learner as library

An impl imports a learner library (Pi-based session manager + OTel
correlation + promotion gate, the shape from the default-learning
design spec) and calls it inside `run(ctx)`. The library is
re-exported by `@jinn-network/restorer-sdk`
(`spec/2026-05-external-restorer-impls.md` §3.6).

**Trust:** library code runs with the impl's capabilities, not its
own. Library bugs are impl bugs.

**Versioning:** library version is part of the impl's
`implVersion`. Bumping the library is a manifest minor under
`spec/2026-05-schema-versioning.md` §3.1.

**State:** library reads/writes inside `ctx.implStateDir/<sub-dir>`.
The impl chooses the sub-dir layout.

### 6.2 Learner as kind-specific specialist

An operator publishes a learner-flavoured external impl for a
specific kind: `prediction-v0-learner`, `lending-health-v0-learner`.
It declares `supportedKinds: ["prediction.v0>=1.0.0"]` (or whatever)
in its manifest, and it runs alongside the baseline / claude-mcp
specialists for the same kind.

**Resolution:** the engine's first-match still applies; operators
control ordering via `restorers.disabled` (subtractive) and a
follow-up `restorers.preference` (additive, named in §7 below) to
say "for this kind, prefer this impl." First-match without
preference is the current behaviour; a preference field is the
minimum extension this ADR requires.

**Trust:** the learner-flavoured impl has its own manifest,
signer, allow-list, and `implStateDir`. Revocation cascades
through it like any other impl (§5.6 of the trust-boundary spec).

**Corpus:** the learner emits the same kind-shaped envelope the
baseline does; from the corpus's perspective, both impls produce
trainable trajectories.

### 6.3 Learner as out-of-process service (Phase 2)

When `spec/2026-05-executor-trust-boundary.md` §6 (out-of-process
seams) is realised in Phase 2, a learner can run as its own
process / service that an impl calls into. The impl is still the
trust-boundary-visible unit; the service is its dependency.

This is the cleanest long-run shape for cross-impl learning: many
specialists call into one learner service, sharing trajectory data
across kinds, while each specialist retains its own identity and
allow-list. The §6.2 constraints (capabilities are functions, IO is
JSON-serialisable, no global state, no env inheritance) already
shape the impl side of that contract.

The trust-boundary spec is explicit that in-process Node is not a
real isolation boundary; cross-kind learning that aspires to
buyer-side packaging probably needs §6 process isolation regardless
of which architecture this ADR picked. Option 2 inherits the §6
upgrade path for free.

## 7. PR #38 disposition

The PR ships the option-1 mechanics this ADR rejects as a universal
pattern. Concrete repositioning, in order of cost:

1. **Drop `DefaultLearningWrapper` from the engine path.** The
   first-match wrapping of every `(kind, type)` does not survive.
   The default-learner becomes one or more kind-specific impls in
   `buildRestorerImpls`, registered alongside the existing
   prediction / portfolio / hyperliquid impls.

2. **Lock the default-learner's `supportedKinds` to the kinds it
   was actually validated against.** Plan 4 of PR #38 verified the
   loop on Claude Code 2.1.119; whichever kinds were exercised in
   that verification become the impl's `supportedKinds`. Other
   kinds get specialist-only routing until a learner-flavoured
   impl exists for them.

3. **Remove the `IntentSessionInputs.adapterEnv` two-pass
   protocol from the public envelope.** The wrapper-to-specialist
   handoff stops being protocol-visible. If the default-learner's
   internal Pi-based phases need a per-call env bag, that lives
   inside the impl (e.g. on its constructor or in
   `ctx.implStateDir`), not on `IntentSessionInputs`. This is the
   schema-versioning spec's §6.1 accept-both rule applied
   defensively: existing artifacts that referenced `adapterEnv`
   stay parseable for one release, then the field is removed.

4. **Add a `restorers.preference` config field (or equivalent).**
   First-match without operator override is what PR #38 was
   working around. A small additive field — `restorers.preference:
   { "prediction.v0": "@jinn/prediction-v0-learner" }` — gives the
   operator the same "this kind goes through the learner" choice
   PR #38's first-match was trying to grant, without an engine-level
   wrapper. Exact key shape is finalised by the loader bead
   (`jinn-mono-7zz` follow-ups, §7.2).

5. **Repurpose Plan 1 (the `client/plugins/default-learner/` Claude
   plugin)** as the operator-facing harness for the default-learner
   impl. The Claude plugin is unaffected by the engine-level
   architecture choice; it remains the agent-side surface an
   operator runs to author / debug / observe a learner cycle. Its
   contract with the engine is via the kind-specific impl, not via
   the dropped wrapper.

The codex review's must-fix #5 and the supports() asymmetry both
disappear once the wrapper is dropped: there is no longer a
delegating layer to mis-delegate gates through, and `supports()` is
declared per impl as it always was.

## 8. How operator-supplied restorers (jinn-mono-7zz) compose

`jinn-mono-7zz` already shipped `spec/2026-05-external-restorer-impls.md`
on the assumption that each external impl is a self-contained impl.
That assumption is what this ADR confirms.

Concretely, a third-party operator publishing a learning-flavoured
external impl does the same things they would for any external impl:

1. Implement the `RestorerImpl` interface
   (`client/src/restorer/types.ts`).
2. Use the learner library if they want one
   (`@jinn-network/restorer-sdk` re-exports per §6.1 above).
3. Sign their `jinn.manifest.json` with their ed25519 key, declare
   `supportedKinds`, declare `capabilities`, pin the tarball CID.
4. Publish; operators trust the signer, install the manifest, and
   the impl lights up alongside the in-repo impls.

There is no "second route" they pick depending on whether they want
learning. Learning is something the impl does internally, not
something the protocol surface enforces.

The naming pass before public ship (`jinn-mono-juw` / GH#43,
external-restorer-impls spec §7.2 step 9) applies normally; this ADR
adds no new public-surface vocabulary.

## 9. Acceptance and downstream impact

### 9.1 Acceptance

This ADR is accepted when:

1. It is merged under `spec/`.
2. `jinn-mono-7zz` description is updated to note that this ADR
   confirms the per-impl assumption the external-impl spec already
   made, and to point at this file as the architectural decision
   input.
3. `jinn-mono-bea` is closed.

### 9.2 Downstream tasks (informational, not committed by this ADR)

The repositioning of PR #38 from §7 is the load-bearing follow-up.
Suggested filing order if the Captain elects to land the ADR:

1. **PR #38 wrapper removal / scope-narrow** — drop
   `DefaultLearningWrapper` first-match; convert the default-learner
   into one or more kind-specific impls registered in
   `buildRestorerImpls`. Includes the `IntentSessionInputs.adapterEnv`
   accept-both window per §7 step 3.
2. **`restorers.preference` config field** — additive operator
   override per §7 step 4. Coordinates with the in-repo disable
   list (`spec/2026-05-registry-discovery.md` §4.1) so operators
   have both subtractive and additive control over impl resolution.
3. **Engine-level trajectory emission** — the canonical-trajectory
   work (Tier 1.1 of the agentic-data-substrate spec) is now an
   engine concern, not a substrate concern. Files at the engine /
   `RestorationOutput` boundary, kind-shaped.
4. **SDK learner-library re-exports** — once the per-impl learner
   shape stabilises, the SDK package
   (`spec/2026-05-external-restorer-impls.md` §3.6) re-exports the
   learner helpers (Pi session manager, OTel correlation,
   promotion gate). Optional; impl authors can copy the helpers
   if the SDK lags.

### 9.3 Open questions deferred

- **Cross-impl learning service.** The Phase 2 out-of-process
  shape from §6.3 above is plausible once
  `spec/2026-05-executor-trust-boundary.md` §6 ships, but its wire
  protocol and trust-mediated cross-impl trajectory access are
  unspecified. A future spec covers it; this ADR only commits that
  the Phase 2 path stays open.
- **Buyer-side corpus filtering / tiering.** The (C) half of
  jinn-mono-2zk's question (deferred there) remains open. This ADR
  is consistent with whatever buyer-side product lands, because
  per-impl trajectories are the substrate the buyer-side product
  reads from.
- **Substrate-vocabulary cross-kind learning research.** The
  Orient → Strategize → Plan → Execute → Debrief → Improve →
  Memory loop may still be the right shape *inside* a learner-
  flavoured impl. This ADR does not ban that vocabulary; it bans
  the vocabulary becoming the engine-level envelope.

## 10. References

- `spec/2026-05-external-restorer-impls.md` — external-impl loader;
  per-impl identity, manifest, lifecycle.
- `spec/2026-05-executor-trust-boundary.md` — per-impl credentials,
  filesystem, provenance, revocation, out-of-process seams.
- `spec/2026-05-schema-versioning.md` — kind grammar,
  `supportedKinds` advertisement, consumer compatibility policy.
- `spec/2026-05-registry-discovery.md` — Source A (in-repo) +
  Source B (`restorers.externalImpls`) discovery model.
- `spec/2026-04-21-agentic-data-substrate.md` — corpus thesis;
  Tier 1.1 canonical trajectory schema is engine-level under this
  ADR.
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md`
  — operator-side, off-chain, no-protocol-changes resolution that
  this ADR realigns PR #38 with.
- `client/src/restorer/types.ts` — `RestorerImpl` interface; the
  per-impl unit this ADR centres on.
- `client/src/restorer/impls/index.ts` — `buildRestorerImpls`; the
  in-repo registry that stays as Source A.
- `jinn-mono-bea` — this ADR's filing bead.
- `jinn-mono-8dr` — codex review of PR #38; must-fix #5 is
  resolved by the wrapper removal in §7.
- `jinn-mono-2zk` — default-learner scope question; resolved
  upstream of this ADR via the design spec above.
- `jinn-mono-7zz` — operator-supplied restorers; this ADR
  confirms its per-impl assumption.

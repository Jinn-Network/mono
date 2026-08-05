# DR-2026-08-04-b — Headless Operator Reconciliation

- **Date:** 2026-08-04
- **Status:** Ratified (design session, Ritsu)
- **Owning spec:** [`docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md`](../../docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md)
- **Amends:** operator-daemon composition design (§3, §6.2, §10, §11),
  `client/OPERATOR-APP-SPEC.md`, `DEPLOY.md`, cutover stage plans 1/3/4, the Phase D
  cutover plan (out-of-repo). Each carries a dated amendment note pointing at the spec.

Suffix `-b` distinguishes this from DR-2026-08-04 (spec-origin and vocabulary), a
different decision of the same date.

## Decisions

1. **The composition frame governs.** The Phase D "native default flip" framing
   (`verticalMode` flip, D-minus parity table) dissolves into the six-stage in-place
   cutover. Native-v1's runtime is the machinery the stages swap in; its parallel entry
   point retires when the stages complete. The Phase D estate-retirement machinery
   (transition manifest, deletion gates, usage instrumentation, observation receipts) is
   retained for stage-driven retirement.
2. **Headless node first; the application tier is re-derived, not carried.** The daemon
   is infrastructure — receipts, versioned read plane, control plane. The human surface
   is a **separate operator console** (tier-4, Next.js + shadcn, operator persona only),
   a pure client of the published contract, subject to the spec §9 remote-access
   preconditions.
3. **Control/application route split under the intent-module law** (spec §4): control
   intents are pure modules with CLI and HTTP as non-invoking front-ends; application
   routes die with their machinery. "Headless" means *no application logic in HTTP*, not
   *no writes* — CLI-only mutation was refuted (halted-boot unblock is a route; the
   daemon-guard correctly blocks concurrent CLI broadcasts; hosted nodes cannot shell).
4. **Fail-closed on integrity, degrade-open on economics** (spec §5), including the
   pinned broadcast-target address-set check on the integrity side and
   `configShapeVersion`-newer on the degrade-open side (preserving the ratified rollback
   posture). Per-loop admission is a registry field.
5. **Receipt authority classes** (spec §7): Class O (observation — never read by a gate,
   enforced) vs Class A (authority — DSSE-sealed, external facts externally resolved).
   A PR flipping a transition-manifest row to `deleted` must cite Class A evidence.
6. **The read contract becomes an artifact before the SPA departs** (spec §8):
   `contractVersion {major, minor}`, shared schema module, console handshake, release-tier
   conformance test, the no-CLI-in-routes guard, the de-duplicated lifecycle vocabulary,
   and the unknown-kind rendering rule.
7. **Sequencing:** the design binds now (contract discipline, §11 bootstrap repairs, §14
   security repairs in their stated order); the split listener lands at stage 4; the
   surface execution is **stage 6**, after the stage-5 rename, gated on the §8 artifacts
   and on re-homing the two mutation-asserting e2e gates onto the console pipeline.

## Provenance

Design session 2026-08-04 per the stack design principles §12 method: four read-only
research lanes (inventory, standards audit, requirements register, adversarial boundary
review), reconciliation, one-question-at-a-time approvals, two fresh pre-presentation
reviews (architecture; standards/adversarial) whose six blocking findings were fixed in
the spec's v0.2 (§18 review log there).

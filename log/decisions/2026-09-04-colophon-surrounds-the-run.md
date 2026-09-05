---
id: DR-2026-09-04
title: Colophon is what surrounds the run; the runner is not the product
date: 2026-09-04
verb: Decide
status: proposed, from design issue #3973; ratified on code-owner approval of this record
owning-docs: packages/benchmark-product/README.md, INSPECT-RUNTIME.md, EXTERNAL-RUN-IMPORT.md, PUBLIC-BUNDLE.md
---

# DR-2026-09-04: Colophon is what surrounds the run

## Context

Colophon carries two kinds of code. One kind is the seal and everything around
it: lock and anchor a method before the run, read a finished run into sealed
evidence, materialise a bundle, publish it, verify it from outside, show it on a
board. The other kind runs benchmarks: the native runtime with its dispatch,
journal, resume and recovery; per-suite hosts and launchers for seven named
suites; the whole method of one comparison of our own (Demo-1 on SkillsBench);
and the programme scaffolding that drove those.

The judge report (evidence repository `colophon-claims/locomo-judge-report`,
run-completion amendment of 2026-09-01) is the one checked evaluation produced
end to end so far. What it showed is that only the first kind carries the
product. The disclosure this product seals into every report from a local run
(`core/src/operations/run-results.ts`, `LOCAL_VENUE_LIMITS`) already says so:
the venue is self-run, pre-registration is "a discipline enforced by this tool,
not a proof against the run's own owner", and the admission gate that pins
harness, model and loadout runs on the owner's own machine. Inspect logs the
model per sample, Harbor records the container digest, every provider echoes
its model id; none of those is independently attested either, and neither is
ours. Pinning becomes proof when someone other than the claimant controls the
venue. That is a property of the venue, not of the runner.

The runner's orchestration is what the two-day window between the judge
report's lock and a run that stayed up was spent on (#3068, #3075, #3083,
#3183, #3172). None of the failures after that lock was a runner failure: the
anchored claim closure that could not carry a qualification projection
(#3212), refused publishes leaving bundle directories behind (#3181, #3204,
#3211, #3216), a leak scan that went red on base64 (#3189), a published
format with no reader documentation (#3320), a site that could not ingest the
formats the report was emitted in until the Monday after the run, and a
verifier that published four and a half hours after the report it verifies.
Those are all on the seal's side of the line, and they are the fix list.

## Decisions

1. **The product is what surrounds the run.** The lock comes first: every
   claim runs lock, then run, then bring the run back, then bundle, publish,
   and anyone verifies. The lock fixes the method and anchors it publicly
   before results exist. Who runs, and on what, is the only variable.

2. **Two ways the run happens, and both are seals.** The claimant runs the
   benchmark on Harbor, Inspect or their own harness and brings the finished
   output; Colophon checks it against the sealed slate (every task present
   once, every outcome from the closed vocabulary, every gap counted with a
   stated reason, no exclude flag), bundles and publishes it. Or Colophon
   runs it on a venue Colophon controls, and three lines of the sealed
   disclosure flip from the claimant's word to Colophon's: who controlled the
   machine, whether pinning held, whether costs were independently seen. That
   is venue independence, and it is the whole of what the service adds.

3. **An adapter is a reader.** One per harness, from its native finished
   output into the sealed evidence: Harbor jobs and trials, Inspect `.eval`
   logs, generic per-attempt rows (#2979). An adapter is not a way for
   Colophon to launch that harness. `INSPECT-RUNTIME.md`'s line that
   "bringing a completed Inspect evaluation is not [the integration]" inverts:
   bringing a completed run is the product path.

4. **The runner is two things.** Its evidence model (every attempt a sealed
   record, a closed outcome vocabulary, the Task, Execution and Result shape a
   bundle is rebuilt from) is the seal's own vocabulary and stays. Its
   orchestration survives only as the service's machinery on Colophon's own
   venue, and receives no investment toward surviving on a claimant's machine.

5. **Colophon creates no benchmarks and runs none as a product.** The method
   of Demo-1 on SkillsBench leaves the code. The seven official-suite records
   keep their *knowing* decisions (named protocol identity, two-axis
   comparability, exports as derived artifacts and never the claim of record,
   aggregation and metrics) and lose their *running* decisions (official trial
   settings as something Colophon executes, one Job per arm, quote before
   full-suite lock, harness pins as launch configuration, qualify scripts).
   The suite identity is what a board is keyed on; the suite host is what the
   service launches.

6. **The verifier is never cut.** `verify/src/legacy-closures.ts` freezes
   formats /2, /4, /6 and /7 and is kept forever; /5 and /7 are published.
   Nothing a published bundle depends on is removed, including the admission
   checks that verify the judge report's screening claims and the
   binary-instrument profile they read.

7. **Order of work.** Cuts first (design issue #3973, item 3), each as its own
   issue after this record is ratified. Then the builds in the order a
   claimant hits them: publish `@colophon-claims/cli` and `core`; an honest
   slate pin for Terminal-Bench 2.1 (the current `intake/<suite>.ts` files
   are fixture shims, not pins); the Harbor reader, then the Inspect reader;
   #3417. The board's front door is a design fork after that, not part of
   this train. The walkthrough that tests all of it is #2851, rewritten.

## Consequences

- `packages/benchmark-product` loses about 24,000 source lines and 20,000
  test lines across six families (design issue #3973, item 3). About 15,000
  source lines of orchestration stay as the service's machinery.
- The six `intake/<suite>.ts` shims are replaced by real slate pins, one suite
  at a time, starting with Terminal-Bench 2.1.
- `EXTERNAL-RUN-IMPORT.md` becomes the front page of the product path;
  `INSPECT-RUNTIME.md` and the "Real Harbor publication rehearsal" section of
  `README.md` are re-scoped to the service.
- The site's Demo-1 report page ("Do you need a Skill, or is CLAUDE.md
  enough?", format /5) is a demo of a thing the product no longer does, and
  its verify instruction names a bundle no reader can fetch (#3941). Its
  disposition is a separate operator decision on the site repository.

## Alternatives rejected

- **Keep the native runner as the product and make it cheap.** Rejected: on a
  claimant's machine it gives exactly the trust of bringing the run (the
  product's own disclosure says so), with more machinery to break.
- **Attest at the model-call seam without controlling the venue** (a proxy on
  the provider calls). Not rejected; not designed. It is a third way to answer
  "who ran it" and can be taken up when a claimant asks for it.
- **Honest labelling only, no service.** Rejected as the whole answer: the
  service is the only thing that flips the disclosure, and the disclosure is
  what a skeptic reads.

## Ratification

Proposed 2026-09-04 from design issue #3973. Ratified on code-owner approval
of this record by the operator credential that did not author it.

## Amends (at ratification)

- DR-2026-08-17 (runtime engine direct mode): decision 1 re-scoped to the
  service venue; decision 6 reversed, foreign-run import is the product path.
- DR-2026-08-17-b (Terminal-Bench 2.1), DR-2026-08-17-e (SWE-bench Verified),
  DR-2026-08-18 (APEX-Agents), DR-2026-08-18-b (Terminal-Bench 3.0),
  DR-2026-08-18-c (APEX-SWE-dev), DR-2026-08-18-d (DeepSWE v1.1),
  DR-2026-08-18-e (Inspect eval): running decisions superseded per decision 5;
  knowing decisions stand.
- DR-2026-08-16 (Demo-1 SkillsBench source amendment): closed; the comparison's
  method leaves the product.
- Does not amend: DR-2026-08-18-f (method operand); the catalog and the
  `method` verb stay. Does not touch `packages/evidence`, `packages/trust`,
  `packages/task-execution`.

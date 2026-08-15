# Benchmark Publication Interoperability — Local Issue Drafts

No GitHub mutation is authorized for this implementation session. These drafts preserve the required issue ceremony; local completion is not merge-ready until owning issues exist and CODEOWNERS review is complete.

## Epic: publish independently verifiable benchmark records through Jinn

Deliver the approved interoperability profile end to end: reusable record and publication contracts, complete per-dispatch accounting, Colophon public-before-run and no-rerun post-hoc flows, Harbor/Terminal-Bench 2 execution compatibility, durable Record Discovery persistence, and independent verification. Marketplace execution, settlement, deployment, and arbitrary historical imports are excluded.

Acceptance: the PUB-15 conformance suite proves exact-byte publication over loopback HTTP; registration order and complete dispatch accounting; accounting-only and Report v2 closure; legacy compatibility; crash recovery; origin-authority preservation; and zero backend calls during post-hoc publication.

## Child packets

- PUB-01: BenchmarkAccounting v1, observation archive, Report v2, and publication extension contracts.
- PUB-02: neutral `@jinn-network/record-publication` engine and durable source adapter.
- PUB-03: benchmark accounting facts and tri-state verification.
- PUB-04: exact runner capture, explicit single-attempt bounds, and Matrix v2.
- PUB-05: aggregate Report v2 production and verification.
- PUB-06: evidence-publication API-compatible adapter.
- PUB-07: reusable `@jinn-network/benchmarking-publication` orchestration.
- PUB-08: runtime evidence contributor contract with native and Inspect migrations.
- PUB-09: Colophon publication state, full dispatch journal, and legacy compatibility.
- PUB-10a: Harbor selection and immutable manifest.
- PUB-10b: Harbor worker/job/trial archive with visible replacement dispatches.
- PUB-10c: Harbor evidence contribution and verification.
- PUB-11: Terminal-Bench 2 selection, migration provenance, and opt-in smoke test.
- PUB-12: Colophon source authorization, filesystem/HTTP persistence, registration, and pre-submit announcements.
- PUB-13a: accounting and Matrix v2 publication.
- PUB-13b: optional Report v2 publication without rerunning tasks.
- PUB-13c: public bundle v3 and artifact disclosure choices.
- PUB-14a: core and CLI publication experience.
- PUB-14b: HTTP and web publication experience.
- PUB-15: end-to-end conformance, generated architecture, final review, and handoff evidence.

Each child issue must copy its relevant design invariants, name its dependencies, require red-first tests and package gates, and explicitly prohibit marketplace product wiring and changes to frozen v1 formats.

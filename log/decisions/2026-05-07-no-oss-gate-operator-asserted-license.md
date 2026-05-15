---
id: DR-2026-05-07-c
title: No protocol-level OSS gate; license is operator-asserted
date: 2026-05-07
verb: Steer
status: ratified
authors: oaksprout, opus (drafted on jinn-mono-6m7t)
spec: spec/2026-05-07-telemetry-collector-and-task-generator.md
---

## Context

The brief surfaced "OSS verification at capture time" as one of the three architecturally load-bearing decisions: how does the collector verify the working session is in an OSS-licensed repo? Four options were considered:

- **(α) License-file parse + SPDX whitelist.** Walk to git root, parse LICENSE/SPDX headers, refuse capture if no recognised license found.
- **(β) GitHub API license probe.** Resolve git remote, query GitHub's licenses API. More authoritative than file parsing.
- **(γ) User attestation per-repo, no automatic verification.** UI asks operator to declare the license first time per repo.
- **(δ) Local file parse with user-attestation fallback.** Combine (α) deterministic detection with (γ)'s graceful path for repos lacking standard license metadata.

The user pushed back on the framing: *"I wonder if we even need to make the OSS distinction — doesn't it just complicate it? It's up to the operator what they want to sell to the network."*

This pushback reframes the question from "how does the protocol verify OSS status" to "should the protocol verify OSS status at all."

## Decision

**No protocol-level OSS gate. License is operator-asserted; protocol facilitates redistribution; operator carries legal liability.**

Concretely:

- **Detection without enforcement.** The collector does best-effort SPDX file parsing when capturing, but only as a UI hint — never as a publishing precondition. Detected SPDX-id is stamped into `sessionProvenance.license.spdxId` if found.
- **Operator assertion is the canonical signal.** `sessionProvenance.license.operatorAssertion` is `'asserted' | 'unspecified'`. The Captures-tab review step lets the operator confirm or override the detected license. Default is whatever was detected (if anything); operator can edit before approving.
- **The protocol parallel is x402.** x402 facilitates payment-gated artifact access; it does not verify that the seller has legal rights to what they're selling. Same posture here: protocol facilitates capture-envelope redistribution; operator is responsible for what they publish.
- **The "trust this repo" toggle is the operator's explicit consent moment.** UI surfaces "you are asserting you have rights to publish work from this repo" alongside the toggle. That's where the legal posture is documented.

## Rationale

- **OSS gating doesn't reduce the operator's liability.** An operator who publishes proprietary code from a repo with an MIT license file (because they failed to update the license, or it was wrong-headed in the first place) is still liable. The license file is *evidence* of intent, not a *guarantee* of rights. Adding a SPDX-parse gate creates the illusion of protocol-enforced safety without the substance.
- **License detection is brittle.** Monorepos with subpath licensing, dual-licensed code, license files in non-standard locations, project-internal licensing relative to upstream code, vendored OSS code in a private project — all break SPDX-file-parse heuristics. A gate that fails on these creates either operator workarounds (lying to the gate) or capability holes (operators excluded from the substrate by tooling false-negatives).
- **GitHub API probing has its own problems.** Requires a token; fails for non-GitHub remotes (GitLab, Codeberg, internal mirrors); can't verify offline state; rate-limited; brittle on monorepos.
- **The reference-don't-redistribute principle in the SWE-rebench-v2 spec §4.3 doesn't apply here.** That principle is about benchmark Task payloads referencing canonical external sources. Captures are inherently a redistribution model — the trajectory is the canonical artifact only because the operator captured it; there's no external authority to defer to. Applying a redistribution-prevention principle to a redistribution model is category-confused.
- **The operator-asserted posture matches how operators already think about their work.** "I'm publishing a session I worked on; I have rights to publish it" is a posture a developer can reason about. "The protocol's SPDX parser thinks this is MIT" is one they cannot.

## Alternatives considered and rejected

- **License-file parse + SPDX whitelist gate.** Rejected for the false-safety reason: gating creates the illusion of protocol enforcement without the substance, and excludes legitimate operators via tooling false-negatives.
- **GitHub API license probe.** Rejected for the brittleness reason: token requirement, non-GitHub remotes, rate limits, monorepo failure modes. Strict subset of the SPDX-parse failure modes plus its own.
- **User attestation per-repo with no detection.** Considered acceptable but strictly weaker than detection-as-hint: detection costs nothing extra (the collector is already walking the repo for sessionProvenance) and provides genuine UX value (the operator sees "this looks like MIT" and confirms or corrects).
- **Hybrid file-parse with attestation fallback as a hard gate.** Rejected for the same false-safety reason. The hybrid pattern is the right *UX* (detect → confirm), but enforcing publish-refusal on detection failure is the wrong *protocol stance*. The hybrid lives in the operator UX, not as a protocol gate.

## Consequences

- **Removes a whole branch from the collector.** No "license parse failed → refuse" path. Simpler implementation; fewer edge cases.
- **Documentation must make liability explicit.** Operator-facing docs and the trust-this-repo UI moment carry the legal posture: "you are asserting you have rights to publish work from this repo."
- **Corpus consumers can filter on license.** `sessionProvenance.license` is published metadata; downstream readers (task-generator, leaderboard surfaces, future SolverNets) can filter or weight on the operator-asserted signal.
- **The SWE-rebench-v2 spec's reference-don't-redistribute principle is correctly scoped, not weakened.** Spec §7 calls out the departure: benchmarks reference canonical sources; captures redistribute operator-asserted-licensed content; future SolverNets choose the right model per case.

## Status

Ratified by Captain oaksprout during the design exercise on jinn-mono-6m7t; locked 2026-05-07.

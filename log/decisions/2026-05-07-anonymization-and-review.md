---
id: DR-2026-05-07-b
title: Anonymization scope and verification — identity + path scrub; batch UI review; trust-this-repo
date: 2026-05-07
verb: Steer
status: ratified
authors: oaksprout, opus (drafted on jinn-mono-6m7t)
spec: spec/2026-05-07-telemetry-collector-and-task-generator.md
---

## Context

The collector publishes locally-captured agent sessions to the corpus. Two coupled questions: what does it scrub, and how is the scrub verified before publish.

Today's V1 secret-scrub (`client/src/trajectory/secret-scrub.ts`) is a pattern-based credential drop (`authorization`, `apiKey`, `bearer`, `password`, `secret`, `token`, `privateKey`). The code's own comment is explicit: *"This is safety, not access control. IP-protection redaction lives in the deferred gating epic."* Captures need more — identity-bearing metadata (paths, usernames, hostnames, git author) is the additional surface.

Three scrub-scope options were considered, crossed with three verification models.

Scrub scopes:
- **Identity + path scrub, NL kept verbatim.** Pattern-based, OpenTelemetry-Collector-style. Deterministic, auditable, off-the-shelf.
- **Identity + path + auto-LLM-mediated NL scrub.** Local LLM rewrites prompts, outputs, tool results. Stronger guarantees; per-session latency cost; non-determinism; harder audit.
- **Identity + path scrub default, NL scrub opt-in.** User flips a config to enable LLM-mediated NL scrub per-session.

Verification models:
- **Daemon self-attests + UI confirmation gate per session.** Operator clicks publish.
- **Daemon self-attests, no UI gate.** Lowest friction; risk of unintended publish.
- **Layered trust stack (mirror DR-d in sibling).** Daemon + UI + bonded auditor + reputation slashing.

The user pushed back on the per-session UI gate ("we can't have a UI gate for every session"), proposing batch review instead.

## Decision

**Two-part decision:**

1. **Scrub scope: identity + path scrub on top of today's V1 credential scrub. NL kept verbatim. LLM-mediated NL scrub deferred to v0.5+.**
2. **Verification model: daemon self-attests with batch UI review at the operator's cadence; per-repo "trust this repo" auto-approve toggle; bonded auditor tier deferred to v0.5+.**

Implementation: the collector's processor stack runs identity/path/credential scrubs, signs a `captureManifest` extending the existing `redactionManifest`, and writes the assembled envelope to a **pending captures queue**. Operators review via a Captures tab (drill-in to redaction diff, batch select-and-approve). Per-repo trust toggle skips the queue for repos the operator has already vetted at least once.

## Rationale

- **OpenTelemetry has off-the-shelf processors.** The OTel SDK ecosystem has a redaction processor and a transform processor that handle pattern-based scrubbing. Replacing the bespoke V1 scrub with the SDK stack is mechanical and unlocks ecosystem-wide processor improvements automatically.
- **Pattern-based scrubs are auditable.** Deterministic; the `captureManifest.scrubProcessors[]` records which versions ran; bonded-auditor work in v0.5+ can verify what's actually visible matches what was claimed scrubbed.
- **LLM-mediated NL scrub has too many failure modes for v0.** Non-determinism, audit difficulty, latency, and cost all undermine the trust posture v0 needs to establish. The v0.5+ deferral is honest about the tradeoff.
- **Per-session UI gates create friction at the wrong moment.** Operators with verbose sessions would either disable the gate (no review) or stop using the collector (no captures). Batch review at the operator's cadence is the right friction model: low friction at session boundaries; explicit consent at publish time.
- **"Trust this repo" closes the per-repo loop.** First-time review for a new repo is the operator's explicit consent ("yes, I have rights to publish work from this repo, yes the scrub looks right"). Subsequent captures from the same repo can auto-publish without re-asking the same question.

## Alternatives considered and rejected

- **Auto-LLM-mediated NL scrub at v0.** Rejected for v0 scope. Filed as v0.5+ with the opt-in pattern; the trust posture for LLM-mediated scrubs benefits from production data on the simpler pattern-based path first.
- **No UI gate at all (daemon self-publish).** Rejected for the trust-establishment reason. Operators publishing capture envelopes from work they didn't realise was identifying is a class of failure the UI gate prevents at low cost. The trust-this-repo toggle is the escape valve for high-confidence repos.
- **Per-session UI gate for every capture.** Rejected for the friction reason (user pushback). Batch review is the right cadence.
- **Bonded auditor + slashing at v0.** Rejected as out of scope for "small change to existing operator app." Filed as v0.5+ with the reputation-slashing path mirroring DR-d in the sibling spec.

## Consequences

- **`jinn-mono-h43b` is a precondition for ship.** The proper anonymization tool replaces the V1 pattern set with the OTel SDK processor stack. Captures depend on this; existing trajectory pipeline migrates onto it (per DR-e).
- **`captureManifest` extends `redactionManifest`** (additive) with operator review attestation, scrub processor versions, and the trust-this-repo flag.
- **Operator app gains a Captures tab.** Pending queue, drill-in, batch approve, per-repo trust toggle. Sized at ~5-6 days engineering per spec §8.1.
- **Per-repo trust state lives in operator config** (`captures.trustedRepos: string[]`). Operator can revoke at any time.
- **Future: bonded auditor reads `captureManifest.scrubProcessors[]`** to verify operator's claimed scrub matches what's actually visible. v0 ships the manifest; v0.5+ ships the auditor.

## Status

Ratified by Captain oaksprout during the design exercise on jinn-mono-6m7t; locked 2026-05-07. `jinn-mono-h43b` filed as the precondition workstream.

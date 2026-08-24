# PREREGISTRATION AMENDMENT 1 — venue-identification vs execution split

Committed 2026-08-03, mid-run. PREREGISTRATION.md §§1–5 are frozen and remain
untouched; this amendment adds a **classification and interpretation layer**
on top of §4. It changes no thresholds, no instances, no task prompts, no
severity mapping, no scoring code. It is binding for RESULTS.md.

## Disclosure: what was already scored when this was committed

24 of 42 cells — the full long-tail tier (L1–L4) — were scored before this
amendment. Results known to the authors at commit time: L1 Aave V4 6/6 pass
(including L1a, a designated hard-ambiguous instance, 3/3), L2 Cooler 5/6
(one `incomplete`), L3 Twyne 4/6 (two `incomplete`), L4 Fira 6/6. The
mid-tier (M1–M3, 18 cells) — which contains the two remaining
ambiguity-designated instances M1a (hard) and M2a (soft) — was unscored.
The amendment is therefore committed before the cells it most affects, but
after a long-tail tier that ran cleaner than predicted. Both facts are stated
so the reader can weigh them.

Motivation (from the strategy thread, 3 Aug): the product hypothesis under
test has two possible surfaces — "agents can't execute long-tail protocols"
and "agents can't safely *identify the venue* in the long tail" (the prior
probe's T6/ghost-market class). §4's aggregate kill rule cannot distinguish
them, and a competence-green result would otherwise be read as killing both.

## Classification (applies to every scored cell in RESULTS.md)

Every **failure** is classified as exactly one of:

- **VENUE-IDENTIFICATION** — the agent committed funds or votes to the wrong
  venue/market/pool/spoke/maturity when the task description matched multiple
  on-chain candidates, or resolved an ambiguity wrongly — regardless of how
  clean the subsequent mechanics were. (The T6 class: wrong target, flawless
  encoding.)
- **EXECUTION** — right venue, wrong mechanics: encoding, approvals,
  sequencing, protocol-state-machine violations (epochs, floors, maturities),
  accounting (interest-first, share decimals), incomplete unwinds, leftover
  intermediate tokens.
- **DISCOVERY-STALL** — the agent could not locate the venue or interface at
  all and stopped (or reported inability). Kept separate from
  venue-identification because it fails loudly rather than silently
  misdirecting funds; it is a knowledge-gap signal, not a safety signal.

Additionally, every **pass** on an ambiguity-designated instance (M1a, M2a,
and the already-scored L1a) is annotated with *how* the agent resolved the
ambiguity (activity/TVL check, official API/registry, docs, luck — as
evidenced by the transcript), so identification competence is measured on
passes too, not only inferred from failures.

## Pre-committed interpretation (binding, supplements §4)

1. **The competence thread dies entirely** only if BOTH classes are clean:
   every family ≥90% (§4 unchanged) AND zero venue-identification failures
   across the matrix. Only then is "execution and identification are both
   free at the buyer-grade model" the verdict.
2. **Execution clean, identification dirty** (any venue-identification
   failures here, which would corroborate the prior probe's confirmed T6
   class): verdict is "execution is free; venue identification/curation is
   the surviving product surface." This is a narrowing, not a kill — and it
   is the branch under which the plugin's value shifts from
   "makes execution possible" to "makes venue choice safe."
3. **Identification clean (including M1a/M2a), execution dirty**: the product
   surface is procedural/protocol knowledge, per §4's existing ranking rule.
4. Discovery-stalls count against family pass rates as before (they are
   failures under §4) but do not count as venue-identification failures under
   rule 1/2.

No renegotiation of these rules after the remaining 18 cells score.

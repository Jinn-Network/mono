# Session brief M — Stage 2 meta session: reconcile the three designs, plan Stage 2

Run this **after** the three design sessions (A: onboarding, B: corpus supply, C: architecture)
have merged their specs. This is the session that makes binding decisions — deliberately last,
with the most information. **Read `docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md`
first**; its working assumptions were presumptions until now — this session ratifies or flips
them.

## Inputs

1. The three specs (locate by date pattern in `docs/superpowers/specs/`, 2026-07-1x/2x:
   `*onboarding-design*`, `*corpus-supply-design*`, `*stage2-architecture-design*`) — read each
   in full, **then extract the three "Seams & assumptions registers" side by side. Start the
   reconciliation from the register diff, not from re-reading prose.**
2. The framing packet's known-seams table — every row must be resolved or explicitly deferred.
3. The Stage 1 close-out record: issue #1654 (walkthrough evidence + ratified proceed), the
   rescope plan (`docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md`), and
   the roadmap's Stage 2 section (the requirements this plan must cover).
4. The open backlog touching these tracks: #1776, #1783, #1784, #1792, #1797, #1799, #1800,
   #1754 — plus whatever the design sessions' proposed-issues tables contain.
5. Precedent for the output shape: `spec/2026-04-30-phase-a-umbrella.md` +
   `docs/superpowers/plans/2026-04-30-phase-a-umbrella-plan.md` (the umbrella pattern), and the
   rescope plan §5/§8 (work decomposition with merge-pairing and ownership boundaries — the
   execution pattern that worked).

## Method

1. **Register diff.** Build the seam matrix: for each seam, what each side assumed/provides/
   would renegotiate. Classify: agree / conflict / gap (nobody owns it). Conflicts and gaps are
   the session's decision list.
2. **Ratify the working assumptions.** For W1–W4, read the three flag-sets ("where my design
   changes if this flips") and decide. Output: **one decision record** at
   `log/decisions/2026-07-XX-stage2-charter.md` covering, at minimum: the capture/outbound
   split (what "parked" means in code, and until which named stage), the two-tier corpus rule,
   zero-consent onboarding, and the retrieval escalation ladder — with the amendment list for
   the affected docs (Stage 1 product design P4/P7 posture, harness-network D3/D5 sequencing —
   amend those docs in this session's PR, following the rescope's amendment style).
3. **Amend the specs where reconciliation changed them.** Small deltas in place (same-PR),
   never parallel restatements — the rescope precedent.
4. **Write the Stage 2 umbrella plan** at
   `docs/superpowers/plans/2026-07-XX-stage2-umbrella-plan.md`: the three tracks plus the
   Stage-1 debt backlog as one program — per track: goal, gate, issue train; globally: the
   dependency/merge-pairing graph (declare which units pair into single PRs and which files
   must not be touched concurrently — the rescope's convergent-file discipline), what runs in
   parallel, and each track's **operator verification moment** (the live-walkthrough discipline:
   nine Stage-1 defects were CI-invisible; every track ends with a hands-on run).
5. **File the combined issue train.** This is the filing session: reconcile the three
   proposed-issues tables, dedupe, file as sub-issues under a new Stage 2 tracking issue with
   Issue Types set, cross-linked to the specs, merge-pairing recorded as coordination comments
   where units pair. Verify against the roadmap's Stage 2 bullets: every bullet maps to an
   issue or an explicit deferral.

## Constraints

- Decisions land as the DR + doc amendments — never as chat-only conclusions.
- Bias per the rescope experience: reduce surface area; sequence convergent changes; keep every
  merged state green; prefer the smallest complete slice per track before refinement.
- Cadence note: PRs target `next`; docs merge fast; the tracking issue keeps operator-owned
  items (walkthrough moments, ratifications) explicitly assigned to the operator.
- End with a short "how the tracks run" note: the coordination pattern (coordinator + Sonnet
  implementers + review-proportional-to-size + operator-as-user-tester) is the working default
  unless the operator changes it.

## Output checklist

- [ ] `log/decisions/2026-07-XX-stage2-charter.md` (the ratified DR)
- [ ] Doc amendments (Stage 1 product design, harness-network spec) in the same PR
- [ ] Spec deltas from reconciliation (if any) in the same PR
- [ ] `docs/superpowers/plans/2026-07-XX-stage2-umbrella-plan.md`
- [ ] Stage 2 tracking issue + filed, typed, cross-linked issue train with pairing declared
- [ ] Every framing-packet seam row resolved or explicitly deferred with a reason

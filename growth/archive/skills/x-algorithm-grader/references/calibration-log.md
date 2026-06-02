# Calibration log

Empirical track record. Update this after observing a published post's reach (post-mortem mode in SKILL.md).

The model is a starting point. This log is what makes it Oak's model.

---

## How to add an entry

```
### YYYY-MM-DD — [first 60 chars of post]

URL: https://x.com/...
Predicted score: 0.XX
Predicted binding constraint: [factor]

Observed:
  Impressions:           N
  Engagement rate:       X%
  Reply-to-reply fired:  yes / no / N times
  New followers:         N (cluster-relevant: N)

Delta explanation:
  [Why model was right or wrong on this one]

Model update (if any):
  [Specific factor multiplier to adjust for this account]
```

---

## Recalibration trigger

After ~10 entries, look for systematic bias. Examples of what to watch for:

- Same factor consistently overpredicting (e.g., predicted high cluster fit but reach flat → tighten cluster-fit detection)
- Same factor consistently underpredicting (e.g., low velocity score but post still reached → revival window may be more forgiving than modelled)
- Tone overlay multipliers: are constructive posts hitting the predicted 1.1–1.2x or higher / lower for *this* account?

Make one model-side adjustment per recalibration. Don't tune everything at once — you'll lose signal on what changed.

---

## Entries

### 2026-05-04 — Today's main Teach (multiplayer-shadow-eval)

URL: TBD — capture from Oak's profile
Predicted score: 0.77
Predicted binding constraint: velocity_plan (0.75) — Monday borderline peak; no +5 self-reply (reply-as-pre-warm strategy used in lieu of self-reply lift).

Account context at time of publish:
  Tweepcred state: lapsed (5 days since last original; 2 originals/30d vs ~21 target)
  Premium: assumed yes (~6x reach baseline)
  Predicted-reach cap flagged: lower half of normal range regardless of factor scores

Factor scores (per scoring-tables.md):
  cluster_fit          0.9   (bridging lexicon — agent-builder, harness, evals, central-labs angle)
  format               1.0   (text post, no media)
  length               1.1   (~720 chars Premium long-form, post earns its length)
  tone                 1.15  (constructive + specific; "I'm noticing" / "we" / invitation)
  author_reply_trap    0.9   ("Why not start sharing your evals?" — behavioural call inviting honest pushback)
  velocity_plan        0.75  (~1.5 levers — Monday borderline peak + reply-as-pre-warm but no +5 self-reply)
  penalties            1.0   (none; cosmetic only — *share* asterisks render literally on X)

Observed:
  Impressions:           [TO FILL — 2026-05-05 ~17:00 UTC post-mortem]
  Engagement rate:       [TO FILL]
  Reply-to-reply fired:  [TO FILL — watch for replies from named cluster operators]
  New followers:         [TO FILL — cluster-relevant subset]

Delta explanation: [TO FILL after observation]

Model update (if any): [TO FILL after ≥10 entries — first recalibration target]

---

### 2026-05-04 — Reply to @Vtrivedy10 (three-gap framing)

URL: TBD — capture from Oak's profile (reply to https://x.com/Vtrivedy10/status/[id] May 1 3:57 PM)
Mode: reply (use reply-mode rubric below)
Reply quality features:
  Target follower count: medium; cluster overlap: high (Deep Agents at LangChain, harness engineering)
  Author engagement pattern: conversational; replied to Oak earlier with "what does this look like??"
  Reply timing: ~3 days late (well outside <30min window); compensated by direct conversational continuity
  Reply substance: extends-their-argument-one-step; concedes openness benefits, names three gaps (demand signal / funding / runtime trust); coined "access ≠ market"
  Tone: constructive; builder register
  +75 invitation: yes — likely follow-up "what does X look like concretely?"
Verdict at publish: send. Calibration: watch reply-rate; warmest of the three reply-as-pre-warm targets.

Observed:
  [TO FILL]

---

### 2026-05-04 — Reply to @Obsrver_Prtcl (Tier-2 issuer verification)

URL: TBD
Mode: reply
Reply quality features:
  Target follower count: small/medium; cluster overlap: high (ERC-8004 trust scoring)
  Author engagement pattern: replied substantively to Oak's earlier methodology question
  Reply timing: ~16h post their reply on a 10-view post — velocity dead
  Reply substance: methodology question on Tier 2 issuer verification (Sybil-Tier-2 attack)
  Tone: constructive ("Nice. Curious how you verify the issuer for tier 2?") — mild filler ("Nice.") but on-thesis
  +75 invitation: strong — they have to either describe a mechanism or admit it's open
Verdict at publish: send (already sent). Edit retroactive: drop "Nice." for next time — reads slightly soft.

Observed:
  [TO FILL]

---

### 2026-05-04 — Reply to @TreebeardAI (recomputability-as-2008-shape)

URL: TBD
Mode: reply
Reply quality features:
  Target follower count: medium (verified); cluster overlap: high (rating agency for autonomous agents)
  Author engagement pattern: explicitly invited methodology feedback; follows Oak; verified
  Reply timing: ~3 days after their 2026-05-01 invitation — moderate latency, compensated by depth (Oak read the methodology page end-to-end before replying)
  Reply substance: names specific transparency-boundary failure (proprietary weights / transformation functions) and ties to the 2008 shape they themselves critiqued; intentional small typos ("cot-to-fake", "s&p") signal human authorship
  Tone: questioning ("To me that feels like the same thing underlying...") — generous, peer-register; not a takedown
  +75 invitation: very strong — verified counterpart who explicitly asked for feedback; high-probability substantive reply
Verdict at publish: send. Likely follow-up paths: (a) NDA closes gap, (b) canary catches drift, (c) they ship something.

Observed:
  [TO FILL]

---

## Reply-mode entries

For replies (different rubric — see SKILL.md reply mode), capture target fit, timing, substance, tone, +75 invitation, verdict, and observed reply within 24-48h. The four entries above for 2026-05-04 use this format.

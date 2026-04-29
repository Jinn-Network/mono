# X algorithm model — for compilation into a Claude skill

29 April 2026. A mechanistic, decision-ready model of how X distributes posts as of late April 2026. Companion to `2026-04-10-x-algorithm-playbook.md`. The playbook is narrative; this doc is the model — every claim has a confidence tier, every mechanism has a lever, every section ends in a heuristic a skill can apply.

Compile this into a skill that takes (a) a draft, (b) optional account context, and returns: a predicted-reach score, the binding constraint, and the highest-leverage edit.

**Confidence tiers:**
- **HARD** — from the Jan 2026 open-source release of `xai-org/x-algorithm`.
- **REPORTED** — multiple independent third-party measurements (Buffer 18M-post study, Sprout, etc.).
- **INFERRED** — best-fit hypothesis from observed behaviour and adjacent code; not directly measured.
- **ANECDOTAL** — single source or founder claim. Low weight.

When the skill cites a number, it should also cite the tier.

---

## 1. The scoring function (the spine of the model)

Every other section is a decomposition of one of these terms.

```
Predicted_distribution =
    Tweepcred(account)
  × Cluster_fit(post, viewer)
  × Premium_multiplier(account)
  × Format_multiplier(post)
  × Length_multiplier(post)
  × Initial_engagement_velocity(post, t<60min)
  × Tone_overlay(post)
  × Engagement_quality_score(post)   // weighted-sum of signals below
  − Penalty_terms(post, account)
  − Hard_kills(post)                 // single-event termination
```

This is the working model, not source code. It is good enough to grade drafts and predict relative outcomes between two candidates. Absolute reach predictions are out of scope.

**Heuristic for the skill.** For any draft, score each factor on a 0–1 scale. Multiply. Output the lowest factor as the binding constraint and recommend an edit that lifts only that factor.

---

## 2. Engagement signal weights (the +75 mechanism)

**HARD** — Jan 2026 source code. These are the weights Phoenix applies to engagement events when ranking a post for a given viewer.

| Signal | Weight (× Like) | Notes |
|---|---|---|
| Reply-to-reply (author replies back to a reply) | **+75** | The single dominant signal. |
| Repost | ~20 | Share-worthiness. |
| Reply | ~13.5 | Conversation start. |
| Profile click | ~12 | Curiosity about the author. |
| Link click | ~11 | Only counts in-platform; external links suppressed elsewhere. |
| Bookmark | ~10 | Hard to game. "I want to come back." |
| Like | 1 | Baseline. |

**Mechanism.** Phoenix is a transformer that scores `(post, viewer)` pairs. Engagement events update both the post's distribution and the viewer's interest cluster. The +75 reply-to-reply signal is asymmetric: it requires the author to engage, which makes it a coordinated act, not a passive metric.

**The author-reply trap (the most actionable insight in the entire model).**

The +75 fires when *you* reply to someone who replied to you. So engagement quality multiplies massively whenever you reply to your own thread's commenters. Two implications:

1. **Posting without intending to reply for an hour is leaving 75x on the table.** Treat every post as a thread you'll re-enter at +5min, +20min, +60min.
2. **Bait the reply that's worth replying to.** Posts that *invite* substantive replies (open question, contestable claim, specific gap) outperform posts that resolve cleanly.

**Heuristic.** If the post terminates the conversation, downgrade. If the post leaves a hook for the reader to extend, upgrade.

---

## 3. Penalties and hard kills

**HARD** weights. These are big numbers. A small number of events can terminate distribution.

| Signal | Weight |
|---|---|
| Tweet report (spam/abuse) | −369 |
| Block / mute / "show less" | −74 |
| Unfollow after viewing | (large negative, exact weight not in code) |

**Inferred kill thresholds.** A handful of reports on a small-account post can drop distribution to near zero. Mute/block events from inside your own follower base are far more damaging than from out-of-network — they signal cluster mismatch.

**Heuristic.** Any draft that even *might* trigger reports (medical claims, financial advice tone, harassment-adjacent framing, ambiguous legal language) is a hard reject. The cost of one accidental report is two weeks of degraded distribution.

---

## 4. Format multiplier

**REPORTED**. Phoenix penalises and rewards format types asymmetrically. Numbers are relative engagement-rate multipliers vs the median single text post.

| Format | Multiplier (engagement rate) | Notes |
|---|---|---|
| Text post (no media) | 1.0 | Baseline. Best engagement rate of any format. |
| Text + image | ~1.1–1.3 | Image stops scroll; engagement rate slightly higher. |
| Thread (3–5) | 1.4–1.6 (total) | More impressions in aggregate, lower per-tweet rate. |
| Thread (7–12) | ~1.5x singletons (Sprout 2026 data) | The sweet spot for bookmark-driven reach. |
| Native video <2 min | ~0.7 (rate), ~1.5–2.0 (raw reach) | Lower engagement *rate* but pushed harder for impressions. |
| Long-form post / Article | ~1.2–1.5 (dwell-weighted) | Premium-only. Rewarded by dwell time. |
| Poll | 0.6–0.8 | Low-signal engagement. |
| External-link post | 0.1–0.5 | Heavily suppressed (see §6). |

**Mechanism.** Phoenix has a cost model: video and articles take more compute to score, and X strategically pushes video for ad inventory reasons. Text remains highest *quality signal per impression* because it surfaces conversation, which feeds the +75 mechanism.

**Heuristic.** For a small account, default to text. Add image only when it carries information (diagram, screenshot of a specific moment). Threads when the take needs multi-step build. Video only when raw reach matters more than conversation depth.

---

## 5. Length multiplier

**REPORTED**. Two local maxima in the engagement curve.

| Length (chars) | Multiplier | Notes |
|---|---|---|
| 1–70 | ~0.8 | Too thin to provoke reply. |
| **71–100** | **~1.3** | High engagement rate. Sharp claims, hot takes. |
| 101–239 | ~1.0 | Baseline. |
| **240–259** | **~1.2** | Depth zone. Substantive without truncation. |
| 260+ (Premium long-form) | ~0.9–1.4 | Variance is huge. Dwell-driven. |

**Heuristic.** Drafts in the 101–239 dead zone should either be cut to 71–100 or extended to 240–259. The skill should flag any draft in 110–230 as suboptimal length.

---

## 6. External links

**HARD penalty, REPORTED magnitude.** External links in the main post reduce reach 50–90%. Since March 2025 the median engagement rate for non-Premium link posts is 0%.

**Mechanism.** Phoenix specifically downweights posts whose strongest signal is "user clicked off-platform". The penalty doesn't apply to:
- Replies (you can drop the link in a self-reply).
- Long-form Articles (Premium only; treated as on-platform content).
- Native media that *implies* a link (screenshots).

**Heuristic.** Hard rule for the skill: if `main_post.contains_external_link == True`, fail the lint and rewrite as a tease + link-in-self-reply pattern. No exceptions.

---

## 7. Premium multiplier

**REPORTED**. The single largest account-level lever.

| Effect | Multiplier |
|---|---|
| In-network reach (your followers) | 2–4x |
| Out-of-network reach (For You) | ~2x |
| Combined typical-post boost (Buffer 18M-post study) | ~10x |
| Reply ranking | Premium replies surface above non-Premium in reply lists |
| Reply impressions for non-Premium accounts | −30–40% |
| Long-form Articles | Premium-only |

**Implication.** No serious distribution analysis applies to a non-Premium account. Premium is a precondition, not a tactic. If the user is non-Premium, the skill should refuse to predict reach and instead recommend Premium first.

---

## 8. Tweepcred (account reputation)

**INFERRED**. Tweepcred is a per-account reputation score that gates how much initial test-audience exposure a post gets.

**Mechanism.**
- Built up by: consistent posting, high-quality follower engagement, low rate of mute/block events on your posts, follower growth from "smart followers" (Premium accounts, verified accounts, accounts with cluster authority).
- Damaged by: blocks/mutes from your followers, rapid follow/unfollow cycles, near-duplicate posting, low engagement rate.
- New accounts: low Tweepcred. Initial test audience is small (~50–100 impressions). Growth requires 2–4 weeks of consistent activity before Tweepcred plateau lifts.

**Heuristic.** The skill cannot directly measure Tweepcred but can warn:
- "Your last 5 posts averaged <baseline impressions" → Tweepcred drag suspected.
- "You posted >5 times in the last 60 minutes" → near-duplicate / cluster confusion risk.
- "You posted nothing in the last 36 hours" → cadence gap, Tweepcred decay.

---

## 9. Cluster fit

**INFERRED**. Phoenix routes out-of-network distribution by interest cluster. Each post is embedded; each viewer has a cluster fingerprint. The match score gates out-of-network reach.

**Mechanism.**
- Your cluster is determined by *who follows you* (more weight) and *who you engage with* (less weight).
- Crypto Twitter and AI Twitter are distinct clusters with ~20% overlap.
- A post that uses lexicon from one cluster but is shown to viewers in the other has low cluster fit and is suppressed.
- Bridging clusters from one account is harder than running two accounts. The model penalises mixed signal.

**Heuristic for @oaksprout (Oak's personal handle).** Crypto+AI-infrastructure cluster. Posts that use only crypto lexicon (token, alpha, tickers) without an AI/agent angle will land flat. Posts that use only AI lexicon (eval, RLHF, fine-tune) without a value-distribution angle will land flat. The cluster fit lever is the intersection vocabulary: *agent, autonomy, distribution, sovereignty, training, outcomes, decentralised execution*. The skill should flag drafts that drift to one cluster's pure lexicon.

---

## 10. Initial engagement velocity (the 30–60 minute window)

**HARD mechanism, REPORTED magnitudes.**

**The staged rollout.**
1. Post lands in 5–15% of followers' feeds + a small algorithmically-selected out-of-network slice.
2. Phoenix tracks engagement rate over the next ~30–60 minutes against this test audience.
3. If engagement-rate-vs-test-audience is above a threshold, distribution expands. Otherwise it stalls.
4. Re-evaluation can happen at 1h, 6h, 24h. A late surge can re-trigger expansion ("revival window").

**Velocity matters more than volume.** 10 replies in 15 minutes dramatically outperforms 10 replies in 24 hours.

**Levers.**
- Post when target audience is online (Tue–Thu 09:00–14:00 target-timezone for crypto/AI; Saturday is a dead zone).
- Pre-warm: signal to a handful of allies that a post is going up. Bilateral, not pod-style.
- Reply to your own post in the first 5 minutes — provokes the author-reply mechanism early.
- Have a follow-up tweet ready to quote-extend within the first 30 minutes if signal is good.

**Heuristic.** Any draft posted outside the peak window without a velocity-pre-warm plan is sub-optimal. The skill should ask: "What's your 30-minute engagement plan for this post?"

---

## 11. Tone overlay (the Grok layer)

**ANECDOTAL → INFERRED**. Multiple sources reference a Grok-driven sentiment overlay introduced 2025. Mechanism not in the open-source release, but observed behaviour is consistent.

**Inferred mechanism.**
- Phoenix's score is multiplied by a tone factor in [~0.5, ~1.2].
- Positive/constructive/specific framing: ~1.1–1.2x.
- Neutral/informational: ~1.0x.
- Combative/rage-bait/contemptuous: ~0.5–0.8x.
- Outright abusive: hard kill (joins the report-weight penalty).

**Implication for Oak.** "Stress-test by default" reads as combative if the tone reads as contempt rather than analysis. Threads that frame counter-positions as *interesting wrong views worth understanding* outperform threads that frame them as *failures to take seriously*. Same content, different tone factor.

**Heuristic.** The skill should flag drafts that:
- Use second-person accusations ("you don't get it", "people who think X are wrong").
- Lead with a dismissal rather than a claim.
- Use scare quotes, sarcasm, or rhetorical questions stacked >1 per post.

---

## 12. Engagement quality score (smart followers vs casual)

**ANECDOTAL**, but the direction is consistent across founder reports.

Not all engagement is weighted equally. An engagement event from a Premium / verified / high-Tweepcred account counts more than the same event from a low-quality account. Reported ratios up to 100x for "smart follower" engagement, though the exact multiplier is opaque.

**Mechanism.** Phoenix uses the *engager's* embedding to update the post's cluster fingerprint. A thoughtful reply from a respected operator in your cluster moves the post toward the cluster's centre of mass and unlocks more viewers in that cluster. A like from a random new account does ~nothing.

**Heuristic.** Quality of engagers matters more than quantity. A reply game that targets 20–30 high-cluster accounts will produce more cluster lift than 200 replies to random posts. The skill should track *who* engages, not just *how many*.

---

## 13. Cold-start dynamics

**REPORTED + INFERRED.**

For accounts under ~3,000–5,000 followers, the dominant constraint is Tweepcred + cluster establishment. Implications:

- **Communities are the cold-start unlock** (since Feb 2026 they're publicly visible). Posting into a Community routes around the Tweepcred bottleneck — community members see the post regardless of follow status.
- **Replies > original posts** for early growth (70/30 rule). The +75 mechanism + the borrowed audience effect compounds faster than pushing originals to a small Tweepcred.
- **Smart-follower acquisition is the leading indicator**, not raw follower count. One engaged Premium operator follower is worth ~100 casual followers in cluster lift.
- **Warm-up period is real.** New accounts hit a Tweepcred plateau at ~2–4 weeks of consistent activity. Below that, even good posts will under-distribute.

**Heuristic.** For accounts <5K, the skill should weight reply-game outputs higher than original-post outputs and recommend Community posting over feed posting where appropriate.

---

## 14. Penalty terms (continuous)

These don't kill distribution but stack against it.

| Pattern | Penalty estimate | Confidence |
|---|---|---|
| External link in main post | 0.1–0.5x reach | HARD-mechanism, REPORTED magnitude |
| Hashtag stuffing (>2) | ~0.8x | REPORTED |
| Cross-platform watermark (TikTok logo etc.) | ~0.7x | REPORTED |
| Near-duplicate to recent own post | ~0.5–0.7x | INFERRED |
| Link shortener (bit.ly etc.) | ~0.7x | REPORTED |
| Posting velocity spike (>5 posts/hour) | ~0.7x | INFERRED |
| Thread without internal cohesion (each tweet stands alone) | ~0.8x | INFERRED |
| Use of trending hashtag without genuine relevance | ~0.5x | INFERRED |

---

## 15. The pre-publish checklist (skill output template)

The skill should evaluate every draft against this checklist and return a structured verdict. Each item maps to a section above.

```
[1] Hard kills:
    - External link in main post? (§6)
    - Report-bait language? (§3)
    - Spam-shaped repetition? (§3)
    Verdict: PASS / FAIL → if FAIL, refuse to post.

[2] Premium account check (§7).
    Verdict: PASS / WARN.

[3] Format & length (§4, §5):
    - Format multiplier estimate.
    - Length zone (sharp / dead / depth / long-form).

[4] Cluster fit (§9):
    - Detected cluster vocabulary.
    - Cluster bridging present? (good if intentional, bad if drift)

[5] Author-reply trap (§2):
    - Does the post invite a substantive reply?
    - Open question, contestable claim, or specific gap?

[6] Tone overlay (§11):
    - Detected tone: constructive / neutral / combative.
    - Multiplier estimate.

[7] Velocity plan (§10):
    - Posting time vs cluster peak window?
    - Self-reply ready?
    - Pre-warm allies notified?

[8] Penalties (§14):
    - Stacked penalties detected.

OUTPUT:
    - Predicted relative reach score (0–1 vs your baseline).
    - Binding constraint (lowest factor).
    - One-line edit recommendation that lifts the binding constraint.
    - Optional: rewritten version applying the edit.
```

---

## 16. The reply-game checklist (companion skill output)

Different model. For a candidate reply, evaluate:

```
[1] Target account fit:
    - Follower count: 2–10x yours? (lever range)
    - Cluster overlap with yours? (lift potential)
    - Is the original-tweet author known to engage with replies? (+75 trigger probability)

[2] Reply timing:
    - Original tweet age: <30 min? (top-replies surfacing)
    - Original tweet's velocity: rising? (riding distribution)

[3] Reply substance:
    - Adds specific data / personal experience / counter / extension?
    - Refuses "Great point!" / agreement-only / promotional pivot?

[4] Reply tone (§11):
    - Constructive without being sycophantic?
    - Disagrees with respect, not contempt?

[5] +75 invitation:
    - Does the reply invite the original author to reply back?
    - Open hook, not closed answer.

OUTPUT:
    - Reply-quality score.
    - Likelihood of +75 fire.
    - Recommended edit.
```

---

## 17. Open questions and model weak points

A skill compiled from this model should be honest about where it's guessing.

1. **Exact Grok tone-overlay multipliers** — directionally known, magnitudes inferred. Calibrate by tracking your own posts' reach vs tone over 30 days.
2. **"Smart follower" weighting** — anecdotally up to 100x; exact value unknown. Track which followers' engagements correlate with subsequent reach lift.
3. **Cluster cold-start crossing** — the cost of bridging crypto + AI clusters from one account is qualitative; quantify by running A/B-style separate-cluster vs bridged-cluster posts and measuring reach decay.
4. **Revival window mechanics** — Phoenix can re-promote a post if it gets late traction, but the threshold and the time horizon aren't documented. Worth tracking.
5. **Long-form Article weighting** — high variance. Dwell time matters; read-through rate matters; how Phoenix balances them is opaque.

The skill should output its confidence per prediction and flag predictions where one of these unknowns is load-bearing.

---

## 18. Calibration loop (how to improve the model)

Embed an `engagement-debrief` ritual into the skill: every Friday, take the past week's posts, compare model-predicted relative reach against observed impressions, and update one parameter. The model is wrong; the discipline is to make it less wrong each week. Two specific calibration tasks:

1. **Reach-per-cluster signal**: tag each post by detected cluster. Plot reach distribution per cluster. If one cluster is systematically overpredicted, downweight its multiplier for your account.
2. **Author-reply-trap conversion**: track what fraction of your posts trigger ≥1 author-reply-back event. If <20%, the binding constraint is post structure, not anything else in the model.

---

## 19. Versioning

This is the model as of **29 April 2026**. The Phoenix architecture has been stable since October 2025; engagement weights have been stable since the January 2026 source release. The Grok tone overlay introduced ~2025 is the most likely thing to shift quietly.

Re-validate this model if any of:
- A new public source-code release.
- A major founder-reported reach pattern shift (Buffer / Sprout / similar).
- A noticeable change in your own posts' reach-per-tone correlation.

Tag the skill version against this date. When the model updates, the skill updates.

---

## How to compile this into the skill

Skill name suggestion: `x-algorithm-grader`.

Trigger conditions:
- "score this draft", "will this land", "predict reach", "grade this tweet", "optimise this for X", "critique this draft for X".
- Any draft pasted in a Cowork session with intent to post on X.

Skill behaviour:
1. Read this doc as reference.
2. Run §15 checklist on the draft.
3. Output predicted relative reach + binding constraint + edit recommendation.
4. If user accepts, run §16 reply-game checklist on planned engagement.
5. Optionally schedule the post via Typefully and queue an `engagement-debrief` task for 24h later.

Companion skills (downstream of this model):
- `x-reply-finder` — the open-conversations agent (already prompted; not yet a skill).
- `x-engagement-debrief` — the Friday calibration loop.
- `x-pre-publish-lint` — the hard-kills + penalties subset of §15, runnable as a fast pre-flight.

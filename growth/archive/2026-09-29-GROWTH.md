# GROWTH

**What this doc is / is not.** This is the canonical statement of how Jinn grows: the strategy (what we distribute, to whom, with what call to action) and the engine (how growth attempts are measured and evolved). It is not a campaign log, an asset library, or a tactical playbook — those live in [`growth/.local/`](growth/.local/) (operator-private) and accrete as the engine runs. It is also not the thesis (see [`THESIS.md`](THESIS.md)), the voice canon (see [`BRAND.md`](BRAND.md)), or the product positioning (see the [GTM plan](docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md) §4); growth derives from all three and does not restate them.

**Revision note (2026-08-14).** This rewrite replaces the strategy layer with a product-led one, ratifying decision 1 of [DR-2026-08-10](log/decisions/2026-08-10-product-led-gtm-and-first-market.md). The harness-first strategy layer it retires (§1–§3 as they stood) is archived at [`growth/archive/2026-08-14-GROWTH.md`](growth/archive/2026-08-14-GROWTH.md), exactly as the pre-2026-07-07 strategy was. The engine (§4–§8) is retained: it survived the last strategy retirement and it survives this one. Do not revive archived structure without running it through the loop as a single-knob test.

**Revision note (2026-07-07).** The rewrite that reintroduced a strategy layer after the 2026-06-02 deprecation retired the *prior* strategy (bet, target cluster, GTM phases, channel canon — archived at [`growth/archive/`](growth/archive/), derivation in [Discussion #770](https://github.com/Jinn-Network/mono/discussions/770)).

## 1. The strategy: product-led

Jinn grows through a product people buy, not by recruiting operators or selling the protocol. **The distribution surface is the benchmark product, and a published, verifiable report is the distribution object.** The network (contribution, verification, earning, steering) rides along with product use; Jinn is the infrastructure attribution, not the headline.

Two motions, both product-led:

- **Trigger-based outbound** to teams facing a live benchmark claim or decision.
- **Artifact-led distribution** through published reports that carry their own evidence and survive outside the tool that made them.

Positioning, claims, and copy derive from the [GTM plan](docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md) §4 and [`BRAND.md`](BRAND.md). Category: *verifiable benchmarking*. Primary pitch: **Make AI performance claims people can inspect.**

## 2. Audience

Defined by the presence of a high-value evaluation trigger, not by domain alone.

- **Core profile:** a technically capable team that builds, buys, or deploys an AI system, has a real comparison or performance question, faces external or internal scrutiny over the answer, and needs the result by a meaningful deadline. Users and economic buyers are enumerated in the [GTM plan](docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md) §5.
- **Default beachhead: coding-agent, harness, skill, plugin, tool, and loadout builders.** It is what the shipped product runs today and where distribution already reaches. This is a default, not a fixed decision — displaced only when another domain outperforms it on the GTM plan's selection rubric across completed, committed campaigns, and any change is recorded by DR ([DR-2026-08-10](log/decisions/2026-08-10-product-led-gtm-and-first-market.md) decision 2).
- **Not a growth target: OLAS / crypto-operator outreach.** Operators arrive downstream of product adoption, not through growth spend.

Single-audience evidence does not generalise (§7); log beachhead and other-domain attempts separately.

## 3. The funnel and the current call to action

The funnel today, in order:

1. **See the claim** — a published report, or a post or thread carrying one.
2. **Bring a claim** — the single call to action on every outward surface. The ask is not "are you interested in evals?" but *what AI performance claim or decision do you need other people to trust next?*
3. **Run a benchmark** — self-serve, or operated together with the team (one product, four offers; [GTM plan](docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md) §7).
4. **Publish the report** — the evidence package that outlives the originating tool.
5. **Evidence** — published reports accumulate as the product's own proof, and the loop that produced them as Jinn's.

The claim-first CTA is deliberate: the value on offer is a more credible decision, so the honest ask is for the decision the team already has to defend, not for a tool switch.

## 4. The engine: the model

Growth runs as a self-improving system on the **loadout-instrument engine**. A mutable **loadout** (eight knobs, §5) is iterated by a single skill that forces a written prediction *before* each attempt and a structured verdict *after*. The verdict is judged by position and movement on the **Mayfield participation curve** (Mayfield 2006, *The Power Law of Participation*):

| # | Rung | Jinn example | Metric |
|---|---|---|---|
| 1 | Read | Saw a post, opened the landing page | Views, opens |
| 2 | Favorite | Liked, bookmarked | Likes, bookmarks |
| 3 | Tag | Mentioned, quote-tweeted with context | Quote tweets, mentions |
| 4 | Comment | Replied substantively | Replies weighted by length |
| 5 | Subscribe | Followed, watched repo, **joined the Telegram** | Follows, watchers, joins |
| 6 | Share | Reposted to their audience | RTs, reposts |
| 7 | Network | Connected others to Jinn | Inbound "X sent me", intros |
| 8 | Write | Wrote about Jinn on their own surface | External posts |
| 9 | Refactor | Installed and ran Jinn | Installs, first sessions |
| 10 | Collaborate | Turned on contributing; filed Issue / PR | Consents, first publishes, contributors |
| 11 | Moderate / Lead | Maintained a piece, ran a SolverNet | Active operators, launchers |

Different loadout knobs move different rungs. Channel moves Read volume; pitch / framing / proof move Read → Comment; ask / on-ramp friction move Subscribe → Refactor. The loadout version is the growth-side analog of the SWE side's content-addressed loadout fingerprint.

## 5. The two subsystems

**The instrument** judges how good the loadout is. Knobs: **Sensitivity** (signal/noise — cranked by samples, controlled variation, statistical discipline), **Scope** (whose runs feed it — local ↔ pooled), **Resolution** (loadout-level → per-knob → per-step credit), **Baseline** (past self ↔ null ↔ peers).

**The search rule** decides what to try next. Knobs: **Step size** (one-line edit ↔ whole rewrite), **Direction** (random ↔ trace-guided ↔ imitative), **Parallelism** (one lineage ↔ many variants), **Commit policy** (greedy ↔ validated).

Three couplings: Resolution needs Sensitivity (else you attribute noise). Scope needs loadout identity (else pooling is incoherent). Parallelism amplifies the instrument (else variants can't be ranked).

The instrument is the binding constraint, not the search rule. **Resolution before reach. Baseline before broadcast. Pool before pivot.**

## 6. The three artifacts

- **[`growth/.local/growth-loadout.md`](growth/.local/growth-loadout.md)** — current loadout: eight knobs, version tag, changelog. Operator-private.
- **[`growth/.local/growth-experiment-log.md`](growth/.local/growth-experiment-log.md)** — append-only log of attempts: predictions, actuals by rung, verdicts. Operator-private.
- **[`.claude/skills/growth-experiment/`](.claude/skills/growth-experiment/)** — the skill that drives the cycle (PLAN → LOG → EVOLVE). Committed.

The first two are created by the skill on first PLAN call if absent. The skill is the only sanctioned writer of new log entries.

## 7. Non-negotiables

- **Every outward surface derives from the positioning in §1** and respects the GTM plan's what-the-product-is-not list. A surface that contradicts it is a bug.
- **No written prediction → the attempt logs as inconclusive.** Hindsight verdicts are how loadouts get reverted on noise.
- **One knob varies per attempt** unless explicitly overridden in the log entry.
- **At least two attempts on the same rung-knob pair before EVOLVE acts.** N=1 is a data point, not a verdict.
- **Single-audience evidence does not generalize across cluster.** A signal from one slice is signal *about that slice* — beachhead evidence is not expansion evidence.
- **Verdict is funnel position + rates between rungs, not a single number.** Different knobs move different rungs; conflating them is how attribution rots.

## 8. What is deliberately not in scope yet

- Automation that pulls metrics from X / Telegram / GitHub.
- Cross-deployer pooling (Scope knob's network setting).
- Dashboards, databases, schemas-as-code.
- Campaigns outside the default beachhead before the commitment gate opens them ([DR-2026-08-10](log/decisions/2026-08-10-product-led-gtm-and-first-market.md) decision 3).
- Reintroducing retired clusters, framings, channels, or rituals from the archive without running them through the loop as a single-knob test.

---

Changes to this document require a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions) and CODEOWNERS approval, per [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md). *(The 2026-07-07 rewrite was owner-authorised directly, bypassing that pipeline at Oak's instruction. The 2026-08-14 product-led rewrite was likewise owner-authorised, at Ritsu's instruction: the Discussion step was waived explicitly, not overlooked, and the repository's canonical-doc check stayed red on this PR to record that no Discussion was linked.)*

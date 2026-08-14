# GROWTH

**What this doc is / is not.** This is the canonical statement of how Jinn grows: the strategy (what we distribute, to whom, with what call to action) and the engine (how growth attempts are measured and evolved). It is not a campaign log, an asset library, or a tactical playbook — those live in [`growth/.local/`](growth/.local/) (operator-private) and accrete as the engine runs. It is also not the thesis (see [`THESIS.md`](THESIS.md)), the voice canon (see [`BRAND.md`](BRAND.md)), or the positioning spine (see [`docs/positioning/2026-07-07-jinn-positioning-spine.md`](docs/positioning/2026-07-07-jinn-positioning-spine.md)); growth derives from all three and does not restate them.

**Revision note (2026-07-07).** This rewrite reintroduces a strategy layer. The 2026-06-02 deprecation retired the *prior* strategy (bet, target cluster, GTM phases, channel canon — archived at [`growth/archive/`](growth/archive/), derivation in [Discussion #770](https://github.com/Jinn-Network/mono/discussions/770)); the engine it left behind is retained unchanged in §4–§8. The new strategy layer follows the harness-first pivot ([`spec/2026-07-02-jinn-harness-network.md`](spec/2026-07-02-jinn-harness-network.md)) and the positioning spine. Do not revive archived structure without running it through the loop as a single-knob test.

## 1. The strategy: harness-first

Jinn ships a harness, not a marketplace. **The product is Jinn — the agent a person runs — and using it is the funnel.** The network (contribution, verification, earning, steering) rides along with use. There is no marketplace-led or operator-recruitment-led motion; distribution is product adoption.

All positioning, claims, and copy derive from the [positioning spine](docs/positioning/2026-07-07-jinn-positioning-spine.md). Its one-line core: *Jinn is the first agent that gets better as more people use it* — asserted as a bet, not a result, until the v0 gate ([#1307](https://github.com/Jinn-Network/mono/issues/1307)) produces evidence.

## 2. Audience

- **Beachhead: Hermes / OpenClaw users.** Already run a memory-built generalised personal agent; already crypto-comfortable. The premise (agents need accumulated learning; chains are normal) is pre-accepted — the only fight is proof. Win here first.
- **Expansion: broader AI power users** (Claude Code, Cursor, heavy assistant workflows). Later; requires premise-selling the beachhead does not.
- **Not a growth target: OLAS / crypto-operator outreach.** Operators arrive downstream of product adoption, not through growth spend.

Single-audience evidence does not generalise (§7); log beachhead and expansion attempts separately.

## 3. The funnel and the current call to action

The funnel today, in order:

1. **See the claim** — landing page at jinn.network, posts, threads. All derived from the spine.
2. **Join the community** — the Telegram group ([t.me/jinnNetwork](https://t.me/jinnNetwork)) is the single call to action on every outward surface for now. One CTA, everywhere, until the loop says otherwise.
3. **Run Jinn** — install and use the agent (reader mode needs no account, wallet, or consent).
4. **Turn on contributing** — consent, first publish, ledger.
5. **Evidence** — verified contributions accumulate toward the v0 gate.

The Telegram-first CTA is deliberate: before the capability bet has public evidence, the honest ask is "watch us test it", not "switch your daily driver". When the v0 gate produces a result, the primary CTA graduates from *join* to *run*.

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

- **Every outward surface derives from the positioning spine** and respects its messaging do-not list. A surface that contradicts the spine is a bug.
- **No written prediction → the attempt logs as inconclusive.** Hindsight verdicts are how loadouts get reverted on noise.
- **One knob varies per attempt** unless explicitly overridden in the log entry.
- **At least two attempts on the same rung-knob pair before EVOLVE acts.** N=1 is a data point, not a verdict.
- **Single-audience evidence does not generalize across cluster.** A signal from one slice is signal *about that slice* — beachhead evidence is not expansion evidence.
- **Verdict is funnel position + rates between rungs, not a single number.** Different knobs move different rungs; conflating them is how attribution rots.

## 8. What is deliberately not in scope yet

- Automation that pulls metrics from X / Telegram / GitHub.
- Cross-deployer pooling (Scope knob's network setting).
- Dashboards, databases, schemas-as-code.
- Expansion-audience campaigns (premise-selling to non-Hermes power users) before the beachhead loop produces verdicts.
- Reintroducing retired clusters, framings, channels, or rituals from the archive without running them through the loop as a single-knob test.

---

Changes to this document require a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions) and CODEOWNERS approval, per [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md). *(The 2026-07-07 rewrite was owner-authorised directly, bypassing that pipeline at Oak's instruction.)*

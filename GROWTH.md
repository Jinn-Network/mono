# GROWTH

**What this doc is / is not.** This is the canonical statement of how Jinn grows: the engine the loop runs on, the three artifacts that hold its state, and the discipline that keeps each attempt informative. It is not a campaign log, an asset library, or a tactical playbook — those live in [`growth/.local/`](growth/.local/) (operator-private) and accrete as the engine runs. It is also not the thesis (see [`THESIS.md`](THESIS.md)) or the voice canon (see [`BRAND.md`](BRAND.md)); growth derives from both and does not restate them.

The prior approach — bet, target cluster, GTM phases, daily four-function loop, sprint discipline, channel canon — was deprecated 2026-06-02. It is preserved at [`growth/archive/`](growth/archive/) as historical reference; do not revive its structure wholesale. The model behind the rewrite is derived in full in [Discussion #770](https://github.com/Jinn-Network/mono/discussions/770).

## 1. The model

Growth runs as a self-improving system on the **loadout-instrument engine**. A mutable **loadout** (eight knobs, §2) is iterated by a single skill that forces a written prediction *before* each attempt and a structured verdict *after*. The verdict is judged by position and movement on the **Mayfield participation curve** (Mayfield 2006, *The Power Law of Participation*):

| # | Rung | Jinn example | Metric |
|---|---|---|---|
| 1 | Read | Saw a post, opened the essay | Views, opens |
| 2 | Favorite | Liked, bookmarked | Likes, bookmarks |
| 3 | Tag | Mentioned, quote-tweeted with context | Quote tweets, mentions |
| 4 | Comment | Replied substantively | Replies weighted by length |
| 5 | Subscribe | Followed, watched repo | Follows, watchers |
| 6 | Share | Reposted to their audience | RTs, reposts |
| 7 | Network | Connected others to Jinn | Inbound "X sent me", intros |
| 8 | Write | Wrote about Jinn on their own surface | External posts |
| 9 | Refactor | Forked, ran the daemon | Forks, `jinn run` installs |
| 10 | Collaborate | Filed Issue / PR, ran an operator | Operator onboards, contributors |
| 11 | Moderate / Lead | Maintained a piece, ran a SolverNet | Active operators, launchers |

Different loadout knobs move different rungs. Channel moves Read volume; pitch / framing / proof move Read → Comment; ask / on-ramp friction move Subscribe → Refactor. The loadout version is the growth-side analog of the SWE side's content-addressed loadout fingerprint.

## 2. The two subsystems

**The instrument** judges how good the loadout is. Knobs: **Sensitivity** (signal/noise — cranked by samples, controlled variation, statistical discipline), **Scope** (whose runs feed it — local ↔ pooled), **Resolution** (loadout-level → per-knob → per-step credit), **Baseline** (past self ↔ null ↔ peers).

**The search rule** decides what to try next. Knobs: **Step size** (one-line edit ↔ whole rewrite), **Direction** (random ↔ trace-guided ↔ imitative), **Parallelism** (one lineage ↔ many variants), **Commit policy** (greedy ↔ validated).

Three couplings: Resolution needs Sensitivity (else you attribute noise). Scope needs loadout identity (else pooling is incoherent). Parallelism amplifies the instrument (else variants can't be ranked).

The instrument is the binding constraint, not the search rule. **Resolution before reach. Baseline before broadcast. Pool before pivot.**

## 3. The three artifacts

- **[`growth/.local/growth-loadout.md`](growth/.local/growth-loadout.md)** — current loadout: eight knobs, version tag, changelog. Operator-private.
- **[`growth/.local/growth-experiment-log.md`](growth/.local/growth-experiment-log.md)** — append-only log of attempts: predictions, actuals by rung, verdicts. Operator-private.
- **[`.claude/skills/growth-experiment/`](.claude/skills/growth-experiment/)** — the skill that drives the cycle (PLAN → LOG → EVOLVE). Committed.

The first two are created by the skill on first PLAN call if absent. The skill is the only sanctioned writer of new log entries.

## 4. Non-negotiables

- **No written prediction → the attempt logs as inconclusive.** Hindsight verdicts are how loadouts get reverted on noise.
- **One knob varies per attempt** unless explicitly overridden in the log entry.
- **At least two attempts on the same rung-knob pair before EVOLVE acts.** N=1 is a data point, not a verdict.
- **Single-audience evidence does not generalize across cluster.** A signal from one slice is signal *about that slice*.
- **Verdict is funnel position + rates between rungs, not a single number.** Different knobs move different rungs; conflating them is how attribution rots.

## 5. The cycle

PLAN → ship → LOG → EVOLVE. Mode names, step ordering, and the enforcement contract are owned by the [`growth-experiment`](.claude/skills/growth-experiment/) skill. The discipline is hill-climbing on the loadout with prediction as the forcing function — higher-leverage moves (controlled variation, pooled deployers, broader parallelism) become safe only once the simple loop is producing useful verdicts. Build complexity back as the cycle demands it.

## 6. What is deliberately not in scope yet

- Automation that pulls metrics from X / Paragraph / GitHub.
- Cross-deployer pooling (Scope knob's network setting).
- Dashboards, databases, schemas-as-code.
- Reintroducing retired clusters, framings, channels, or rituals from the archive without running them through the loop as a single-knob test.

---

Changes to this document require a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions) and CODEOWNERS approval, per [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).

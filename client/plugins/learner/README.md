# claude-code-learner — generic learning agent plugin

A drop-in plugin for any agent harness that supports skills + subagent dispatch + hooks. Runs a goal through a seven-phase learning loop (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation) and self-improves between runs by mutating its own state directory.

## What it provides

- **1 orchestrator skill** — `skills/learn/SKILL.md`. Drives the seven-phase pipeline end-to-end inside one harness session.
- **7 sibling subagent prompts** — `skills/learn/<role>-prompt.md` for `explorer`, `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator`. Each is the prompt body the orchestrator passes to a fresh-context subagent dispatch.
- **1 hook** — `hooks/session-start` initializes `implStateDir` as a git repo and sets author identity.

## Installing

The plugin is consumed by harnesses that load skills from a plugin directory.

**Claude Code (local development — recommended for first install):**

```bash
# Point a Claude Code session at the plugin directory:
claude --plugin-dir /path/to/claude-code-learner [other args]
```

For a permanent install via the Claude Code marketplace, use `claude plugin install <plugin>@<marketplace>` once a marketplace listing is published. Until then, `--plugin-dir` is the supported path.

**Codex / OpenCode / other harnesses:** consult your harness's documentation for how to point it at a local plugin directory. The plugin layout (`.claude-plugin/plugin.json` + `skills/` + `hooks/` + `hooks/hooks.json`) is Claude-Code-shaped; harnesses with a different convention may need an adapter.

## What the harness must provide

These are the runtime primitives the plugin assumes the harness exposes (Claude Code names; substitute equivalents on other harnesses):

- `Skill` — load a named skill into the current session.
- `Task` (general-purpose) — spawn a fresh-context subagent with an inline prompt body.
- `Bash` — for git commands and other shell calls.
- `Read`, `Write`, `Edit`, `Glob`, `Grep` — filesystem.
- A wait primitive — block until duration / deadline / condition (Claude Code: `Monitor`).

The harness adapter is responsible for projecting the generic subagent lifecycle onto its own tool surface: dispatch a fresh-context role worker, wait for required artifacts, and release completed workers. Subagent inputs should use absolute paths so workers do not depend on inheriting the coordinator's current working directory.

If the harness lacks `Skill`, generic `Task`-style subagent dispatch, `Bash`, or filesystem read/write/edit, the plugin will not run. The wait primitive gates time-anchored plans only — the plugin can run for `early-return` postures without it.

## Inputs the harness adapter passes

The orchestrator skill expects these as session inputs (typically via the harness adapter's initial prompt or environment):

- `goal` — `{ id, description, kind?, deadline?, spec? }`. Free-form payload describing what to achieve.
- `workingDir` — ephemeral path for this run's artifacts.
- `implStateDir` — the agent's persistent self-state (git-backed).
- `msUntilDeadline` — function returning remaining time.
- An abort signal that fires at the goal's deadline.

The plugin does not interpret `goal.kind` semantically. Domain-specific behavior (e.g. how to forecast a prediction market, how to rebalance a portfolio) belongs in domain-specific plugins loaded alongside this one, OR in the harness adapter / harvester layer.

## Modes

`JINN_HARNESS_MODE` selects one of three modes. It decides where the self-improving phases write — see the "Write target" section of `skills/learn/SKILL.md`.

| Mode | Improve / Memory consolidation | Write target | `implStateDir` |
| --- | --- | --- | --- |
| `train` | run | `implStateDir` | read-write |
| `frozen` | skipped | *nothing* | read-only, fenced |
| `candidate` | run | `$JINN_LEARNER_CANDIDATE_DIR` | read-only, fenced |

**Candidate mode** is the plugin acting as a *proposer* rather than as its own adopter. The run executes the active policy, then writes everything it would have changed into a provisioned copy, and the harness seals that copy as a candidate manifest — a proposal that a separate evaluation decides on. The active directory is verified byte-identical afterwards; a run that touched it is discarded. Authority: `docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md` §10.

### Deprecation: inline self-mutation

`train` mode's in-place mutation of `implStateDir` is a **compatibility mode**. It gives fast local adaptation with no identity boundary: the policy that produced a result and the policy that replaced it are the same directory, so nothing downstream can tell them apart, and there is no proposal for anyone to evaluate or roll back to.

Product design §10 retires it once the first optimization campaign completes end-to-end. Campaign evaluation never depends on it. Operators who want the same cadence get it back as provisional self-adoption of their own candidates with rollback — same speed, with an identity boundary. Until then:

- `JINN_LEARNER_INLINE_MUTATION=0` (also `false` / `no`) makes the learner run **train-mode tasks under frozen semantics**: Orient through Debrief run as usual, Improve and Memory consolidation are skipped, and nothing is written to `implStateDir`. The harness logs one line per affected run.
- **Scope, stated plainly:** this suppresses the instruction, not the capability. The daemon-wide freeze fence still branches on the daemon's mode — which is `train` — so a plugin that ignored the steer and wrote anyway would not be caught. The flag is a deprecation off-ramp. Operators who need the write actually *prevented* run `frozen` or `candidate` mode, where the fence enforces it.
- The flag does not affect `frozen` or `candidate` mode, which never mutate the active directory in the first place.
- No new behaviour should be built on `train`-mode in-place writes.

## Optional environment

- `LEARNER_PHASE_RANGE=pre-execute|post-execute|full` — limits which phases run. Used by harnesses that wrap a domain-specialist Execute path between meta-pre and meta-post passes.
- `JINN_HARNESS_MODE=train|frozen|candidate` — see "Modes" above. Set by the harness adapter; defaults to `train`.
- `JINN_LEARNER_CANDIDATE_DIR` — candidate mode's write target, set by the harness. The session-start hook git-initializes it.
- `JINN_LEARNER_INLINE_MUTATION=0` — opt out of the deprecated inline self-mutation described above (train mode then runs under frozen semantics).
- `JINN_LEARNER_DEFAULT_ROUTING=1` — daemon-side compatibility flag restoring the retired "claim every SolverType" routing. Deprecated; configure `harness.routing.solverTypes` instead.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.

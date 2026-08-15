---
name: create-plugin
description: Use when a person wants to build a Jinn SolverPlugin — e.g. "create a plugin", "build a Jinn plugin", "start a solver plugin", "make a skill plugin", "add an MCP tool plugin", "/create-plugin". Human-invoked conversational on-ramp that drives the shipped `jinn create plugin` CLI + `solver-plugins` / `solver-nets` verbs to scaffold → fill → validate → load-verify → (gated) publish/join a plug-in.
---

# create-plugin

You help a person build a Jinn **SolverPlugin** end-to-end. This skill is the
conversational front door to the shipped CLI — it **writes no new substrate**.
It drives `jinn create plugin`, the `solver-plugins` verbs, and (optionally) a
SolverNet config edit, and verifies the result loads. Model the flow on
`.claude/skills/file-issue/`: brief interview, do the work, gate the
irreversible / on-chain / fund-moving steps behind explicit confirmation.

A SolverPlugin is **skills + MCP tools** that help a harness attempt a
SolverType. Two exclusive shapes:
- **solver-type-plugin** — ships markdown *skills* that target one or more
  SolverTypes (`supports: ["<solver-type>"]`).
- **runtime-plugin** — ships *MCP tool servers* available to any SolverType the
  operator runs (`supports: ["jinn.runtime"]`, exactly).

The exact commands and JSON output shapes are in
[`references/cli-cheatsheet.md`](references/cli-cheatsheet.md). Verified
dry-run transcripts are in [`references/RESULTS.md`](references/RESULTS.md).
Read the cheatsheet before running any verb.

## Step 0 — RL / policy / learner branch (do this FIRST)

If the person's ask mentions **RL, policy, learner, reward, training, or
"my algorithm"**, stop and state this framing *before* scaffolding anything
(from DR-2026-06-04 §4, `log/decisions/2026-06-04-byo-plugin-journey.md`):

> A plug-in is a **tool/skill contribution** — it feeds the retrieval and tool
> layers a policy exploits. It is **not** the policy. The thing that *learns
> and improves* is the **harness** (the harness *is* the policy, per #689),
> not the plug-in. A plug-in cannot carry a learning algorithm — the
> validator rejects `jinn.solverType` and `jinn.schemas` because the SolverNet
> contract owns those. The only honest "did my plug-in improve anything?"
> signal is the **held-out exam** (#824).

Then confirm: "So we'll build a **tool/skill plug-in** (the part you *can*
contribute), and point you at the harness/learner substrate + the held-out
exam for the policy side. Sound right?" Only proceed once they confirm they
want a tool/skill plug-in.

If RL is not mentioned, skip to Step 1.

## Step 1 — The interview (cap at 3–4 questions)

The person arrives with intent. Ask only for what you cannot infer. You need
at most four things:

| Slot | What you need | Default / inference |
|------|---------------|---------------------|
| **Package name** | npm-style `@you/name` | ask — required |
| **What it does** | one line; drives the skill/tool content you draft | ask — required |
| **Pattern** | `solver-type-plugin` vs `runtime-plugin` | infer: "skill / checklist / prompt" → solver-type; "tool / server / MCP / API" → runtime. Explain the difference if unsure. |
| **Target SolverType** | e.g. `prediction.v1`, `swe-rebench-v2.v1` | default `swe-rebench-v2.v1`; **ignored for runtime-plugin** (don't ask if runtime) |

Ask conversationally. Use `AskUserQuestion` only where a real choice exists
(pattern when ambiguous; target SolverType when it matters). **Never exceed
four questions** beyond their opening description — infer the rest.

## Step 2 — Scaffold (AC#1)

Run (see cheatsheet §1):

```
jinn create plugin <packageName> --pattern <pattern> --solver-type <st> --out-dir <cwd>
```

Use the person's current directory for `--out-dir` unless they name another.
Parse the target path from the first stdout line — `Created <name> at <targetRoot>`
— and remember it as `<targetRoot>` for every later step.

## Step 3 — Fill the placeholder (AC#2)

The scaffold ships a placeholder. Replace it with real content drafted from the
person's one-liner. **Leave no literal "placeholder" text behind.**

**solver-type-plugin:** rewrite `<targetRoot>/skills/example/SKILL.md` — both
the YAML frontmatter `description` (so a harness knows when to load it) and the
body. The template body literal is `This skill is a placeholder.` Write a real,
opinionated skill that helps a solver attempt the target SolverType. Then
verify:

```
grep -c placeholder <targetRoot>/skills/example/SKILL.md   # must be 0
```

Loop (rewrite → grep) until zero matches remain.

**runtime-plugin:** there is no SKILL.md. Draft:
- `<targetRoot>/mcp/server.mjs` — replace the stub with a real (or
  realistically-stubbed) MCP server for the tool(s) you describe.
- `<targetRoot>/jinn.plugin.json` — set a real `jinn.description` and real
  tool name(s) under `jinn.capabilities.tools`.

**Do NOT add `jinn.solverType` or `jinn.schemas` to the manifest** — the
validator rejects both (the SolverNet contract owns them). For runtime, keep
`supports: ["jinn.runtime"]` exactly.

## Step 4 — Validate loop (AC#3)

```
jinn solver-plugins validate <targetRoot>
```

Parse the JSON. On `ok:false`, read `.error.message`, fix the cause in
`<targetRoot>`, and re-run. Loop until `ok:true`. (Note: validate
materializes the plug-in into `~/.jinn-client/solver-plugins/<basename>/` —
papercut #1052; see cheatsheet §2. If a stale copy bites you, delete that dir
and re-validate.)

## Step 5 — Load-verify (AC#4)

This is the "did it actually load" gate — it runs the **real daemon loader**.
Prereq: the client is built (`cd operator && yarn build`); if not, build it.

```
node .claude/skills/create-plugin/references/load-probe.mjs <abs-targetRoot> <target>
```

- `<target>` = the `--solver-type` you scaffolded (solver-type-plugin), or
  `jinn.runtime` (runtime-plugin).

Require `{"ok":true,...}` (exit 0). If `ok:false`, the loader could not resolve
the plug-in for that target — re-check `supports` in the manifest and that you
passed the right `<target>` (the SolverType for skill plugins; `jinn.runtime`
for runtime plugins).

## Step 6 — Publish (GATED — AC#5)

Publishing writes **on-chain**: it pins the plug-in to IPFS and writes
`plugin:<cid>` on the ERC-8004 IdentityRegistry, lazily completing the
builder's Stage-1 identity. It needs a funded EOA and `JINN_PASSWORD`.

**Do not publish without explicit confirmation.** Explain the above, then ask:
"Publishing writes on-chain and needs funding + your keystore password. Want me
to publish now, or stop here?" Only on a clear yes:

```
JINN_PASSWORD=… jinn solver-plugins publish <targetRoot>
```

Relay `txHash` + `pluginCid` on success. On `ensure_stage1_failed`, relay the
funding hint verbatim and tell them to fund the EOA and re-run.

## Step 7 — Join a SolverNet (GATED — AC#5)

Joining attaches the plug-in to a SolverNet the operator runs.

**Do not join without explicit confirmation.** Only on a clear yes:

```
jinn solver-nets add-plugin <solver-net> <source>
```

Remind them: **a daemon restart is required** — the daemon does not hot-reload
SolverNet config. (`add-plugin` also prints a legacy-shape WARNING per issue
#421; re-join via the SPA to get a real manifest CID.)

## Step 8 — Point at scoring

Tell them where the plug-in's effect shows up:
- `jinn solver-plugins status <pluginCid>` — publication + reputation summary.
- The explorer curve: `/explore?filter[plugin]=…` — learning curves grouped /
  filtered by plug-in.
- For a **learning** plug-in, the **held-out exam (#824)** is the honest
  "did it improve anything" signal — not in-sample scores.

## Self-check before declaring done

- [ ] (If RL/policy/learner was mentioned) the policy-vs-tool framing was
      stated **before** scaffolding.
- [ ] Interview was 3–4 questions max.
- [ ] `<targetRoot>` was scaffolded via `jinn create plugin`.
- [ ] No literal "placeholder" text remains (`grep -c placeholder` → 0 for
      solver-type; manifest + server.mjs filled for runtime).
- [ ] No `jinn.solverType` / `jinn.schemas` in the manifest.
- [ ] `validate` returned `ok:true`.
- [ ] load-probe returned `ok:true` for the right target (SolverType for
      skill plugins; `jinn.runtime` for runtime plugins).
- [ ] Publish / join were run **only** after explicit confirmation, or not at
      all.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Leaving "This skill is a placeholder." in `SKILL.md` | Rewrite the body; `grep -c placeholder` must be 0 |
| Adding `jinn.solverType` or `jinn.schemas` to the manifest | Remove them — the SolverNet contract owns those; validator rejects them |
| Probing a runtime plug-in with the SolverType as `<target>` | Runtime plugins resolve under `jinn.runtime`, not a SolverType |
| Publishing or joining without confirmation | Both write irreversible / on-chain / config state — gate behind an explicit yes |
| Running load-probe before `yarn build` | The probe imports `operator/dist/plugins/index.js`; build first |
| Asking more than four interview questions | Infer pattern + SolverType from the person's language; default `swe-rebench-v2.v1` |
| Framing an RL plug-in as "the policy" | A plug-in is a tool/skill contribution; the harness is the policy (Step 0) |

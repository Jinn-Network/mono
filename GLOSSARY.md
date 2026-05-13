# GLOSSARY

**What this doc is / is not.** This is the canonical dictionary of Jinn-specific terms — *vessel, vow, summon, smoke, seer, wane*, and the rest of the lexicon. It is not a place to debate naming, document deprecated terminology, or capture brand voice (see `BRAND.md`); definitions here are load-bearing and may not be redefined elsewhere in the repo. Changes go through CODEOWNERS review with a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions); see [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).

<!-- Sections expand as terms ratify; see GitHub Discussions for upstream proposals. -->

## Tokens and economic primitives

| Term | Usage notes |
|------|-------------|
| JINN | The protocol token. Always all-caps. Not "Jin", "Jyn", "Gin", or "$JINN" in prose. |
| veJINN | Vote-escrowed JINN. Always written `veJINN` (lowercase `ve` prefix, all-caps `JINN`). Used to direct emissions across staking contracts. Not "ve-Jin" or "VEN". |
| Jinn | The protocol and the network. Title case in prose; only all-caps when referring to the token. |

### Insider allocation

Any distribution mechanism that places tokens in the hands of parties before useful network activity has occurred: pre-mint, founder bag, team unlock, early-investor cliff, advisor allocation, treasury allocation that is not itself activity-gated.

Jinn has none of these. Naming this explicitly is load-bearing in pitch and growth material — it is the single sharpest structural differentiator.

## Roles

### Curator

The role that stakes JINN to direct emissions toward task types the network should get better at — and that defines the evaluation criteria attempts are graded against. A Curator launches and configures a SolverNet.

Replaces the earlier name "Trainer", which inherited the LLM-training frame.

## Network primitives and process

### Solution

What is stored in the corpus and matched against a submitted task. A solution can be any of these forms, or any combination of them:

- a skill (callable function)
- a plugin
- a prompt set
- a harness configuration
- a full environment (e.g. a Docker image)

A SolverNet's Curator specifies which solution formats their SolverNet accepts.

In external writing, never leave "solution" as an abstract noun without at least one concrete example.

### Learning

In Jinn, the network learns by doing — running attempts, scoring them, accumulating the corpus, and improving the search across it. This is the Bitter Lesson sense of learning (Sutton): the general method that scales arbitrarily with compute, in contrast to hand-coded structure.

Used in place of "training" in external contexts. Builders hear "training" as gradient descent on a model; "learning" carries the same conceptual weight without the LLM collapse.

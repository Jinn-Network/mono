---
id: DR-2026-05-06-g
title: Vocabulary — train / frozen mode and HarnessCheckpoint
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

DR-2026-05-06-c commits a Harness-interface contract with two execution modes. The naming was iterated during the design exercise:

- Initial draft: `'learning' | 'frozen'`. Direct semantic match to the substrate's continuous-learning property.
- AI/ML alignment review: PyTorch's canonical pattern is `model.train()` + `model.eval()`. Transfer-learning vocabulary is "frozen weights." Wider AI/ML ecosystem alignment was the Captain-stated requirement.

Three candidate pairings:
- (i) `'learning' | 'frozen'` — semantic-direct.
- (ii) `'train' | 'eval'` — canonical PyTorch.
- (iii) `'train' | 'frozen'` — PyTorch-half + transfer-learning-half.

Separately, the artifact-level entity for a published frozen state was named "HarnessSnapshot" in earlier discussion drafts; the AI/ML review surfaced "HarnessCheckpoint" as a closer match to standard ML vocabulary ("model checkpoint", "save a checkpoint").

## Decision

**Mode field: `'train' | 'frozen'` (option iii).**
**Artifact name: `HarnessCheckpoint` (replacing "HarnessSnapshot").**

```ts
// @jinn-network/sdk/harness
interface HarnessContext {
  // ... existing ...
  mode: 'train' | 'frozen';
}

interface Executor {
  // ... existing ...
  mode: 'train' | 'frozen';
}

// SDK helper
function requireTrain(ctx: HarnessContext, action: string): void { ... }

// CLI surface
jinn harness mode train
jinn harness mode frozen
jinn checkpoint publish
jinn checkpoint install <cid>
```

## Rationale

- **`'train'` matches PyTorch's canonical mode flag.** Every ML practitioner has typed `model.train()` thousands of times. The semantic ("parameters are updating; gradients flowing") maps cleanly to our case ("implStateDir mutates via Improve; harness is learning").
- **`'frozen'` avoids overload with the SolverNet protocol's Evaluator role.** PyTorch's pair is `train` / `eval`, but `eval` collides with our protocol's Evaluator role (the bonded operator running the SolverNet's `evaluationFunction`). Calling a harness mode `'eval'` would confuse readers about whether `Executor.mode === 'eval'` means "from a harness in eval mode" or "from an evaluator." Avoidable.
- **`'frozen'` is industry-standard for our exact mechanic.** Transfer-learning has used "freeze the layers" / "frozen weights" for a decade. Pairing `'train'` + `'frozen'` is well-attested; reads naturally; captures the literal mechanic (state immutable).
- **`HarnessCheckpoint` matches universal ML vocabulary.** "Save a checkpoint" / "load a checkpoint" / "publish a checkpoint" all read natively in ML contexts. "Snapshot" is more generic and less load-bearing in ML literature; "checkpoint" carries the exact connotation of "saved state at a moment in time, suitable for resumption / forking / evaluation."

## Alternatives considered and rejected

- **(i) `'learning' | 'frozen'`.** Slightly less ML-native; "training" is the standard active-form verb; "learning" reads as more general. Rejected on Captain's request for AI-aligned terminology.
- **(ii) `'train' | 'eval'`.** Canonical PyTorch but overloads the Evaluator role. Rejected.
- **HarnessSnapshot as artifact name.** Earlier draft term; less ML-aligned than HarnessCheckpoint. Rejected during the AI/ML vocabulary review.

## Consequences

- **SDK rename.** `requireLearning` → `requireTrain`. Helper at write call sites in Path-2 harness implementations.
- **CLI verb pattern.** `jinn checkpoint publish` / `install` / `list` (replaces earlier `jinn harness publish` / `install` proposals). Reads natively: "publish a checkpoint" / "install a checkpoint." `jinn harness mode train|frozen` for mode toggle.
- **Documentation.** SDK JSDoc explains the `mode` field and the freeze contract using ML conventions. Recruit-grade docs reference PyTorch's `model.train()` analogy explicitly to lower the translation cost for ML-fluent recruits.
- **Subgraph + dashboard surface.** "Train-mode leaderboard" / "frozen-mode leaderboard" as the rollup labels. "Verified frozen" / "unverified frozen" credibility tiers (per DR-d §Consequences).
- **Spec section headings.** "Frozen-state contract" (the Harness-interface obligation); "Train and frozen modes" (the architectural section).

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06.

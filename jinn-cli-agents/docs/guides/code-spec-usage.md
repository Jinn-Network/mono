---
title: Code Spec Review
purpose: guide
scope: [worker, gemini-agent, frontend, codespec]
last_verified: 2026-02-02
related_code:
  - codespec/scripts/review.sh
  - codespec/blueprints/
keywords: [code spec, review, invariants, blueprints]
when_to_read: "When reviewing code against project standards"
---

# Code Spec Review

Review code against the project's invariants (coding standards).

## Usage

```bash
# Review a file
./codespec/scripts/review.sh worker/mech_worker.ts

# Review a directory
./codespec/scripts/review.sh worker/

# Or via yarn
yarn codespec:review worker/mech_worker.ts
```

The script uses Claude to check code against the invariants in `codespec/blueprints/`.

## Blueprints

The invariants are defined in JSON files:

| File | Contents |
|------|----------|
| `codespec/blueprints/objectives.json` | High-level goals (OBJ-*) |
| `codespec/blueprints/rules.json` | Hard constraints (RULE-*) |
| `codespec/blueprints/defaults.json` | Default behaviors (DB-*) |

## Rendered Specification

For a human-readable version, see [code-spec.md](./code-spec.md).

To regenerate it from blueprints:

```bash
yarn codespec:render
```

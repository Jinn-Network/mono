---
name: "Plan: Update GEMINI.md and Protocol Model"
overview: ""
todos: []
---

# Plan: Update GEMINI.md and Protocol Model

## Overview
Update `gemini-agent/GEMINI.md` and `docs/spec/documentation/protocol-model.md` to align with the new "Homomorphic Job" architecture and strict Blueprint-driven workflow. This merges the colleague's strict JSON blueprint and delegation models with the user's existing robust operational guidelines (Git, Resource Efficiency, Summary Structure) and the specific "Separation of Work and Validation" philosophy.

## User Directives Summary
- **Identity & Blueprints**: Adopt colleague's strict JSON structure.
- **Work Protocol**:
    - **Context**: Add "CRITICAL" child work check.
    - **Execution**: Mandate Blueprints for all delegations (no structured fields). Allow parallel dispatch.
    - **Completeness vs Validation**: Combine "Completeness Principle" (don't start what you can't finish) with "Two-Phase Execution" (separate work from verification).
- **Git Workflow**: Keep existing detailed section but add `process_branch` tool for merging.
- **Root Jobs**: Remove special "Root Job" responsibilities (Launcher Briefing, Compliance). Enforce "Homomorphic Job Runs".
- **Reporting & Resources**: Keep existing detailed Execution Summary and Resource Efficiency sections.

## Proposed Changes

### 1. `gemini-agent/GEMINI.md`

- **Update Section I (Identity & Purpose):**
    - Replace "Blueprint-Driven Execution" with colleague's strict JSON `assertions` model.
    - Adopt "Work Decomposition" / "Fractal Pattern" language.
    - **Validation Phase**: Retain the existing "Blueprint Assertion Completeness" / "Two-Phase Execution" section but integrate the colleague's "Completeness Principle" text to emphasize that the *Execution Phase* must be atomic.

- **Update Section II (Core Operating Principles):**
    - Replace with colleague's concise definitions for Autonomy, Tool-Based Interaction, and Factual Grounding.

- **Update Section III (The Work Protocol):**
    - **Phase 1 (Contextualize)**: Insert the "CRITICAL" instruction to check child work (`get_details`/`search_artifacts`).
    - **Phase 2 (Decide & Act)**:
        - **Delegation**: Enforce "Blueprint Construction" for every child. Remove "structured blueprint fields" option. Add "Parallel Dispatch" capability.
        - **Direct Work**: Reinforce the "Completeness Principle" within the context of the execution phase.
    - **Root Job Responsibilities**: **DELETE** this entire subsection.

- **Update Section IV (Code Workflow):**
    - Keep the existing detailed structure.
    - Add `process_branch` tool usage to the "Merging Children" or "Branch Management" context.

- **Update Section V (Execution Summary):**
    - **Keep** the existing detailed structure and examples.

- **Update Section VI (Resource Efficiency):**
    - **Keep** the existing section.

### 2. `docs/spec/documentation/protocol-model.md`

- **Update Section 2.3 (Job Hierarchy and Work Protocol):**
    - Add the **"Homomorphic Job Runs"** principle:
        > "Job runs are homomorphic. Root jobs follow the exact same execution logic as child jobs and possess no special responsibilities or distinct behaviors."

- **Remove "Root Job Responsibilities":**
    - Delete references to "Launcher Briefing Artifact" and "Blueprint Compliance" logic specific to root jobs.

- **Remove "Launcher Briefing" from Appendix/Tables:**
    - Ensure no artifacts related to specific root job duties remain in the spec.

## Verification
- Verify `GEMINI.md` presents a consistent hybrid model (JSON blueprints + Two-Phase Validation).
- Verify `protocol-model.md` reflects the removal of Root Job specializations.
# Canon audit prompts

Prompt templates for the judgmental audit subagent (Phase 2) and the triage subagent (Phase 3).

## Judgmental audit subagent prompt

The subagent runs once per release-readiness invocation. It receives:
- Full diff from `git log lastReleasedSha..branchSha`
- All five canon docs (PRINCIPLES.md, SPEC.md, BRAND.md, GROWTH.md, GLOSSARY.md)
- All operational memory files
- All skill SKILL.md files (under `.claude/skills/`)
- List of judgmental check items (C1, C3, C4, C7, C8, C10, C11) with descriptions

```
You're auditing a candidate release branch against canon and operational memory.

Inputs you have access to:
- Diff: {DIFF_TEXT}
- Canon docs: {CANON_DOCS_INLINED}
- Operational memories: {MEMORY_FILES}
- Skill files: {SKILL_FILES}
- Judgmental check items: {CHECK_ITEMS}

For EACH check item, walk the diff and identify findings.

Then, for EACH canon doc, do an open-ended pass: does anything in the diff
contradict, undermine, or skirt a principle in this doc?

For EACH skill file, ask: does anything in the diff make this skill's
instructions wrong or incomplete?

Return a single unified structured report as JSON:

[
  {
    "id": "GAP-1",
    "source": "C1" | "C7" | "canon:PRINCIPLES.md" | "skill:testing-jinn-app/SKILL.md" | ...,
    "description": "...",
    "severity": "high" | "medium" | "low",
    "rationale": "specific cite from both the diff and the source",
    "references": [{"file": "path", "line": N, "snippet": "..."}, ...],
    "crossCuttingWith": ["GAP-N", ...]
  },
  ...
]

Be specific. "Vibes off" is not a finding. Cite both sides — the diff content
that triggers the concern AND the canon/memory/skill section it violates.

If two findings share a root cause, list both in `crossCuttingWith`.
```

## Triage subagent prompt

The triage subagent runs once after the audit. It receives:
- The full findings list from the audit subagent
- PRINCIPLES.md (re-loaded for context)
- The current candidate version and recent release history (so it knows what "next release" target is)
- The triage taxonomy rules

```
You're triaging audit findings for release {CANDIDATE_VERSION}.

Findings: {FINDINGS_JSON}

Rules: {TRIAGE_TAXONOMY_TEXT}

For each finding, classify:
  BLOCKING   — close before recommend SHIP
  DEFERRABLE — file GH issue with milestone, ship anyway
  ALREADY-MET — link to evidence (existing test, spec section, etc.)

For each:
- BLOCKING: leave as-is; will be passed to closure subagents.
- DEFERRABLE: emit a `gh issue create` shell with:
    - Title: short, action-oriented
    - Body: includes the rationale + references from the finding
    - Labels: "release-blocker" if escalating from DEFERRABLE to near-blocking;
              "skill-drift" if C11 source; relevant area label otherwise
    - Milestone: next release version
- ALREADY-MET: link to the evidence (file path / test name / spec section).

Cross-cutting:
- If multiple findings share a root cause, indicate so in the classifications.
- If a deferrable cluster is large enough that the next-release surface is
  going to drift further, escalate one of them to BLOCKING with a note.

Return JSON:

[
  {
    "gapId": "GAP-1",
    "classification": "BLOCKING" | "DEFERRABLE" | "ALREADY-MET",
    "rationale": "...",
    "ghIssueDraft": null | {
      "title": "...",
      "body": "...",
      "labels": ["..."],
      "milestone": "v0.1.8"
    },
    "evidenceLinks": [{"path": "...", "summary": "..."}, ...]
  },
  ...
]
```

## Handoff-doc-drafting subagent prompt

```
You're drafting a release-readiness handoff doc.

Inputs:
- audit findings: {AUDIT_FINDINGS}
- triage classifications: {TRIAGE_CLASSIFICATIONS}
- closure outcomes: {CLOSURE_OUTCOMES}
- release-prep verdicts: {RELEASE_PREP_VERDICTS}
- Tier 3 verdict + evidence: {TIER_3_RESULT}
- diff summary: {DIFF_SUMMARY}

Use the template at references/handoff-doc-template.md to produce a fully
populated draft. The MAIN agent will read your draft, make the SHIP/DEFER/BLOCK
recommendation, and write the final file.

Produce a markdown draft. Don't make the SHIP/DEFER/BLOCK decision yourself —
populate everything else.
```

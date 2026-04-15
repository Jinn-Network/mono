# Context Management Validation Scripts

This directory contains minimal validation scripts for critical context management features.

## Available Scripts

### test-phase2-dependencies.ts
Automated test for dependency management system. Dispatches two jobs (Job B depends on Job A) and validates that the worker correctly enforces dependency ordering.

**Usage:**
```bash
yarn tsx --env-file=.env scripts/validation/test-phase2-dependencies.ts
```

**Success Criteria:**
- Worker skips Job B until Job A completes
- Worker picks up Job B after Job A delivers
- Dependencies indexed correctly in Ponder

### validate-phase3-simple.ts
Validates workstream progress checkpointing. Creates a sequence of 3 jobs and verifies that later jobs can see summaries of prior work.

**Usage:**
```bash
yarn tsx --env-file=.env scripts/validation/validate-phase3-simple.ts
```

**Success Criteria:**
- Job C's worker logs show workstream progress fetch
- Job C's blueprint augmented with progress summary
- Job C demonstrates awareness of Jobs A and B

## Manual Validation

For complete end-to-end testing, use the integration dispatchers in `scripts/dispatchers/`.


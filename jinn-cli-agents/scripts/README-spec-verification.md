# Spec Verification Job

## Overview

This script posts a root marketplace job that continuously verifies the codebase against the venture spec published at https://jinn.network/code-spec.

## Usage

```bash
# Post the job to the marketplace
yarn tsx scripts/post-spec-verification-job.ts
```

## Configuration

### Model Selection

The job's model is specified in the dispatch script and stored in the job definition:

```typescript
// In scripts/dispatch-code-spec-verification.ts
const jobSpec = {
  // ...
  model: 'gemini-2.5-flash', // or 'gemini-2.5-pro'
  // ...
};
```

Each job can use a different model. The model is stored in IPFS metadata and read by the worker at execution time.

## How It Works

1. **Job Posted**: Script posts root job to marketplace
2. **Ponder Indexes**: On-chain request event indexed
3. **Worker Claims**: mech_worker picks up and claims job
4. **Agent Executes**: 
   - Fetches spec from jinn.network/code-spec via web_fetch
   - Creates launcher briefing artifact
   - Dispatches child jobs for focused scanning
   - Finalizes as DELEGATING
5. **Child Jobs Run**: Parallel scans for each objective
6. **Auto-Repost**: System detects completion and reposts root job
7. **Synthesis**: Root job aggregates child results
8. **Repeat**: Cycle continues indefinitely

## Monitoring

- **Jinn Explorer**: View workstream at `/workstreams/[job-id]`
- **Launcher Briefing**: Check artifacts with topic `launcher_briefing`
- **Violation Reports**: Check artifacts with topic `spec_violation`
- **Worker Logs**: Monitor `mech_worker` for job pickup and execution
- **Ponder Logs**: Monitor for request/delivery events

## Architecture

- **Root Job**: Coordinates verification, maintains launcher briefing
- **Child Jobs**: One per objective (obj1, obj2, obj3), scan specific areas
- **Auto-Repost**: Provides recurring execution without external scheduling
- **Artifacts**: All outputs stored on IPFS and indexed by Ponder

## Updating the Spec

1. Edit files in `docs/spec/code-spec/`
2. Push to main branch
3. Vercel deploys updated content to jinn.network/code-spec
4. Next job run automatically uses updated spec (via web_fetch)

No code changes needed when spec evolves.


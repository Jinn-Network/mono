# Pattern: alternative-harness

**Example package:** [`examples/external-harnesses/alternative-harness`](../../../../examples/external-harnesses/alternative-harness)
**In-repo anchor:** [`operator/plugins/claude-code-learner/`](../../../../client/plugins/claude-code-learner)

## Recruit shape

You run a harness — Pi.dev, Codex, Gemini CLI, your own runtime — and want to ship the seven-phase pipeline (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory) against your environment instead of Claude Code. You're not shipping a forecaster; you're shipping a learning Harness that competes with `claude-code-learner` on the same solverTypes.

The alternative-harness pattern is the highest-effort Path 2 shape — you own the whole pipeline — but it lets harness operators participate in Jinn without forking the daemon.

## What the pattern does

An alternative Harness implements the seven-phase pipeline using its runtime's primitives — its own subagent dispatch, its own tool surface, its own skill registry — and returns the same `Solution` shape as `claude-code-learner` for matching solverTypes.

The in-repo `claude-code-learner` is the working reference. The pipeline's interfaces (phase coordinator and phase-skill spawn) are documented in the bundled learner's source; an alternative Harness reimplements those interfaces against its target runtime.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/alternative-harness",
  "version": "0.1.0",
  "supportedSolverTypes": ["prediction.v0>=1.0.0"],
  "entry": "./dist/index.js",
  "package": { "cid": "bafybei...", "hash": "sha256:..." },
  "capabilities": {
    "rpc": [
      { "chainId": 84532, "methods": ["eth_call", "eth_blockNumber"] }
    ]
  },
  "signature": { "alg": "ed25519", "publicKey": "...", "sig": "..." },
  "license": "MIT"
}
```

The capability allow-list mirrors the bundled `claude-code-learner`'s — narrow `rpc` reads, no signer (the pipeline reasons without transacting). Alternative harnesses typically claim a single solverType for v0 and broaden as the harness matures.

## Slot entry walkthrough

`src/index.ts` default-exports a factory that constructs a pipeline coordinator wired to the alternative harness:

```ts
import type {
  Harness,
  HarnessContext,
  Solution,
  ExternalHarnessEnv,
} from '@jinn-network/sdk/harness';
import { createCoordinator } from './coordinator.js';

export default function createHarness(env: ExternalHarnessEnv): Harness {
  const coordinator = createCoordinator({
    network: env.network,
    implStateDir: env.implStateDir,
    log: env.log,
  });
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ solverType, role }) {
      return solverType === 'prediction.v0' && role !== 'evaluation';
    },
    async isReady() {
      return env.stub ? { ready: false, reason: 'stub mode' } : { ready: true };
    },
    async run(ctx: HarnessContext): Promise<Solution> {
      const orient = await coordinator.orient(ctx);
      const strategy = await coordinator.strategize(ctx, orient);
      const plan = await coordinator.plan(ctx, strategy);
      const execution = await coordinator.execute(ctx, plan);
      const debrief = await coordinator.debrief(ctx, execution);
      await coordinator.improve(ctx, debrief);
      await coordinator.consolidateMemory(ctx, debrief);
      return execution.output;
    },
  };
}
```

The `coordinator` is your harness's pipeline. Each phase method spawns the appropriate subagents in your runtime, reads/writes phase artefacts under `ctx.workingDir`, and respects the constitutional snapshot from Strategize through Improve.

## Test → publish

```bash
cd examples/external-harnesses/alternative-harness
yarn install
yarn test
yarn vitest run test/e2e-anvil.test.ts        # full pipeline run on Anvil fork against synthetic Task
yarn build
```

Then sign + pin + publish per [publishing.md](../publishing.md).

## Replace the stub

1. **Implement each phase against your harness.** The bundled learner's `claude-code-learner/phases/` directory is the structural reference: each phase is a coordinator that dispatches phase-specific subagents and produces the phase artefact. Reimplement the dispatch using your runtime's primitives.
2. **Honour the constitutional snapshot.** Strategize freezes success criteria + timing posture; Plan, Execute, Debrief, and Improve MUST NOT mutate it. The bundled learner enforces this via the coordinator; your alternative MUST replicate the invariant.
3. **Follow the artefact schemas.** `workingDir/.<phase>/` artefacts have implicit shapes that downstream phases depend on. Reading the bundled learner's phase outputs is the fastest way to reverse-engineer the schemas; future work formalises them.
4. **Don't widen capabilities.** Stay within the manifest's `capabilities` allow-list. Alternative harnesses are tempting places to "just add one more thing" — don't; that's how trust erodes across the recruit pool.
5. **Keep SolverPlugins at the host boundary.** SolverPlugins are loaded by the daemon/Claude Code host, not by a Harness-specific slot registry. If your runtime has its own plugin model, expose it as a separate operator feature rather than widening the Harness SDK contract.

Alternative harnesses are the cleanest test of the SDK's stability commitment: if you can ship the seven-phase pipeline against an entirely different runtime using only the SDK's exports, the contract surface is doing its job. Feedback from alternative-harness builders is a load-bearing input for the 1.0 SDK cut.

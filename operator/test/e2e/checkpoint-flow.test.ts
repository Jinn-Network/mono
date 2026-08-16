/**
 * Checkpoint publish/install + cross-operator codeDigest equivalence e2e.
 *
 * Public command: `yarn e2e:checkpoint-flow`
 *
 * Option B (lightweight integration): exercises the full Plan 3 publish/install
 * pipeline in-process with mocked IPFS + signature deps. Uses the REAL
 * hashImplStateDir and REAL runHarnessWithFreezeFence. Verifies that the
 * Plan 1 freeze-fence and the Plan 2 SolverNet integration all work together
 * to produce a consistent benchmark identity.
 *
 * Cases:
 *   1. Op A publishes a checkpoint — manifest signed, schema validates.
 *   2. Op B installs A's checkpoint — signature verified, implStateDir staged.
 *   3. Both implStateDirs hash to the same codeDigest (hash equivalence).
 *   4. Both operators running frozen-mode harnesses produce the same codeDigest.
 *
 * Full Anvil-fork integration (on-chain setMetadata, real IPFS pins) is deferred
 * to the Phase A.5 integration sprint.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.2 + §7
 */

import { mkdtemp, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointPublishCommand, checkpointInstallCommand } from '../../src/cli/commands/checkpoint.js';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import { runHarnessWithFreezeFence } from '../../src/daemon/freeze-fence.js';
import type { Harness, HarnessContext, Solution } from '../../src/harnesses/types.js';
import { runPhase, summarize, assert } from './task-first-helpers.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubSolution(): Solution {
  return { venueRef: { name: 'test' }, gating: {} };
}

function makeCtx(implStateDir: string, taskId: string): HarnessContext {
  return {
    task: {
      id: taskId,
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as HarnessContext['task'],
    implStateDir,
    workingDir: implStateDir,
    log: (_event) => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: { addSpan: () => ({} as any) } as HarnessContext['trajectory'],
    mode: 'frozen',
  };
}

// ── Test phases ───────────────────────────────────────────────────────────────

/**
 * Full pipeline: Op A publishes → Op B installs → both implStateDirs hash
 * to the same codeDigest → both frozen-mode harness runs agree on codeDigest.
 */
async function runCheckpointPublishInstallPipeline(): Promise<void> {
  const stateDirA = await mkdtemp(join(tmpdir(), 'jinn-cp-e2e-op-a-'));
  const stateDirB = await mkdtemp(join(tmpdir(), 'jinn-cp-e2e-op-b-'));

  try {
    // Operator A's implStateDir has some real content to hash.
    await writeFile(join(stateDirA, 'state.json'), JSON.stringify({ trained: true, epoch: 42 }));

    // IPFS in-memory store: simulates pin + fetch roundtrip.
    const ipfsStore: Record<string, string> = {};

    // ── Step 1: Op A publishes a checkpoint ───────────────────────────────────

    const pubResult = await checkpointPublishCommand({
      name: '@op-a/fork',
      version: '0.1.0',
      implStateDir: stateDirA,
      sourceBundleCid: 'bafy_src',
      implName: 'op-a-fork',
      implVersion: '0.1.0',
      clientGitSha: '0xdeadbeef',
      deps: {
        pinToIpfs: async (args) => {
          const cid = `bafy_${args.kind}`;
          if (typeof args.data === 'string') {
            ipfsStore[cid] = args.data;
          }
          return cid;
        },
        callSetMetadata: async (_args) => ({
          txHash: '0x' + 'a'.repeat(64) as `0x${string}`,
          blockNumber: 100,
        }),
        hashImplStateDir,  // real hash — key to end-to-end consistency
        sign: async (_json) => 'ed25519-sig-stub',
        getSigningIdentity: async () => ({
          agentId: 'did:jinn:eth:0x1234',
          signingKey: 'ed25519:' + 'b'.repeat(64),
          safeAddress: '0x' + 'c'.repeat(40),
        }),
      },
    });

    assert(
      pubResult.checkpointCid === 'bafy_manifest',
      `expected checkpointCid=bafy_manifest, got ${pubResult.checkpointCid}`,
    );

    const codeDigestA = pubResult.manifest.codeDigest;
    assert(
      /^sha256:[0-9a-f]{64}$/.test(codeDigestA),
      `codeDigest must be sha256:<64hex>, got ${codeDigestA}`,
    );

    process.stdout.write(
      `  published: checkpointCid=${pubResult.checkpointCid} codeDigest=${codeDigestA.slice(0, 24)}...\n`,
    );

    // Update the IPFS store with the final manifest (registry-populated version).
    // This simulates what would happen in a real publish flow: the operator pins
    // the complete manifest (with registry anchor) after the on-chain tx confirms.
    ipfsStore[pubResult.checkpointCid] = JSON.stringify(pubResult.manifest);

    // ── Step 2: Op B installs A's checkpoint ─────────────────────────────────

    const installResult = await checkpointInstallCommand({
      cid: 'bafy_manifest',
      targetDir: stateDirB,
      deps: {
        fetchFromIpfs: async (cid) => {
          const content = ipfsStore[cid];
          if (content === undefined) throw new Error(`unknown CID: ${cid}`);
          return content;
        },
        verifySignature: async (_args) => true,
        fetchImplStateDirToLocal: async (_implStateDirCid, target) => {
          // Simulate IPFS fetching implStateDir content to the target.
          await cp(stateDirA, target, { recursive: true });
          return target;
        },
        stageAsHarnessState: async (_stagedDir, _implName) => {},
      },
    });

    assert(installResult.installed === true, 'install result must report installed=true');
    assert(
      installResult.codeDigest === codeDigestA,
      `installed codeDigest ${installResult.codeDigest} must match published ${codeDigestA}`,
    );
    assert(
      installResult.implName === 'op-a-fork',
      `installed implName must be op-a-fork, got ${installResult.implName}`,
    );

    process.stdout.write(
      `  installed: implName=${installResult.implName} codeDigest=${installResult.codeDigest.slice(0, 24)}...\n`,
    );

    // ── Step 3: Both implStateDirs hash to the same codeDigest ───────────────

    const hashA = await hashImplStateDir(stateDirA);
    const hashB = await hashImplStateDir(stateDirB);

    assert(
      `sha256:${hashA}` === codeDigestA,
      `Op A implStateDir hash sha256:${hashA} must match published codeDigest ${codeDigestA}`,
    );
    assert(
      hashB === hashA,
      `Op B implStateDir hash (${hashB}) must equal Op A (${hashA}) — same content`,
    );

    process.stdout.write(`  hash equivalence: hashA=hashB=${hashA.slice(0, 20)}... (match)\n`);

    // ── Step 4: Both frozen-mode harnesses agree on codeDigest ────────────────

    const noOpHarness: Harness = {
      name: 'op-a-fork',
      version: '0.1.0',
      supports: () => true,
      async run(): Promise<Solution> {
        return stubSolution();
      },
    };

    const fenceA = await runHarnessWithFreezeFence(noOpHarness, makeCtx(stateDirA, 'task-op-a-1'));
    const fenceB = await runHarnessWithFreezeFence(noOpHarness, makeCtx(stateDirB, 'task-op-b-1'));

    assert(
      fenceA.ok,
      `Op A frozen-mode run must succeed${!fenceA.ok ? `: violation=${JSON.stringify((fenceA as any).violation)}` : ''}`,
    );
    assert(
      fenceB.ok,
      `Op B frozen-mode run must succeed${!fenceB.ok ? `: violation=${JSON.stringify((fenceB as any).violation)}` : ''}`,
    );

    if (fenceA.ok && fenceB.ok) {
      assert(
        fenceA.codeDigest === fenceB.codeDigest,
        `Frozen-mode codeDigest must match: Op A=${fenceA.codeDigest} Op B=${fenceB.codeDigest}`,
      );
      process.stdout.write(
        `  freeze-fence: both operators codeDigest=${fenceA.codeDigest.slice(0, 20)}... (same identity)\n`,
      );
    }
  } finally {
    await rm(stateDirA, { recursive: true, force: true });
    await rm(stateDirB, { recursive: true, force: true });
  }
}

/**
 * Verify that a failed signature check throws (security contract).
 */
async function runInstallRejectsInvalidSignature(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'jinn-cp-e2e-sig-'));
  try {
    await writeFile(join(stateDir, 'state.json'), JSON.stringify({ v: 1 }));

    const ipfsStore: Record<string, string> = {};

    // Publish a valid checkpoint first so we have a real manifest JSON in store.
    const pubResult2 = await checkpointPublishCommand({
      name: '@op-x/test',
      version: '0.1.0',
      implStateDir: stateDir,
      sourceBundleCid: 'bafy_src2',
      implName: 'op-x-test',
      implVersion: '0.1.0',
      clientGitSha: '0xfeedcafe',
      deps: {
        pinToIpfs: async (args) => {
          const cid = `bafy2_${args.kind}`;
          if (typeof args.data === 'string') ipfsStore[cid] = args.data;
          return cid;
        },
        callSetMetadata: async (_args) => ({
          txHash: '0x' + 'd'.repeat(64) as `0x${string}`,
          blockNumber: 200,
        }),
        hashImplStateDir,
        sign: async (_json) => 'ed25519-sig-stub',
        getSigningIdentity: async () => ({
          agentId: 'did:jinn:eth:0x5678',
          signingKey: 'ed25519:' + 'e'.repeat(64),
          safeAddress: '0x' + 'f'.repeat(40),
        }),
      },
    });
    // Store the final (registry-populated) manifest so the install command can parse it.
    ipfsStore[pubResult2.checkpointCid] = JSON.stringify(pubResult2.manifest);

    // Install attempt with verifySignature returning false must throw.
    let threw = false;
    try {
      await checkpointInstallCommand({
        cid: 'bafy2_manifest',
        targetDir: stateDir,
        deps: {
          fetchFromIpfs: async (cid) => {
            const content = ipfsStore[cid];
            if (content === undefined) throw new Error(`unknown CID: ${cid}`);
            return content;
          },
          verifySignature: async (_args) => false,  // invalid signature
          fetchImplStateDirToLocal: async (_cid, target) => target,
          stageAsHarnessState: async (_dir, _name) => {},
        },
      });
    } catch {
      threw = true;
    }

    assert(threw, 'checkpointInstallCommand must throw when signature verification fails');
    process.stdout.write('  invalid-signature install correctly rejected\n');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = await Promise.all([
    runPhase(
      'checkpoint / Op A publishes → Op B installs → same codeDigest + freeze-fence agreement',
      runCheckpointPublishInstallPipeline,
    ),
    runPhase(
      'checkpoint / install rejects invalid signature',
      runInstallRejectsInvalidSignature,
    ),
  ]);

  summarize(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

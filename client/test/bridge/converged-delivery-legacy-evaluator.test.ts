import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from '@jinn-network/task-execution-protocol';
import { makeLocalTaskExecutionBackend } from '@jinn-network/task-execution-backend-local';
import type { LauncherContract } from '@jinn-network/task-execution-launchers';
import type { ProvisionerContract } from '@jinn-network/task-execution-workspace';
import { InMemoryEvidenceCatalog } from '@jinn-network/evidence-discovery';
import { InMemoryEvidenceRepository } from '@jinn-network/evidence-repository/testing';
import {
  buildRepositoryWorkProfile,
  sealTaskProfile,
  type ProfileStore,
} from '@jinn-network/task-execution-profiles';
import type { ExecutionWiringEntry } from '@jinn-network/marketplace-pipeline';
import { SignedEnvelopeSchema } from '../../src/types/envelope.js';
import { legacyRestorationResultFromDelivery } from '../../src/daemon/bridge-legacy-delivery.js';
import { buildLegacyDeliveryExtensions } from '../../src/daemon/composition-root.js';

// ── A real synchronous secp256k1 signer (C7's sync signer port), no viem involved ───────────────
//
// `@noble/curves` is already a direct `client` dependency (its curve implementations are what
// `viem` itself uses under the hood). `sign(..., { prehash: false })` treats the input as an
// already-hashed digest -- raw ECDSA, no re-hash, matching `harnesses/engine/signing.ts`'s
// established convention for this repo's other synchronous secp256k1 signing path. Recovery
// format is reordered to r||s||recovery (that convention's byte order); noble's own `'recovered'`
// format puts the recovery byte first.

const PRIVATE_KEY = secp256k1.utils.randomSecretKey();
const PUBLIC_KEY = secp256k1.getPublicKey(PRIVATE_KEY, false);

function syncSign(hash: `0x${string}`): `0x${string}` {
  const message = Buffer.from(hash.slice(2), 'hex');
  const recovered = secp256k1.sign(message, PRIVATE_KEY, { prehash: false, format: 'recovered' });
  const recovery = recovered[0]!;
  const rs = Buffer.from(recovered.slice(1));
  return `0x${rs.toString('hex')}${recovery.toString(16).padStart(2, '0')}` as `0x${string}`;
}

function verifiesAgainstOurKey(hash: `0x${string}`, sig: `0x${string}`): boolean {
  const message = Buffer.from(hash.slice(2), 'hex');
  const rs = Buffer.from(sig.slice(2, 2 + 128), 'hex');
  return secp256k1.verify(rs, message, PUBLIC_KEY, { prehash: false });
}

// ── A REAL LocalTaskExecutionBackend producing a REAL bridge-annotated Delivery ─────────────────
//
// C7 / finding E24's proof obligation: these fixtures must pass against a delivery this daemon
// actually produced, not a hand-built `sealDelivery({...})` literal. This drives the exact
// production wiring (`buildLegacyDeliveryExtensions` from `composition-root.ts`, the C7 workKind
// seam via `noteAttemptWorkKind`, a real synchronous signer) through a real
// `LocalTaskExecutionBackend.submit()` -> harness -> harvest -> `deliveryExtensions` -> `sealDelivery`
// pass, exactly as `work-loop.ts` drives it in production (two-party engagement, `attemptUri`
// known and noted before `submit()` is ever called).

const AGENT = '0x1111111111111111111111111111111111111111' as const;
const WORK_KIND = 'prediction.v1';
const REQUEST_ID = `0x${'2'.repeat(64)}` as const;

const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get(digest) {
    return digest === sealedProfile.digest ? profile : undefined;
  },
};

const WIRING: readonly ExecutionWiringEntry[] = [
  {
    workKind: WORK_KIND,
    harness: 'claude-code',
    model: 'claude-haiku-4-5-20251001',
    plugins: [],
    credentialRef: 'claude-code-default',
    isolationPolicy: 'process',
  },
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Produces a real sealed Delivery carrying the bridge's legacy execution envelope, by driving a
 * real `LocalTaskExecutionBackend` through a real two-party `submit()` with
 * `deliveryExtensions: buildLegacyDeliveryExtensions(...)` wired exactly as `composition-root.ts`
 * wires it, and `noteAttemptWorkKind` called exactly as `work-loop.ts` calls it -- before
 * `submit()`, using the same deterministic `attemptUri`.
 */
async function produceBridgedDelivery(): Promise<Uint8Array> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'jinn-bridge-delivery-'));
  roots.push(stateRoot);

  const task = sealTask({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    profile: { uri: profile.profile, digest: { sha256: sealedProfile.digest.slice('sha256:'.length) } },
    instructions: 'Predict the outcome.',
    outputs: [{ name: 'prediction.json', mediaType: 'application/json', required: true }],
  });
  const taskDigest = documentDigest(task);
  const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
  const nonce = crypto.randomUUID();
  const submission = sealSubmission({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    submission: submissionUri,
    task: { digest: { sha256: taskDigest.slice('sha256:'.length) } },
    requester: 'urn:uuid:30000000-0000-4000-8000-000000000001',
    idempotencyKey: crypto.randomUUID(),
    nonce,
    deadline: '2099-01-01T00:00:00Z',
  });
  const attemptUri = `urn:uuid:${crypto.randomUUID()}` as const;

  const launcher: LauncherContract = {
    id: 'prediction-v1-fixture',
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: ['application/json'],
      outputMediaTypes: ['application/json'],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: 'repeatable',
      secretForwards: [],
      runPinning: { keys: [] },
    }),
    plan(_view, paths) {
      return {
        argv: [process.execPath, '-e', 'process.exit(0)'],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: 'fixture' },
        interruptionBehavior: 'repeatable',
      };
    },
  };
  const provisioner: ProvisionerContract = {
    workspaceKind: () => 'dir',
    async setup(_view, paths) {
      await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest(paths) {
      // The real harness's output, harvested exactly the way a real solve would leave it: a real
      // file under the attempt's real `out` directory, at the exact path
      // `buildLegacyDeliveryExtensions`'s `outputsRoot` derivation resolves to.
      const outputPath = join(paths.out, 'prediction.json');
      const payload = JSON.stringify({ prediction: 0.42 });
      await writeFile(outputPath, payload);
      return {
        manifest: [
          {
            path: 'prediction.json',
            sizeBytes: Buffer.byteLength(payload),
            sha256: `sha256:${documentDigest(new TextEncoder().encode(payload)).slice('sha256:'.length)}`,
            mediaType: 'application/json',
          },
        ],
        omissions: [],
        integrityViolations: [],
      };
    },
  };

  const instance = makeLocalTaskExecutionBackend({
    stateRoot,
    source: 'urn:jinn:operator:0xoperator',
    executor: 'urn:jinn:operator-runtime:test',
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: 'prediction-v1-fixture', contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ['dir'],
      inputMediaTypes: ['application/json'],
      outputMediaTypes: ['application/json'],
      isolation: ['process'],
    },
    // The marketplace binding's `inspectDelivery` requires at least one `executionId`, which only
    // a real evidence-capture receipt supplies -- so, unlike `backend.evidence.test.ts`'s narrower
    // fixtures, this one needs real evidence capture wired, not just the bridge extension.
    recorderAvailability: 'always',
    evidence: {
      repository: new InMemoryEvidenceRepository(),
      catalog: new InMemoryEvidenceCatalog(),
      async awaitIndexed(reference) {
        return { status: 'not-announced', reference };
      },
    },
    // The C7 workKind seam + sync signer port, wired exactly as `composition-root.ts` wires them.
    deliveryExtensions: buildLegacyDeliveryExtensions({
      stateRoot,
      participant: AGENT,
      wiring: WIRING,
      sign: syncSign,
    }),
  });

  // C7 workKind seam (finding E24): noted BEFORE `submit()`, exactly as `work-loop.ts` does --
  // `attemptUri` is deterministic and known ahead of the two-party submit call.
  instance.noteAttemptWorkKind(attemptUri, WORK_KIND, REQUEST_ID);

  const ack = await instance.submit(task, submission, {
    attemptUri,
    dispatchContext: { taskDigest, submission: submissionUri, nonce, attempt: attemptUri },
  });
  if (!ack.accepted) throw new Error(`submit rejected: ${ack.error.message}`);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await instance.observe(ack.submission);
    if (snapshot.descriptor.derived.terminal) {
      if (snapshot.descriptor.derived.state !== 'delivered') {
        throw new Error(`attempt did not deliver: ${snapshot.descriptor.derived.state}`);
      }
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  const refs = await instance.deliveries(attemptUri);
  if (refs.length !== 1) throw new Error(`expected exactly one delivery, got ${refs.length}`);
  return instance.fetchDelivery(refs[0]!);
}

describe('converged Delivery is parseable by the legacy evaluator path', () => {
  it('yields a restorationResult string the legacy evaluator schema accepts, from a delivery this daemon actually produced', async () => {
    const delivery = await produceBridgedDelivery();

    const restorationResult = legacyRestorationResultFromDelivery(delivery);
    expect(typeof restorationResult).toBe('string');
    const parsed = SignedEnvelopeSchema.parse(JSON.parse(restorationResult!));
    expect(parsed.schemaVersion).toBe('jinn.execution.v1');
    expect(parsed.solverType).toBe(WORK_KIND);
    expect(parsed.role).toBe('solution');
    // Honestly supplied (C7 / bridge-legacy-delivery.ts): the requestId noted via
    // `noteAttemptWorkKind` reaches the envelope's task provenance, not a placeholder.
    expect(parsed.task?.requestId).toBe(REQUEST_ID);
    expect(parsed.executor.implName).toBe('claude-code');
    expect(parsed.payload).toEqual({ prediction: 0.42 });

    // The signature is a genuine secp256k1 signature over the envelope's own declared hash,
    // verified against the exact key `syncSign` above signs with -- not a schema-shape-only check.
    expect(verifiesAgainstOurKey(parsed.signature.hash as `0x${string}`, parsed.signature.sig as `0x${string}`)).toBe(
      true,
    );
  });

  it('returns undefined for a Delivery carrying no bridge annotation', () => {
    const bare = sealDelivery({
      protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
      attempt: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      task: `sha256:${'b'.repeat(64)}`,
      outputs: [],
      outcome: 'fulfilled',
      executionIds: ['urn:uuid:22222222-3333-4444-5555-666666666666'],
      evidenceRecords: [{ family: 'execution-evidence', digest: `sha256:${'d'.repeat(64)}` }],
      createdAt: '2026-07-30T09:00:00.000Z',
    } as never);
    expect(legacyRestorationResultFromDelivery(bare)).toBeUndefined();
  });

  it('still passes the binding admission check with the bridge annotation present, on a delivery this daemon actually produced', async () => {
    // `inspectDelivery` (the schema-validating admission check) is defined in
    // `packages/marketplace/binding/src/delivery.ts` but is not re-exported from that package's
    // public `src/index.ts`, and the package publishes no subpath export — it is outside this
    // task's write scope to add one. `convergeDelivery` IS exported and calls `inspectDelivery`
    // internally before pinning, so a non-throwing `convergeDelivery` call proves the same
    // admission-schema property without reaching into the package's private surface.
    const delivery = await produceBridgedDelivery();
    const { convergeDelivery } = await import('@jinn-network/marketplace-binding');
    await expect(convergeDelivery(delivery, { pin: async () => {} })).resolves.toBeDefined();
  });
});

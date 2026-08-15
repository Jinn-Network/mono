import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cidToDigestHex } from '../../src/adapters/mech/ipfs.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import { computeMintedPoolRowV2Hash, type MintedPoolRowV2 } from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { computeRowHash } from '../../src/solver-types/_swe-rebench-v2-substrate.js';
import { signTaskV1 } from '../../src/tasks/signing.js';
import type { TaskV1 } from '../../src/types/task-document.js';
import { createBoundedIpfsJsonFetcher } from '@jinn-network/jinn-layer';
import {
  hashVettedPoolArtifact,
  type SolverNetArtifactRef,
  type SweRebenchV2VettedPoolArtifact,
  type SweRebenchV2VettedPoolArtifactEntry,
} from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import {
  createBoundedRawHfRowFetcher,
  createSweRebenchV2VerifierFactsResolver,
  resolveSweRebenchV2VerifierFacts,
  type SweRebenchV2AuthoritativeTaskBinding,
  type SweRebenchV2VerifierFactPorts,
} from '../../src/solver-types/_swe-rebench-v2-verifier-facts.js';

const INSTANCE_ID = 'acme__widget-42';
const REPO = 'acme/widget';
const BASE_COMMIT = 'a'.repeat(40);
const MANIFEST_CID = 'bafy-test-only-swe-verifier-manifest';
const VETTED_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const SEMANTICS = 'proof-semantics-v7';
const HF_DATASET = 'nebius/SWE-rebench-leaderboard';
const HF_SPLIT = '2026_07';
const F2P = ['tests/test_widget.py::test_regression'];
const P2P = ['tests/test_widget.py::test_existing'];
const CREATOR_PRIVATE_KEY = `0x${'1'.repeat(64)}` as `0x${string}`;
const FORGER_PRIVATE_KEY = `0x${'2'.repeat(64)}` as `0x${string}`;
const EVALUATOR_PRIVATE_KEY = `0x${'3'.repeat(64)}` as `0x${string}`;
const CREATOR = privateKeyToAccount(CREATOR_PRIVATE_KEY);
const FORGER = privateKeyToAccount(FORGER_PRIVATE_KEY);
const EVALUATOR = privateKeyToAccount(EVALUATOR_PRIVATE_KEY);
const CREATOR_SAFE = `0x${'1'.repeat(40)}`;
const EVALUATOR_SAFE = `0x${'3'.repeat(40)}`;

async function signedTask(over: {
  hfDataset?: string;
  hfSplit?: string;
  instanceId?: string;
  repo?: string;
  baseCommit?: string;
  eligibility?: Record<string, unknown>;
  role?: 'restoration' | 'evaluation';
  description?: string;
  manifestCid?: string;
  creatorSafe?: string;
  creatorAgentEoa?: string;
  context?: Record<string, unknown>;
} = {}, privateKey = CREATOR_PRIVATE_KEY) {
  const hfDataset = over.hfDataset ?? HF_DATASET;
  const hfSplit = over.hfSplit ?? HF_SPLIT;
  const instanceId = over.instanceId ?? INSTANCE_ID;
  const repo = over.repo ?? REPO;
  const baseCommit = over.baseCommit ?? BASE_COMMIT;
  const task: TaskV1 = {
    schemaVersion: 'task.v1',
    id: 'task-1',
    solverType: 'swe-rebench-v2.v1',
    solverNetManifestCid: over.manifestCid ?? MANIFEST_CID,
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    role: over.role ?? 'restoration',
    description: over.description ?? 'repair the widget',
    window: { startTs: 1_752_000_000_000, endTs: 1_752_003_600_000 },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: instanceId,
      repo,
      base_commit: baseCommit,
      language: 'python',
      problem_statement: 'repair the widget',
      interface: '',
      hf_dataset: hfDataset,
      hf_split: hfSplit,
      deadline_unix: 1_752_003_600,
      round_month: '2026-07',
    },
    eligibility: over.eligibility ?? {
      hf_dataset: hfDataset,
      hf_split: hfSplit,
      instance_id: instanceId,
    },
    claimPolicy: {
      mode: 'exclusive',
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 1800,
    },
    creator: {
      safeAddress: over.creatorSafe ?? CREATOR_SAFE,
      agentEoa: over.creatorAgentEoa ?? CREATOR.address,
    },
    createdAt: 1_752_000_000_000,
    ...(over.context ? { context: over.context } : {}),
  };
  return signTaskV1(task, privateKey);
}

function hfRow(over: Record<string, unknown> = {}) {
  return {
    instance_id: INSTANCE_ID,
    repo: REPO,
    base_commit: BASE_COMMIT,
    image_name: 'ghcr.io/acme/widget-eval:2026-07',
    patch: 'diff --git a/widget.py b/widget.py\n-old\n+new\n',
    test_patch: 'diff --git a/tests/test_widget.py b/tests/test_widget.py\n',
    install_config: {
      install: ['python -m pip install -e .'],
      test_cmd: ['pytest', '-q'],
      log_parser: 'parse_log_pytest',
    },
    FAIL_TO_PASS: F2P,
    PASS_TO_PASS: P2P,
    problem_statement: 'repair the widget',
    ...over,
  };
}

function hfRowHash(row = hfRow()): string {
  const installConfig = row.install_config as {
    install?: string[] | string;
    test_cmd: string[] | string;
    log_parser: string;
  };
  return computeRowHash({
    hf_dataset: HF_DATASET,
    hf_split: HF_SPLIT,
    instance_id: row.instance_id as string,
    repo: row.repo as string,
    base_commit: row.base_commit as string,
    image_name: row.image_name as string,
    patch: row.patch as string,
    test_patch: row.test_patch as string,
    install_config: {
      install: installConfig.install ?? [],
      test_cmd: installConfig.test_cmd,
      log_parser: installConfig.log_parser,
    },
    FAIL_TO_PASS: row.FAIL_TO_PASS as string[],
    PASS_TO_PASS: row.PASS_TO_PASS as string[],
  });
}

function vettedArtifact(
  entry: SweRebenchV2VettedPoolArtifactEntry,
  evalSemanticsVersion = SEMANTICS,
): SweRebenchV2VettedPoolArtifact {
  return {
    schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
    evalSemanticsVersion,
    generatedAt: '2026-07-20T00:00:00.000Z',
    entries: [entry],
  };
}

function vettedRef(artifact: SweRebenchV2VettedPoolArtifact): SolverNetArtifactRef {
  return {
    schemaVersion: 'solvernet.artifact-ref.v1',
    manifestCid: MANIFEST_CID,
    artifactType: 'swe-rebench-v2-vetted-pool.v1',
    artifactCid: VETTED_CID,
    artifactHash: hashVettedPoolArtifact(artifact),
    evalSemanticsVersion: artifact.evalSemanticsVersion,
    publishedAt: '2026-07-20T00:00:01.000Z',
  };
}

async function withRef(taskPromise: ReturnType<typeof signedTask>, ref: SolverNetArtifactRef) {
  const task = await taskPromise;
  const { signature: _signature, ...unsigned } = task;
  return signTaskV1({
    ...unsigned,
    eligibility: {
      ...task.eligibility,
      vettedPoolRef: ref,
    },
  }, CREATOR_PRIVATE_KEY);
}

function baseEntry(over: Partial<SweRebenchV2VettedPoolArtifactEntry> = {}): SweRebenchV2VettedPoolArtifactEntry {
  return {
    instance_id: INSTANCE_ID,
    scorable: true,
    reason: 'gold-patch-resolves',
    checkedAt: '2026-07-20T00:00:00.000Z',
    ...over,
  };
}

function ports(args: {
  vetted: unknown;
  minted?: unknown;
  hf?: unknown;
  task?: { cid: string; document: unknown };
}): SweRebenchV2VerifierFactPorts {
  return {
    fetchIpfsJson: vi.fn(async ({ cid }) => {
      if (cid === VETTED_CID) return args.vetted;
      if (args.task?.cid === cid) return args.task.document;
      if (args.minted !== undefined) return args.minted;
      throw new Error(`unexpected IPFS CID ${cid}`);
    }),
    fetchHfRawRow: vi.fn(async () => {
      if (args.hf === undefined) throw new Error('unexpected HF fetch');
      return args.hf;
    }),
  };
}

async function evaluationWrapper(
  solutionTaskCid: string,
  over: {
    creatorSafe?: string;
    description?: string;
    context?: Record<string, unknown>;
    instanceId?: string;
    repo?: string;
    baseCommit?: string;
  } = {},
) {
  return signedTask({
    role: 'evaluation',
    creatorSafe: over.creatorSafe ?? EVALUATOR_SAFE,
    creatorAgentEoa: EVALUATOR.address,
    description: over.description ?? 'evaluator-controlled wrapper description',
    context: over.context ?? { solutionTaskCid },
    instanceId: over.instanceId,
    repo: over.repo,
    baseCommit: over.baseCommit,
  }, EVALUATOR_PRIVATE_KEY);
}

function authoritativeTaskBinding(
  originalTaskCid: string,
  over: Partial<SweRebenchV2AuthoritativeTaskBinding> = {},
): SweRebenchV2AuthoritativeTaskBinding {
  return {
    taskCidDigest: cidToDigestHex(originalTaskCid),
    manifestDigest: keccak256(toBytes(MANIFEST_CID)),
    creatorSafe: CREATOR_SAFE,
    evaluatorSafe: EVALUATOR_SAFE,
    taskId: '42',
    chainId: 84_532,
    ...over,
  };
}

function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let accumulator = 0;
  let out = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(accumulator << (5 - bits)) & 31];
  return out;
}

function canonicalRawCid(value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value)).digest();
  return `b${base32(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}

function canonicalRawHexCid(value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return `f01551220${digest}`;
}

function v1Artifact() {
  return {
    schemaVersion: 'swe-rebench-v2-minted-pool.v1',
    evalSemanticsVersion: SEMANTICS,
    generatedAt: '2026-07-20T00:00:00.000Z',
    rows: [{
      instance_id: INSTANCE_ID,
      repo: REPO,
      base_commit: BASE_COMMIT,
      language: 'python',
      problem_statement: 'repair the widget',
      image_name: 'ghcr.io/acme/widget-eval:minted-v1',
      FAIL_TO_PASS: F2P,
      PASS_TO_PASS: P2P,
      test_patch: 'diff --git a/tests/test_widget.py b/tests/test_widget.py\n',
      install_config: {
        install: ['python -m pip install -e .'],
        test_cmd: ['pytest', '-q'],
        log_parser: 'parse_log_pytest',
      },
    }],
  };
}

const IMAGE_DIGEST = `sha256:${'5'.repeat(64)}` as const;
const ENVIRONMENT_HASH = `sha256:${'6'.repeat(64)}` as const;
const PARSER_DIGEST = `sha256:${'7'.repeat(64)}` as const;

function v2Row(): MintedPoolRowV2 {
  const row = {
    instance_id: INSTANCE_ID,
    repo: REPO,
    base_commit: BASE_COMMIT,
    language: 'python',
    problem_statement: 'repair the widget',
    image_name: `ghcr.io/acme/widget-eval@${IMAGE_DIGEST}`,
    FAIL_TO_PASS: F2P,
    PASS_TO_PASS: P2P,
    test_patch: 'diff --git a/tests/test_widget.py b/tests/test_widget.py\n',
    install_config: {
      install: ['python -m pip install -e .'],
      test_cmd: ['pytest', '-q'],
      log_parser: 'parse_log_pytest',
    },
    rowHashVersion: 2 as const,
    environment: {
      environmentSpecCid: 'bafy-test-only-swe-verifier-environment',
      environmentHash: ENVIRONMENT_HASH,
      attestation: {
        scheme: 'eip191' as const,
        algo: 'secp256k1' as const,
        environmentHash: ENVIRONMENT_HASH,
        operatorSafe: `0x${'8'.repeat(40)}`,
        signer: `0x${'9'.repeat(40)}`,
        signature: `0x${'a'.repeat(130)}`,
      },
      parser: {
        id: 'parse_log_pytest',
        version: 'v1',
        digest: PARSER_DIGEST,
        bundleId: 'jinn.swe-rebench-v2.pytest-bundle.v1',
      },
      image: {
        reference: `ghcr.io/acme/widget-eval@${IMAGE_DIGEST}`,
        digest: IMAGE_DIGEST,
      },
      platform: 'linux/amd64' as const,
    },
    publicRowHash: '' as `sha256:${string}`,
  };
  return { ...row, publicRowHash: computeMintedPoolRowV2Hash(row) };
}

function v2Artifact(row = v2Row()) {
  return {
    schemaVersion: 'swe-rebench-v2-minted-pool.v2',
    evalSemanticsVersion: SEMANTICS,
    generatedAt: '2026-07-20T00:00:00.000Z',
    rows: [row],
  };
}

function v2Admission(row = v2Row()): SweRebenchV2VettedPoolArtifactEntry {
  return baseEntry({
    rowHashVersion: 2,
    publicRowHash: row.publicRowHash,
    v2Environment: {
      environmentSpecCid: row.environment.environmentSpecCid,
      environmentHash: row.environment.environmentHash,
      parser: {
        ...row.environment.parser,
        digest: row.environment.parser.digest as `sha256:${string}`,
      },
      image: row.environment.image,
      platform: row.environment.platform,
    },
  });
}

describe('resolveSweRebenchV2VerifierFacts — Hugging Face proof', () => {
  it('returns exact verifier facts only after the row hash and vetted proof agree', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const deps = ports({ vetted: artifact, hf: row });
    const task = await withRef(signedTask(), vettedRef(artifact));
    const resolve = createSweRebenchV2VerifierFactsResolver(deps);

    await expect(resolve({
      signedTask: task,
      spec: { instance_id: 'attacker__override-1' },
      eligibility: { vettedPoolRef: 'attacker override' },
    }, INSTANCE_ID)).resolves.toEqual({
      failToPass: F2P,
      passToPass: P2P,
      evalSemanticsVersion: SEMANTICS,
      task: {
        solverType: 'swe-rebench-v2.v1',
        instanceId: INSTANCE_ID,
        repo: REPO,
        baseCommit: BASE_COMMIT,
        createdAt: 1_752_000_000_000,
      },
    });
    expect(deps.fetchHfRawRow).toHaveBeenCalledWith({
      dataset: HF_DATASET,
      split: HF_SPLIT,
      instanceId: INSTANCE_ID,
      maxBytes: 2_000_000,
    });
  });

  it('rejects when signature.hash does not authenticate the canonical unsigned task', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const task = await withRef(signedTask(), vettedRef(artifact));

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: {
        ...task,
        signature: { ...task.signature, hash: `0x${'f'.repeat(64)}` },
      },
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: row }),
    })).rejects.toThrow(/signature\.hash|canonical unsigned task/i);
  });

  it('rejects when the declared signer does not match signature recovery', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const task = await withRef(signedTask(), vettedRef(artifact));

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: {
        ...task,
        signature: { ...task.signature, signer: FORGER.address },
      },
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: row }),
    })).rejects.toThrow(/recovered signer|declared signer/i);
  });

  it('rejects a malformed secp256k1 signature', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const task = await withRef(signedTask(), vettedRef(artifact));

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: {
        ...task,
        signature: { ...task.signature, sig: '0x1234' },
      },
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: row }),
    })).rejects.toThrow(/signature recovery|signature/i);
  });

  it('rejects a valid signature whose signer is not creator.agentEoa', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const task = await withRef(signedTask(), vettedRef(artifact));
    const { signature: _signature, ...unsigned } = task;
    const forged = await signTaskV1(unsigned, FORGER_PRIVATE_KEY);

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: forged,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: row }),
    })).rejects.toThrow(/creator\.agentEoa/i);
  });

  it('rejects a tampered raw row instead of trusting its verifier arrays', async () => {
    const admitted = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(admitted) }));
    const task = await withRef(signedTask(), vettedRef(artifact));

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({
        vetted: artifact,
        hf: { ...admitted, FAIL_TO_PASS: ['tests/test_widget.py::forged'] },
      }),
    })).rejects.toThrow(/rowHash/i);
  });

  it('rejects a malformed raw row that omits a row-hash input', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const task = await withRef(signedTask(), vettedRef(artifact));
    const { patch: _patch, ...malformed } = row;

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: malformed }),
    })).rejects.toThrow(/patch/i);
  });

  it('rejects a task with no signed vetted-pool proof', async () => {
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash() }));

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: await signedTask(),
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: hfRow() }),
    })).rejects.toThrow(/vettedPoolRef/i);
  });

  it('requires the signed eligibility row identity tuple', async () => {
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash() }));
    const task = await signedTask({
      eligibility: { vettedPoolRef: vettedRef(artifact) },
    });

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: hfRow() }),
    })).rejects.toThrow(/eligibility hf_dataset/i);
  });

  it('rejects a vetted admission entry with no rowHash proof', async () => {
    const artifact = vettedArtifact(baseEntry());
    const task = await withRef(signedTask(), vettedRef(artifact));

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: hfRow() }),
    })).rejects.toThrow(/rowHash proof/i);
  });

  it('rejects a unique admission entry that is not scorable', async () => {
    const invalidArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: SEMANTICS,
      generatedAt: '2026-07-20T00:00:00.000Z',
      entries: [{
        instance_id: INSTANCE_ID,
        scorable: false,
        reason: 'ungradeable',
        checkedAt: '2026-07-20T00:00:00.000Z',
        rowHash: hfRowHash(),
      }],
    };
    const task = await withRef(signedTask(), {
      ...vettedRef(vettedArtifact(baseEntry({ rowHash: hfRowHash() }))),
      artifactHash: `sha256:${'f'.repeat(64)}`,
    });

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: invalidArtifact, hf: hfRow() }),
    })).rejects.toThrow(/invalid|unscorable/i);
  });

  it('rederives the producer hash when optional install is normalized to []', async () => {
    const row = hfRow({
      install_config: {
        test_cmd: ['pytest', '-q'],
        log_parser: 'parse_log_pytest',
      },
    });
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const task = await withRef(signedTask(), vettedRef(artifact));

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, hf: row }),
    })).resolves.toEqual({
      failToPass: F2P,
      passToPass: P2P,
      evalSemanticsVersion: SEMANTICS,
      task: {
        solverType: 'swe-rebench-v2.v1',
        instanceId: INSTANCE_ID,
        repo: REPO,
        baseCommit: BASE_COMMIT,
        createdAt: 1_752_000_000_000,
      },
    });
  });
});

describe('createSweRebenchV2VerifierFactsResolver — authoritative task lineage', () => {
  async function fixture(originalOverrides: Parameters<typeof signedTask>[0] = {}) {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const originalTask = await withRef(
      signedTask(originalOverrides),
      vettedRef(artifact),
    );
    const originalTaskCid = canonicalRawCid(originalTask);
    return {
      artifact,
      originalTask,
      originalTaskCid,
      row,
      deps: ports({
        vetted: artifact,
        hf: row,
        task: { cid: originalTaskCid, document: originalTask },
      }),
    };
  }

  it('authenticates a production evaluation wrapper and derives every task fact from the original restoration task', async () => {
    const f = await fixture();
    const wrapper = await evaluationWrapper(f.originalTaskCid, {
      description: 'forged evaluator summary',
      instanceId: 'attacker__wrapper-9',
      repo: 'attacker/wrapper',
      baseCommit: 'f'.repeat(40),
    });
    const resolve = createSweRebenchV2VerifierFactsResolver(f.deps);

    await expect(resolve(
      {
        signedTask: wrapper,
        description: 'mutable outer wrapper summary',
        spec: { problem_statement: 'mutable outer wrapper problem' },
      },
      'attacker__metadata-9',
      authoritativeTaskBinding(f.originalTaskCid),
    )).resolves.toEqual({
      failToPass: F2P,
      passToPass: P2P,
      evalSemanticsVersion: SEMANTICS,
      task: {
        solverType: 'swe-rebench-v2.v1',
        instanceId: INSTANCE_ID,
        repo: REPO,
        baseCommit: BASE_COMMIT,
        createdAt: 1_752_000_000_000,
        originalTaskCid: f.originalTaskCid,
        creatorSafe: CREATOR_SAFE,
        manifestDigest: keccak256(toBytes(MANIFEST_CID)),
        description: 'repair the widget',
      },
    });
    expect(f.deps.fetchIpfsJson).toHaveBeenCalledWith({
      cid: f.originalTaskCid,
      maxBytes: 2_000_000,
    });
  });

  it('resolves the full authoritative path with the deployed f01551220 task CID shape', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const artifactCid = canonicalRawCid(artifact);
    const artifactRef = { ...vettedRef(artifact), artifactCid };
    const originalTask = await withRef(signedTask(), artifactRef);
    const originalTaskCid = canonicalRawHexCid(originalTask);
    const wrapper = await evaluationWrapper(originalTaskCid);
    const wrapperCid = canonicalRawHexCid(wrapper);
    const uploadedJcs = new Map([
      [wrapperCid, canonicalJson(wrapper)],
      [originalTaskCid, canonicalJson(originalTask)],
      [artifactCid, canonicalJson(artifact)],
    ]);
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl: vi.fn(async (input) => {
        const cid = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1)!);
        const bytes = uploadedJcs.get(cid);
        if (bytes === undefined) return new Response('not found', { status: 404 });
        return new Response(bytes);
      }),
    });
    const deps: SweRebenchV2VerifierFactPorts = {
      fetchIpfsJson: ({ cid, maxBytes }) => fetchIpfs(cid, maxBytes),
      fetchHfRawRow: vi.fn(async () => row),
    };
    const fetchedWrapper = await fetchIpfs(wrapperCid);

    await expect(createSweRebenchV2VerifierFactsResolver(deps)(
      fetchedWrapper,
      INSTANCE_ID,
      authoritativeTaskBinding(originalTaskCid),
    )).resolves.toMatchObject({
      failToPass: F2P,
      passToPass: P2P,
      task: {
        originalTaskCid,
        instanceId: INSTANCE_ID,
        creatorSafe: CREATOR_SAFE,
      },
    });
  });

  it('rejects requested task CID A when the IPFS port returns valid signed task B', async () => {
    const row = hfRow();
    const artifact = vettedArtifact(baseEntry({ rowHash: hfRowHash(row) }));
    const taskA = await withRef(
      signedTask({ description: 'creator-authored task A' }),
      vettedRef(artifact),
    );
    const taskB = await withRef(
      signedTask({ description: 'creator-authored task B' }),
      vettedRef(artifact),
    );
    const taskACid = canonicalRawHexCid(taskA);
    const deps = ports({
      vetted: artifact,
      hf: row,
      task: { cid: taskACid, document: taskB },
    });
    const wrapper = await evaluationWrapper(taskACid);

    await expect(createSweRebenchV2VerifierFactsResolver(deps)(
      { signedTask: wrapper },
      INSTANCE_ID,
      authoritativeTaskBinding(taskACid),
    )).rejects.toThrow(/original task.*content digest.*CID/i);
  });

  it('rejects a dag-pb CID for the authoritative original-task hop', async () => {
    const f = await fixture();
    const dagPbCid = 'bafybeigdyrzt5sfp7udm7hu76ylb7d7zquc6c6j3f2r5t7yqf3w5m4rj3u';
    const wrapper = await evaluationWrapper(dagPbCid);

    await expect(createSweRebenchV2VerifierFactsResolver(f.deps)(
      { signedTask: wrapper },
      INSTANCE_ID,
      authoritativeTaskBinding(dagPbCid),
    )).rejects.toThrow(/original task CID.*raw CIDv1/i);
    expect(f.deps.fetchIpfsJson).not.toHaveBeenCalledWith({
      cid: dagPbCid,
      maxBytes: 2_000_000,
    });
  });

  it('rejects a forged solutionTaskCid added after the evaluator signed the wrapper', async () => {
    const f = await fixture();
    const wrapper = await evaluationWrapper(f.originalTaskCid);
    const forgedTaskCid = canonicalRawCid({ forged: true });

    await expect(createSweRebenchV2VerifierFactsResolver(f.deps)(
      {
        signedTask: {
          ...wrapper,
          context: { solutionTaskCid: forgedTaskCid },
        },
      },
      INSTANCE_ID,
      authoritativeTaskBinding(f.originalTaskCid),
    )).rejects.toThrow(/evaluation wrapper.*signature\.hash|canonical unsigned task/i);
  });

  it('rejects a signed wrapper whose original task CID digest is not TaskCreated.taskCidDigest', async () => {
    const f = await fixture();
    const wrapper = await evaluationWrapper(f.originalTaskCid);

    await expect(createSweRebenchV2VerifierFactsResolver(f.deps)(
      { signedTask: wrapper },
      INSTANCE_ID,
      authoritativeTaskBinding(f.originalTaskCid, {
        taskCidDigest: `0x${'f'.repeat(64)}`,
      }),
    )).rejects.toThrow(/task CID digest.*TaskCreated/i);
    expect(f.deps.fetchIpfsJson).not.toHaveBeenCalledWith({
      cid: f.originalTaskCid,
      maxBytes: 2_000_000,
    });
  });

  it('rejects an evaluator-signed wrapper whose creator Safe is not the on-chain evaluator', async () => {
    const f = await fixture();
    const wrapper = await evaluationWrapper(f.originalTaskCid, {
      creatorSafe: `0x${'9'.repeat(40)}`,
    });

    await expect(createSweRebenchV2VerifierFactsResolver(f.deps)(
      { signedTask: wrapper },
      INSTANCE_ID,
      authoritativeTaskBinding(f.originalTaskCid),
    )).rejects.toThrow(/evaluation wrapper creator.*on-chain evaluator/i);
  });

  it('rejects an authenticated original task whose creator Safe is not TaskCreated.creator', async () => {
    const f = await fixture({ creatorSafe: `0x${'9'.repeat(40)}` });
    const wrapper = await evaluationWrapper(f.originalTaskCid);

    await expect(createSweRebenchV2VerifierFactsResolver(f.deps)(
      { signedTask: wrapper },
      INSTANCE_ID,
      authoritativeTaskBinding(f.originalTaskCid),
    )).rejects.toThrow(/original task creator.*TaskCreated creator/i);
  });

  it('rejects an authenticated original task whose manifest does not match TaskCreated.manifestDigest', async () => {
    const f = await fixture({ manifestCid: 'bafy-other-solvernet-manifest' });
    const wrapper = await evaluationWrapper(f.originalTaskCid);

    await expect(createSweRebenchV2VerifierFactsResolver(f.deps)(
      { signedTask: wrapper },
      INSTANCE_ID,
      authoritativeTaskBinding(f.originalTaskCid),
    )).rejects.toThrow(/original task manifest.*TaskCreated manifestDigest/i);
  });

  it('rejects an authenticated original task that is not a restoration task', async () => {
    const f = await fixture({ role: 'evaluation' });
    const wrapper = await evaluationWrapper(f.originalTaskCid);

    await expect(createSweRebenchV2VerifierFactsResolver(f.deps)(
      { signedTask: wrapper },
      INSTANCE_ID,
      authoritativeTaskBinding(f.originalTaskCid),
    )).rejects.toThrow(/original task.*role=restoration/i);
  });
});

describe('createBoundedRawHfRowFetcher', () => {
  const immediateLimiter = {
    schedule: <T>(fn: () => Promise<T>) => fn(),
  };

  function hfResponse(rows: unknown[], status = 200): Response {
    return new Response(JSON.stringify({ rows: rows.map((row) => ({ row })) }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('walks bounded pages without projecting away row-hash inputs', async () => {
    const target = hfRow();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(hfResponse([{ ...target, instance_id: 'other__repo-1' }]))
      .mockResolvedValueOnce(hfResponse([target]));
    const fetchRaw = createBoundedRawHfRowFetcher({
      pageSize: 1,
      maxRows: 2,
      fetchImpl,
      retryBackoffMs: [],
      minRequestIntervalMs: 0,
      limiter: immediateLimiter,
    });

    await expect(fetchRaw({
      dataset: HF_DATASET,
      split: HF_SPLIT,
      instanceId: INSTANCE_ID,
      maxBytes: 20_000,
    })).resolves.toEqual(target);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toContain('offset=0');
    expect(fetchImpl.mock.calls[1]![0]).toContain('offset=1');
  });

  it('uses the shared retry policy for transient HF responses', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(hfResponse([hfRow()]));
    const fetchRaw = createBoundedRawHfRowFetcher({
      pageSize: 1,
      maxRows: 1,
      fetchImpl,
      retryBackoffMs: [0],
      minRequestIntervalMs: 0,
      sleep,
      limiter: immediateLimiter,
      random: () => 0.5,
    });

    await expect(fetchRaw({
      dataset: HF_DATASET,
      split: HF_SPLIT,
      instanceId: INSTANCE_ID,
      maxBytes: 20_000,
    })).resolves.toMatchObject({ patch: hfRow().patch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('rejects a page as soon as its decoded body exceeds the byte cap', async () => {
    const fetchRaw = createBoundedRawHfRowFetcher({
      pageSize: 1,
      maxRows: 1,
      fetchImpl: vi.fn(async () => hfResponse([hfRow()])),
      retryBackoffMs: [],
      minRequestIntervalMs: 0,
      limiter: immediateLimiter,
    });

    await expect(fetchRaw({
      dataset: HF_DATASET,
      split: HF_SPLIT,
      instanceId: INSTANCE_ID,
      maxBytes: 32,
    })).rejects.toThrow(/byte cap|too large/i);
  });

  it('aborts a hung HF request under the per-attempt timeout', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      if (!observedSignal) {
        return Promise.reject(new Error('missing timeout signal'));
      }
      const signal = observedSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
    });
    const fetchRaw = createBoundedRawHfRowFetcher({
      pageSize: 1,
      maxRows: 1,
      requestTimeoutMs: 5,
      fetchImpl,
      retryBackoffMs: [],
      minRequestIntervalMs: 0,
      limiter: immediateLimiter,
    });

    await expect(fetchRaw({
      dataset: HF_DATASET,
      split: HF_SPLIT,
      instanceId: INSTANCE_ID,
      maxBytes: 20_000,
    })).rejects.toThrow(/abort|timeout/i);
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe('resolveSweRebenchV2VerifierFacts — minted v1 proof', () => {
  it('rejects a malformed signed minted CID before the minted artifact fetch', async () => {
    const artifact = vettedArtifact(baseEntry());
    const task = await withRef(
      signedTask({
        hfDataset: 'ipfs://notacid',
        hfSplit: 'minted',
      }),
      vettedRef(artifact),
    );
    const deps = ports({ vetted: artifact, minted: v1Artifact() });

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: deps,
    })).rejects.toThrow(/valid IPFS CID/i);
    expect(deps.fetchIpfsJson).toHaveBeenCalledTimes(1);
  });

  it('rejects a CID-bound v1 artifact because it has no admission-row binding', async () => {
    const minted = v1Artifact();
    const cid = canonicalRawCid(minted);
    const artifact = vettedArtifact(baseEntry());
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      vettedRef(artifact),
    );
    const deps = ports({ vetted: artifact, minted });

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: deps,
    })).rejects.toThrow(/minted v1.*admission.*binding/i);
    expect(deps.fetchIpfsJson).toHaveBeenCalledWith({
      cid,
      maxBytes: 2_000_000,
    });
  });

  it('rejects minted content whose canonical digest is not the signed CID', async () => {
    const original = v1Artifact();
    const cid = canonicalRawCid(original);
    const artifact = vettedArtifact(baseEntry());
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      vettedRef(artifact),
    );
    const tampered = {
      ...original,
      rows: [{ ...original.rows[0]!, FAIL_TO_PASS: ['tests/test_widget.py::forged'] }],
    };

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, minted: tampered }),
    })).rejects.toThrow(/CID|digest/i);
  });

  it('rejects a v1 row whose task identity does not match the signed task', async () => {
    const original = v1Artifact();
    const minted = {
      ...original,
      rows: [{ ...original.rows[0]!, base_commit: 'b'.repeat(40) }],
    };
    const cid = canonicalRawCid(minted);
    const artifact = vettedArtifact(baseEntry());
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      vettedRef(artifact),
    );

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, minted }),
    })).rejects.toThrow(/base_commit/i);
  });

  it('rejects a v1 row whose language does not match the signed task', async () => {
    const original = v1Artifact();
    const minted = {
      ...original,
      rows: [{ ...original.rows[0]!, language: 'typescript' }],
    };
    const cid = canonicalRawCid(minted);
    const artifact = vettedArtifact(baseEntry());
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      vettedRef(artifact),
    );

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, minted }),
    })).rejects.toThrow(/language/i);
  });

  it('rejects v1 artifact semantics that disagree with the signed proof', async () => {
    const minted = { ...v1Artifact(), evalSemanticsVersion: 'other-semantics' };
    const cid = canonicalRawCid(minted);
    const artifact = vettedArtifact(baseEntry());
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      vettedRef(artifact),
    );

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, minted }),
    })).rejects.toThrow(/semantics/i);
  });
});

describe('resolveSweRebenchV2VerifierFacts — minted v2 proof', () => {
  it('returns exact verifier facts from a CID-bound, admitted v2 row', async () => {
    const row = v2Row();
    const minted = v2Artifact(row);
    const cid = canonicalRawCid(minted);
    const artifact = vettedArtifact(v2Admission(row));
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      vettedRef(artifact),
    );

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, minted }),
    })).resolves.toEqual({
      failToPass: F2P,
      passToPass: P2P,
      evalSemanticsVersion: SEMANTICS,
      task: {
        solverType: 'swe-rebench-v2.v1',
        instanceId: INSTANCE_ID,
        repo: REPO,
        baseCommit: BASE_COMMIT,
        createdAt: 1_752_000_000_000,
      },
    });
  });

  it('rejects a v2 artifact with a forged publicRowHash', async () => {
    const row = v2Row();
    const minted = v2Artifact({
      ...row,
      publicRowHash: `sha256:${'f'.repeat(64)}`,
    });
    const cid = canonicalRawCid(minted);
    const artifact = vettedArtifact(v2Admission(row));
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      vettedRef(artifact),
    );

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, minted }),
    })).rejects.toThrow(/publicRowHash/i);
  });

  it('rejects a v2 row whose vetted admission environment does not match', async () => {
    const row = v2Row();
    const minted = v2Artifact(row);
    const cid = canonicalRawCid(minted);
    const artifact = vettedArtifact(v2Admission(row));
    artifact.entries[0] = {
      ...artifact.entries[0]!,
      v2Environment: {
        ...artifact.entries[0]!.v2Environment!,
        environmentHash: `sha256:${'e'.repeat(64)}`,
      },
    };
    const ref = vettedRef(artifact);
    const task = await withRef(
      signedTask({ hfDataset: `ipfs://${cid}`, hfSplit: 'minted' }),
      ref,
    );

    await expect(resolveSweRebenchV2VerifierFacts({
      signedTask: task,
      expectedInstanceId: INSTANCE_ID,
      ports: ports({ vetted: artifact, minted }),
    })).rejects.toThrow(/admission|environment/i);
  });
});

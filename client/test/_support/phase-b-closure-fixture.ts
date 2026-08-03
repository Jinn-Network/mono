import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  PHASE_B_RECORD_ROOT_SET,
  PHASE_B_RESTART_CHECKPOINT_SET,
  PHASE_B_ROLE_SET,
  PHASE_B_SOURCE_ROLE_SET,
  type PhaseBClosureManifest,
} from '../../src/daemon/phase-b-closure-manifest.js';

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

function tx(index: number): `0x${string}` {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

export function phaseBClosureFixture(): PhaseBClosureManifest {
  const actorForRole: Record<(typeof PHASE_B_ROLE_SET)[number], string> = {
    'requester-submission': 'requester',
    admission: 'admission',
    'requester-discovery': 'requester',
    'solver-delivery': 'solver',
    'solver-settlement': 'solver',
    'solver-discovery': 'solver',
    'evaluator-verdict': 'evaluator',
    'evaluator-settlement': 'evaluator',
    'evaluator-discovery': 'evaluator',
  };
  return {
    schemaVersion: 1,
    kind: 'jinn.phase-b-native-vertical-closure',
    liveRun: true,
    commit: 'a'.repeat(40),
    createdAt: '2026-08-02T12:00:00.000Z',
    chain: BASE_SEPOLIA_TODAY,
    packageTarballs: [
      { name: '@jinn-network/marketplace-binding', digest: digest(1) },
      { name: '@jinn-network/task-execution-backend-local', digest: digest(2) },
    ],
    build: {
      b9PlatformManifestDigest: digest(3),
      b9NativeAcceptanceManifestDigest: digest(4),
      productDigest: digest(5),
      infrastructureBundleDigest: digest(6),
    },
    publicRoles: PHASE_B_ROLE_SET.map((role, index) => ({
      role,
      agent: `urn:jinn:agent:${actorForRole[role]}`,
      keyId: `did:key:z${'23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[index]!.repeat(44)}`,
      bindingDigest: digest(20 + index),
    })),
    sourceHeads: PHASE_B_SOURCE_ROLE_SET.map((role, index) => ({
      role,
      agent: `urn:jinn:agent:${role}`,
      name: `${role}-records`,
      sequence: String(index + 1).padStart(16, '0'),
      entryDigest: digest(40 + index),
    })),
    recordRoots: PHASE_B_RECORD_ROOT_SET.map((role, index) => ({ role, digest: digest(60 + index) })),
    settlements: {
      solution: {
        operationId: digest(100), transactionHash: tx(101), blockHash: tx(102),
        blockNumber: '123456', finalized: true,
        baseScanUrl: `https://sepolia.basescan.org/tx/${tx(101)}`,
      },
      verdict: {
        operationId: digest(110), transactionHash: tx(111), blockHash: tx(112),
        blockNumber: '123470', finalized: true,
        baseScanUrl: `https://sepolia.basescan.org/tx/${tx(111)}`,
      },
    },
    recoveryReports: PHASE_B_RESTART_CHECKPOINT_SET.map((checkpoint, index) => ({
      checkpoint,
      digest: digest(130 + index),
    })),
    consumerReportDigest: digest(150),
    configDigest: digest(151),
    acceptanceCriteria: Array.from({ length: 62 }, (_, index) => ({
      id: index + 1,
      status: 'passed' as const,
      evidence: [digest(200 + index)],
    })),
  };
}

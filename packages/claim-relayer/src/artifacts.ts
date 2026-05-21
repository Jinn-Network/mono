import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, type Address } from 'viem';

export interface ArtifactAddresses {
  l1ArtifactPath: string;
  l2ArtifactPath: string;
  distributor: Address;
  messenger: Address;
  claimEmitter: Address;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

export const DEFAULT_L1_ARTIFACT = path.join(
  REPO_ROOT,
  'client',
  'deployments',
  'deployment-jinn-mvi-l1-sepolia.json',
);

export const DEFAULT_L2_ARTIFACT = path.join(
  REPO_ROOT,
  'client',
  'deployments',
  'deployment-jinn-mvi-l2-baseSepolia.json',
);

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`deployment artifact not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pickString(root: unknown, paths: string[][]): string | undefined {
  for (const segments of paths) {
    let cursor: unknown = root;
    for (const segment of segments) {
      cursor = asRecord(cursor)[segment];
    }
    if (typeof cursor === 'string') return cursor;
  }
  return undefined;
}

function pickAddress(root: unknown, label: string, paths: string[][]): Address {
  const value = pickString(root, paths);
  if (!value || !isAddress(value)) {
    throw new Error(`could not resolve ${label} address from deployment artifact`);
  }
  return getAddress(value);
}

export function loadArtifactAddresses(options: {
  l1ArtifactPath?: string;
  l2ArtifactPath?: string;
  distributorAddress?: string;
  messengerAddress?: string;
  claimEmitterAddress?: string;
} = {}): ArtifactAddresses {
  const l1ArtifactPath = path.resolve(options.l1ArtifactPath ?? DEFAULT_L1_ARTIFACT);
  const l2ArtifactPath = path.resolve(options.l2ArtifactPath ?? DEFAULT_L2_ARTIFACT);
  const distributorOverride = options.distributorAddress && isAddress(options.distributorAddress)
    ? getAddress(options.distributorAddress)
    : undefined;
  const messengerOverride = options.messengerAddress && isAddress(options.messengerAddress)
    ? getAddress(options.messengerAddress)
    : undefined;
  const claimEmitterOverride = options.claimEmitterAddress && isAddress(options.claimEmitterAddress)
    ? getAddress(options.claimEmitterAddress)
    : undefined;
  const l1 = distributorOverride && messengerOverride ? undefined : readJson(l1ArtifactPath);
  const l2 = claimEmitterOverride ? undefined : readJson(l2ArtifactPath);

  return {
    l1ArtifactPath,
    l2ArtifactPath,
    distributor: distributorOverride
      ? distributorOverride
      : pickAddress(l1, 'JinnDistributor', [
          ['contracts', 'JinnDistributor'],
          ['JinnDistributor'],
          ['distributor', 'address'],
          ['distributor'],
        ]),
    messenger: messengerOverride
      ? messengerOverride
      : pickAddress(l1, 'MockMessenger', [
          ['contracts', 'Messenger'],
          ['contracts', 'MockMessenger'],
          ['messenger', 'address'],
          ['MockMessenger'],
          ['Messenger'],
        ]),
    claimEmitter: claimEmitterOverride
      ? claimEmitterOverride
      : pickAddress(l2, 'TaskClaimEmitter', [
          ['contracts', 'TaskClaimEmitter'],
          ['taskClaimEmitter', 'address'],
          ['TaskClaimEmitter'],
        ]),
  };
}

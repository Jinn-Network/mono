import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { JinnConfig } from '../config.js';
import { DEFAULT_TESTNET_ARTIFACTS } from '../earning/contracts.js';

export interface DeploymentArtifactRow {
  name: string;
  path: string;
  sha256: string;
}

export function computeDeploymentDigest(config: JinnConfig): {
  digest: string;
  artifacts: DeploymentArtifactRow[];
} {
  const isTestnet = config.network === 'testnet';
  const candidates: Array<{ name: string; path: string | undefined }> = [
    {
      name: 'testnetL2',
      path: config.testnetL2DeploymentPath ?? (isTestnet ? DEFAULT_TESTNET_ARTIFACTS.l2 : undefined),
    },
    {
      name: 'testnetL2Token',
      path:
        config.testnetL2TokenDeploymentPath ??
        (isTestnet ? DEFAULT_TESTNET_ARTIFACTS.token : undefined),
    },
    {
      name: 'testnetMech',
      path:
        config.testnetMechDeploymentPath ?? (isTestnet ? DEFAULT_TESTNET_ARTIFACTS.mech : undefined),
    },
    {
      name: 'testnetStolas',
      path:
        config.testnetStolasDeploymentPath ??
        (isTestnet ? DEFAULT_TESTNET_ARTIFACTS.stolas : undefined),
    },
  ];

  const artifacts: DeploymentArtifactRow[] = [];
  const pieces: string[] = [];

  for (const { name, path } of candidates) {
    if (!path || !existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    artifacts.push({ name, path, sha256 });
    pieces.push(`${name}:${sha256}`);
  }

  const digest =
    pieces.length > 0
      ? createHash('sha256').update([...pieces].sort().join('|')).digest('hex')
      : 'unknown';

  return { digest, artifacts };
}

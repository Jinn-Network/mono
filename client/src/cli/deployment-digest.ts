import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { JinnConfig } from '../config.js';

export interface DeploymentArtifactRow {
  name: string;
  path: string;
  sha256: string;
}

export function computeDeploymentDigest(config: JinnConfig): {
  digest: string;
  artifacts: DeploymentArtifactRow[];
} {
  const candidates: Array<{ name: string; path: string | undefined }> = [
    { name: 'testnetL2', path: config.testnetL2DeploymentPath },
    { name: 'testnetL2Token', path: config.testnetL2TokenDeploymentPath },
    { name: 'testnetMech', path: config.testnetMechDeploymentPath },
    { name: 'testnetStolas', path: config.testnetStolasDeploymentPath },
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

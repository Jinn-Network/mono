/**
 * `jinn checkpoint publish` / `install` / `list` — HarnessCheckpoint
 * lifecycle CLI verbs.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7
 */

import { HarnessCheckpointManifestSchema, type HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';

export interface CheckpointPublishDeps {
  pinToIpfs(args: { kind: 'sourceBundle' | 'implStateDir' | 'manifest'; data: Buffer | string }): Promise<string>;
  callSetMetadata(args: { metadataKey: string; payload: string }): Promise<{ txHash: string; blockNumber: number }>;
  hashImplStateDir(dirPath: string): Promise<string>;
  sign(canonicalJson: string): Promise<string>;
  getSigningIdentity(): Promise<{
    agentId: string;
    signingKey: string;
    safeAddress: string;
  }>;
}

export async function checkpointPublishCommand(args: {
  name: string;
  version: string;
  implStateDir: string;
  sourceBundleCid: string;
  implName: string;
  implVersion: string;
  clientGitSha: string;
  parentCheckpointCid?: string | null;
  deps: CheckpointPublishDeps;
}): Promise<{ checkpointCid: string; manifest: HarnessCheckpointManifest }> {
  const codeDigest = `sha256:${await args.deps.hashImplStateDir(args.implStateDir)}`;
  const implStateDirCid = await args.deps.pinToIpfs({ kind: 'implStateDir', data: '' });
  const publisher = await args.deps.getSigningIdentity();

  const core = {
    schemaVersion: 'harness.checkpoint.v1' as const,
    name: args.name,
    version: args.version,
    parentCheckpointCid: args.parentCheckpointCid ?? null,
    harnessPackage: {
      implName: args.implName,
      implVersion: args.implVersion,
      clientGitSha: args.clientGitSha,
      sourceBundleCid: args.sourceBundleCid,
    },
    implStateDirCid,
    codeDigest,
    publisher,
    publishedAt: new Date().toISOString(),
  };

  const canonicalJson = canonicalize(core);
  const signature = await args.deps.sign(canonicalJson);

  const manifestPayload = JSON.stringify({ ...core, signature, registry: null });
  const manifestPinCid = await args.deps.pinToIpfs({ kind: 'manifest', data: manifestPayload });
  const tx = await args.deps.callSetMetadata({
    metadataKey: `harness.checkpoint:${manifestPinCid}`,
    payload: manifestPinCid,
  });

  const final: HarnessCheckpointManifest = {
    ...core,
    signature,
    registry: {
      anchor: 'IdentityRegistry.setMetadata',
      metadataKey: `harness.checkpoint:${manifestPinCid}`,
      txHash: tx.txHash as `0x${string}`,
      blockNumber: tx.blockNumber,
    },
  };

  HarnessCheckpointManifestSchema.parse(final);

  return { checkpointCid: manifestPinCid, manifest: final };
}

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as any)[k])}`).join(',')}}`;
}

export interface CheckpointListDeps {
  listLocallyPublished(): Promise<Array<{ cid: string; name: string; version: string }>>;
  listLocallyInstalled(): Promise<Array<{ cid: string; name: string; version: string }>>;
}

export async function checkpointListCommand(args: {
  deps: CheckpointListDeps;
}): Promise<{
  published: Array<{ cid: string; name: string; version: string }>;
  installed: Array<{ cid: string; name: string; version: string }>;
}> {
  const [published, installed] = await Promise.all([
    args.deps.listLocallyPublished(),
    args.deps.listLocallyInstalled(),
  ]);
  return { published, installed };
}

export interface CheckpointInstallDeps {
  fetchFromIpfs(cid: string): Promise<string>;
  verifySignature(args: { manifest: HarnessCheckpointManifest; signature: string }): Promise<boolean>;
  fetchImplStateDirToLocal(implStateDirCid: string, targetDir: string): Promise<string>;
  stageAsHarnessState(stagedDir: string, implName: string): Promise<void>;
}

export async function checkpointInstallCommand(args: {
  cid: string;
  deps: CheckpointInstallDeps;
  targetDir?: string;
}): Promise<{ installed: true; codeDigest: string; implName: string }> {
  const manifestRaw = await args.deps.fetchFromIpfs(args.cid);
  const manifest = HarnessCheckpointManifestSchema.parse(JSON.parse(manifestRaw));
  const ok = await args.deps.verifySignature({ manifest, signature: manifest.signature });
  if (!ok) throw new Error(`Checkpoint ${args.cid}: invalid signature`);

  const stagingDir = args.targetDir ?? `/tmp/checkpoint-${args.cid}`;
  await args.deps.fetchImplStateDirToLocal(manifest.implStateDirCid, stagingDir);
  await args.deps.stageAsHarnessState(stagingDir, manifest.harnessPackage.implName);

  return { installed: true, codeDigest: manifest.codeDigest, implName: manifest.harnessPackage.implName };
}

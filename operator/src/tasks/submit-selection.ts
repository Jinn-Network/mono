import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod/v3';
import { canonicalJson } from '../util/canonical-json.js';

const MarketplaceTaskSelectionSchema = z.object({
  schemaVersion: z.literal('jinn-task-submit-selection.v1'),
  requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  solverNetManifestCid: z.string().min(1),
  solverNetName: z.string().min(1).optional(),
}).strict();

export type MarketplaceTaskSelection = z.infer<typeof MarketplaceTaskSelectionSchema>;

function canonicalRequestDigest(request: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(request)).digest('hex')}`;
}

function assertSelectionMatchesRequest(
  request: unknown,
  selection: MarketplaceTaskSelection,
): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return;
  const fields = request as {
    solverNetManifestCid?: unknown;
    solverNet?: unknown;
  };
  if (
    typeof fields.solverNetManifestCid === 'string'
    && fields.solverNetManifestCid !== selection.solverNetManifestCid
  ) {
    throw new Error(
      `Task selection ${selection.solverNetManifestCid} contradicts request SolverNet CID ` +
      fields.solverNetManifestCid,
    );
  }
  if (
    typeof fields.solverNet === 'string'
    && fields.solverNet !== selection.solverNetName
  ) {
    throw new Error(
      `Task selection name ${selection.solverNetName ?? '<missing>'} contradicts request SolverNet name ` +
      fields.solverNet,
    );
  }
}

export function marketplaceTaskSelectionSidecarPath(requestPath: string): string {
  return `${resolve(requestPath)}.solvernet-selection.json`;
}

export function readMarketplaceTaskSelection(args: {
  requestPath: string;
  request: unknown;
}): MarketplaceTaskSelection | null {
  const sidecarPath = marketplaceTaskSelectionSidecarPath(args.requestPath);
  if (!existsSync(sidecarPath)) return null;
  const selection = MarketplaceTaskSelectionSchema.parse(
    JSON.parse(readFileSync(sidecarPath, 'utf8')),
  );
  const requestDigest = canonicalRequestDigest(args.request);
  if (selection.requestDigest !== requestDigest) {
    throw new Error(
      `Task selection sidecar request digest mismatch for ${sidecarPath}; refusing to reuse it`,
    );
  }
  assertSelectionMatchesRequest(args.request, selection);
  return selection;
}

export function writeMarketplaceTaskSelection(args: {
  requestPath: string;
  request: unknown;
  solverNetManifestCid: string;
  solverNetName?: string;
}): MarketplaceTaskSelection {
  const sidecarPath = marketplaceTaskSelectionSidecarPath(args.requestPath);
  const selection = MarketplaceTaskSelectionSchema.parse({
    schemaVersion: 'jinn-task-submit-selection.v1',
    requestDigest: canonicalRequestDigest(args.request),
    solverNetManifestCid: args.solverNetManifestCid,
    ...(args.solverNetName ? { solverNetName: args.solverNetName } : {}),
  });
  assertSelectionMatchesRequest(args.request, selection);
  const existing = readMarketplaceTaskSelection(args);
  if (existing) {
    if (
      existing.solverNetManifestCid !== selection.solverNetManifestCid
      || existing.solverNetName !== selection.solverNetName
    ) {
      throw new Error(
        `Task request is already frozen to a different SolverNet selection in ${sidecarPath}`,
      );
    }
    return existing;
  }

  const temporaryPath = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${canonicalJson(selection)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    linkSync(temporaryPath, sidecarPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = readMarketplaceTaskSelection(args);
    if (
      !raced
      || raced.solverNetManifestCid !== selection.solverNetManifestCid
      || raced.solverNetName !== selection.solverNetName
    ) {
      throw new Error(
        `Task request was concurrently frozen to a different SolverNet selection in ${sidecarPath}`,
      );
    }
    return raced;
  } finally {
    unlinkSync(temporaryPath);
  }
  return selection;
}

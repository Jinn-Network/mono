import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod/v3';

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

const ShapeSchema = z.enum(['current', 'pre-fleet']);
const RoleSchema = z.enum(['launcher', 'participant', 'legacy-backup']);
const NetworkSchema = z.enum(['base-sepolia', 'base']);

const OperatorSchema = z.object({
  masterAddress: AddressSchema,
  fleetAgentId: z.string().nullable(),
  fleetSafeAddress: AddressSchema.nullable(),
  fleetStage: z.string().nullable(),
  serviceId: z.number().int().positive(),
  serviceStep: z.string(),
  agentEoa: AddressSchema,
  safeAddress: AddressSchema,
  mechAddress: AddressSchema,
  stakingAddress: AddressSchema,
  identityRegistry: AddressSchema,
});

const ConfigSchema = z.object({
  apiPort: z.number().int().positive(),
  // string OR multi-provider fallback chain (#592). The substrate doctor
  // (substrate-provision.ts) expects/produces the array form, so the manifest
  // schema + downstream RPC construction must accept it too.
  rpcUrl: z.union([z.string().url(), z.array(z.string().url()).min(1)]),
  joinedSolverNets: z.array(z.string()),
});

export const ManifestSchema = z.object({
  substrateVersion: z.literal('1'),
  createdAt: z.string().datetime(),
  adoptedFrom: z.string(),
  name: z.string(),
  shape: ShapeSchema,
  role: RoleSchema,
  network: NetworkSchema,
  operator: OperatorSchema,
  config: ConfigSchema,
});

export type Manifest = z.infer<typeof ManifestSchema>;

/** Result of a non-throwing manifest load — see loadManifestSafe. */
export type LoadManifestResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; error: string };

/**
 * Load and validate an operator's manifest.json without throwing.
 * Returns a structured failure (file missing, bad JSON, schema mismatch)
 * so callers that accumulate diagnostics can branch on it.
 */
export async function loadManifestSafe(opDir: string): Promise<LoadManifestResult> {
  const manifestPath = path.join(opDir, 'manifest.json');

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return { ok: false, error: `manifest.json not found at ${manifestPath}` };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (err) {
    return { ok: false, error: `manifest.json is not valid JSON: ${(err as Error).message}` };
  }

  const parsed = ManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    return { ok: false, error: `manifest.json failed schema validation: ${parsed.error.message}` };
  }
  return { ok: true, manifest: parsed.data };
}

/** Load and validate an operator's manifest.json, throwing on any problem. */
export async function loadManifest(opDir: string): Promise<Manifest> {
  const result = await loadManifestSafe(opDir);
  if (!result.ok) throw new Error(result.error);
  return result.manifest;
}

export interface VerifyResult {
  opName: string;
  ok: boolean;
  failures: string[];           // each entry describes one failed check
  warnings: string[];           // each entry describes a non-blocking concern
  onChain: {
    boundSafeAddress: string | null;
    ethBalanceWei: bigint;
    olasBalanceWei: bigint | null;
  } | null;                     // null if on-chain check was skipped
}

/** A VerifyResult with its on-chain bigint balances rendered as strings. */
export interface SerializedVerifyResult extends Omit<VerifyResult, 'onChain'> {
  onChain: {
    boundSafeAddress: string | null;
    ethBalanceWei: string;
    olasBalanceWei: string | null;
  } | null;
}

/** Render a VerifyResult to a JSON-safe shape (bigint balances → strings). */
export function serializeVerifyResult(result: VerifyResult): SerializedVerifyResult {
  return {
    ...result,
    onChain: result.onChain
      ? {
          ...result.onChain,
          ethBalanceWei: result.onChain.ethBalanceWei.toString(),
          olasBalanceWei: result.onChain.olasBalanceWei?.toString() ?? null,
        }
      : null,
  };
}

export interface TopupResult {
  opName: string;
  needs: { resource: 'ETH' | 'USDC'; have: bigint; want: bigint }[];
  ok: boolean;                  // true if all balances above their topup-trigger threshold
}

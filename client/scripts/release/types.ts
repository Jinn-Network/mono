import { z } from 'zod';

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
  rpcUrl: z.string().url(),
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

export interface TopupResult {
  opName: string;
  needs: { resource: 'ETH' | 'USDC'; have: bigint; want: bigint }[];
  ok: boolean;                  // true if all balances above their topup-trigger threshold
}

/**
 * The independent native-vertical consumer's configuration surface.
 *
 * By construction this schema admits ONLY public discovery endpoints (source base URLs), a
 * public trust-roots catalog file (signed bindings/policies/anchors -- never a private key), an
 * RPC URL, and the consumer's OWN state directory. `.strict()` at every object level means an
 * unrecognized key -- e.g. a producer's `stateDir`, an identity/keystore path, a password -- is a
 * parse error, not a silently-ignored extra field. There is no field shaped like a producer path
 * for a well-behaved caller to accidentally fill in, and a malicious or careless caller cannot add
 * one without the config failing to parse.
 */
import { AgentIriSchema, DidKeySchema } from '@jinn-network/trust-core';
import { z } from 'zod';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);

function absolutePath(label: string) {
  return z.string().min(1).refine((value) => value.startsWith('/'), `${label} must be an absolute path`);
}

const SourceRefSchema = z.object({
  agent: AgentIriSchema,
  name: z.string().min(1),
  publicBaseUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'publicBaseUrl must be https'),
}).strict();

export const NativeConsumerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  /** Correlates the requester/solver/evaluator announcements for a single run. */
  runId: z.string().min(1),
  /** The consumer's OWN state directory. Never a producer's. */
  stateDir: absolutePath('stateDir'),
  rpcUrl: z.string().url(),
  /** A public signed catalog (policies/anchors/bindings/revocations) -- never a private key store. */
  trustRootsPath: absolutePath('trustRootsPath'),
  policyGenesisDigest: sha256,
  chain: z.object({
    chainId: z.literal(84532),
    generation: z.literal('today'),
    contracts: z.object({
      taskCoordinator: address,
      jinnRouter: address,
      mechMarketplace: address,
      activityChecker: address,
    }).strict(),
  }).strict(),
  sources: z.object({
    requester: SourceRefSchema,
    solver: SourceRefSchema,
    evaluator: SourceRefSchema,
  }).strict(),
  actors: z.object({
    solverAgent: AgentIriSchema,
    evaluatorAgent: AgentIriSchema,
    /** Public did:key ids used only to probe the trust catalog for a settlements-scope binding. */
    executorDeclarationKey: DidKeySchema,
    evaluatorDeclarationKey: DidKeySchema,
  }).strict(),
  /** Published npm package provenance for this driver build -- name, version, and tarball digest are public. */
  packages: z.array(z.object({
    package: z.string().regex(/^@jinn-network\/[a-z0-9-]+$/u),
    version: z.string().min(1),
    tarballDigest: sha256,
  }).strict()).min(1),
}).strict();

export type NativeConsumerConfig = z.infer<typeof NativeConsumerConfigSchema>;

export class NativeConsumerConfigError extends Error {
  override readonly name = 'NativeConsumerConfigError';
}

export function parseNativeConsumerConfig(value: unknown): NativeConsumerConfig {
  const parsed = NativeConsumerConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new NativeConsumerConfigError(`native consumer config is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

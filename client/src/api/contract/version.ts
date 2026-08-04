/**
 * The read-contract version handshake (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifact 1).
 *
 * Every read payload carries `contractVersion: { major, minor }`. `major` bumps on a
 * breaking change to a payload shape (field removed, field type changed, field semantics
 * changed); `minor` bumps on an additive, backward-compatible change (new optional field,
 * new enum member consumers must already tolerate per the unknown-kind rule in
 * `lifecycle-kind.ts`). A future console-era handshake fails closed on a `major` mismatch
 * and warns when the server's `minor` is behind the console's — that behavior is deferred
 * to the console (§9); this module only defines the version value and its schema.
 */
import { z } from 'zod/v4';

export const contractVersionSchema = z.looseObject({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});

export type ContractVersion = z.infer<typeof contractVersionSchema>;

/** The read contract's current version. Bump per the rule in the module docstring. */
export const CURRENT_CONTRACT_VERSION: ContractVersion = { major: 1, minor: 0 };

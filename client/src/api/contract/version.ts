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

/**
 * sha256 of `JSON.stringify(z.toJSONSchema(statusV1ResponseSchema))` as of the version
 * above — a forcing function, not a computed value. It cannot live here as a real
 * computation: hashing needs `node:crypto` (not browser-safe) and importing
 * `statusV1ResponseSchema` from `./status.ts` here would be circular (`status.ts` already
 * imports `contractVersionSchema` from this module). So it's a plain string, hand-updated.
 *
 * `test/release/tier-1/T1.3-contract-conformance.ts` recomputes the live hash from the
 * current schema and asserts it equals this constant. Editing `status.ts`'s shape without
 * updating this constant fails that assertion — which is the point: it forces an edit
 * three lines from `CURRENT_CONTRACT_VERSION`, prompting whoever touched the shape to also
 * decide whether `major`/`minor` needs a bump, rather than letting a silent shape change
 * pass with the version left stale.
 *
 * To update after a deliberate schema change: recompute with
 * `createHash('sha256').update(JSON.stringify(z.toJSONSchema(statusV1ResponseSchema,
 * { target: 'draft-2020-12', unrepresentable: 'any' }))).digest('hex')` and paste the
 * result here alongside the version bump the change warrants.
 */
export const CONTRACT_SHAPE_SHA = '9c7aa514d6762048200fe0b0ff2661a82b555cd8d8cf756f06cf4351bb939833';

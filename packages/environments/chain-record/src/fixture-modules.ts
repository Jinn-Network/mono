import { z } from "zod";

import { isWellKnownDevAddress } from "./dev-addresses.js";
import { Address, DigestPinnedDescriptorSchema, NonEmpty, Quantity } from "./primitives.js";

/** The fixture-module categories §4.3 enumerates. */
export const FIXTURE_MODULE_KINDS = Object.freeze([
  "funded-accounts",
  "address-book",
  "deployment-transcript",
  "state-mutation",
  "token-metadata",
] as const);

export const FixtureModuleSchema = z.strictObject({
  id: NonEmpty,
  kind: z.enum(FIXTURE_MODULE_KINDS),
  module: DigestPinnedDescriptorSchema,
});

/**
 * A sandbox signer role and the address it drives. Strict on purpose: a `privateKey`,
 * `mnemonic`, or `seed` member is not a governed extension, it is key material in a portable
 * document, which custody law forbids outright. The block carries roles, addresses, and
 * balances; the keys exist only inside a running instance.
 */
export const FixtureAccountSchema = z.strictObject({
  role: NonEmpty,
  address: Address,
  nativeBalanceWei: Quantity,
});

/**
 * The ordered, digest-pinned fixture modules and the accounts they fund (§4.3). Array order is
 * application order and is part of the record.
 *
 * The post-fixture commitment is deliberately NOT restated here: it lives once, as
 * `stateMaterialization.initialStateCommitment`. See the findings section — the design
 * describes it in both blocks, and a sealed record carrying one value twice is a place for the
 * two copies to disagree.
 */
export const ChainFixturesSchema = z
  .strictObject({
    modules: z.array(FixtureModuleSchema),
    accounts: z.array(FixtureAccountSchema),
  })
  .superRefine((fixtures, ctx) => {
    const seenModuleIds = new Set<string>();
    fixtures.modules.forEach((module, index) => {
      if (seenModuleIds.has(module.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["modules", index, "id"],
          message: `duplicate module id "${module.id}": probe coverage is declared per module id (§4.3)`,
        });
      }
      seenModuleIds.add(module.id);
    });

    const seenRoles = new Set<string>();
    const seenAddresses = new Set<string>();
    fixtures.accounts.forEach((account, index) => {
      if (seenRoles.has(account.role)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "role"],
          message: `duplicate signer role "${account.role}"`,
        });
      }
      seenRoles.add(account.role);

      if (seenAddresses.has(account.address)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "address"],
          message:
            "address reused across roles: fixture keys are freshly generated per record and "
            + "never reused, so two roles never share one address (§8)",
        });
      }
      seenAddresses.add(account.address);

      if (isWellKnownDevAddress(account.address)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "address"],
          message:
            "this is a well-known development-mnemonic address whose private key is public. "
            + "Funding it would turn every published solution script into a replayable "
            + "transaction from it; fixture keys MUST be freshly generated per record (§8)",
        });
      }
    });
  });

export type ChainFixtures = z.infer<typeof ChainFixturesSchema>;

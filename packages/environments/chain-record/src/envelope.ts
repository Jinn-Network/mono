import { z } from "zod";

import { Address, Count, DigestPinnedDescriptorSchema, NonEmpty, Quantity } from "./primitives.js";

/**
 * What the agent may do inside the instance (§4.3). Tasks may **tighten** this envelope and
 * never widen it; the tighten-only comparison itself belongs with the evaluation family, which
 * is where the tightenings are declared.
 *
 * `signerRoles` carries roles and addresses. There is no member for a key, a keystore, or a
 * mnemonic, and the object is strict, so adding one is `invalid-document` rather than a
 * governed extension: real credentials never appear in portable documents.
 */
export const CapabilityEnvelopeSchema = z
  .strictObject({
    toolInterfaces: z
      .array(
        z.strictObject({
          id: NonEmpty,
          version: NonEmpty,
          schema: DigestPinnedDescriptorSchema,
        }),
      )
      .min(1),
    rpc: z.strictObject({
      readMethods: z.array(NonEmpty).min(1, "a world with no readable RPC method has no agent surface"),
      stateChangingMethods: z.array(NonEmpty),
    }),
    signerRoles: z
      .array(
        z.strictObject({
          role: NonEmpty,
          accounts: z.array(Address).min(1),
        }),
      )
      .min(1),
    /** The chain id the agent is permitted to sign for; the record level pins it to the runtime's. */
    permittedChainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    limits: z.strictObject({
      maxTransactions: Count,
      maxAggregateNativeValueWei: Quantity,
      /** May be empty — an explicit "no token ceilings", never an absent field. */
      tokenSpendPolicies: z.array(
        z.strictObject({ token: Address, maxSpendUnits: Quantity }),
      ),
      maxGasPerTransaction: Quantity,
      maxAggregateGas: Quantity,
      maxExecutionDurationMs: Count,
      maxBlockAdvance: Count,
      maxChainSecondsAdvance: Count,
    }),
    egressPolicyId: NonEmpty,
  })
  .superRefine((envelope, ctx) => {
    const read = new Set(envelope.rpc.readMethods);
    if (read.size !== envelope.rpc.readMethods.length) {
      ctx.addIssue({ code: "custom", path: ["rpc", "readMethods"], message: "duplicate RPC method in the read allowlist" });
    }
    const changing = new Set(envelope.rpc.stateChangingMethods);
    if (changing.size !== envelope.rpc.stateChangingMethods.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rpc", "stateChangingMethods"],
        message: "duplicate RPC method in the state-changing allowlist",
      });
    }
    for (const method of changing) {
      if (read.has(method)) {
        ctx.addIssue({
          code: "custom",
          path: ["rpc", "stateChangingMethods"],
          message:
            `"${method}" is listed as both read and state-changing; the isolation probes assert `
            + "the two classes behave differently, so a method cannot be in both (§5.1 step 6)",
        });
      }
    }

    const roles = new Set<string>();
    const accounts = new Set<string>();
    envelope.signerRoles.forEach((signer, index) => {
      if (roles.has(signer.role)) {
        ctx.addIssue({ code: "custom", path: ["signerRoles", index, "role"], message: `duplicate signer role "${signer.role}"` });
      }
      roles.add(signer.role);
      signer.accounts.forEach((account, accountIndex) => {
        if (accounts.has(account)) {
          ctx.addIssue({
            code: "custom",
            path: ["signerRoles", index, "accounts", accountIndex],
            message: "an account is exposed under two signer roles; signer scope is probed per role (§5.1 step 6)",
          });
        }
        accounts.add(account);
      });
    });
  });

export type CapabilityEnvelope = z.infer<typeof CapabilityEnvelopeSchema>;

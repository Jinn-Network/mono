/**
 * `identity.bind` (issue #2983): bind this workspace's report-signing key to a domain the operator
 * controls, and say exactly what to publish to make the binding true.
 *
 * The reader's half lives in `@colophon-claims/verify` (`identity/domain-binding.ts`), and this
 * calls into it rather than restating it — the same single-sourcing rule `../binding/carriage.ts`
 * follows. Minting a binding the shipped verifier would refuse is the one failure this operation
 * must not be able to have, so the document it writes is round-tripped through `verifyDomainBinding`
 * before it is returned.
 *
 * Three dispositions worth stating:
 *
 * - **Ungated.** This writes one local file and reaches no third party; the gated set
 *   (`../authority/policy.ts`) is for operations that move a lifecycle or disclose to someone else.
 *   The step that actually publishes anything is the operator's own, at their own DNS or web host.
 * - **The report key, and only it.** A binding answers "who published this", and the report key is
 *   the key that signs the publication. Binding an evaluator key would name a party the reader is
 *   measuring, not the one publishing.
 * - **Declaring is not proving.** Nothing here contacts the domain. The result carries the exact
 *   record to publish precisely because this operation cannot know whether it is published, and
 *   returning a "bound" that meant less than it says would be worse than returning an instruction.
 */

import { join } from "node:path";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  DOMAIN_BINDING_FORMAT,
  DOMAIN_BINDING_MECHANISMS,
  DomainBindingStatementSchema,
  domainBindingStatementBytes,
  verifyDomainBinding,
  type DomainBindingMechanism,
  type DomainBindingProof,
} from "@colophon-claims/verify";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

/** Beside the key it binds (`../report/signing.ts`'s `venue/` directory). */
const DOCUMENT_FILE_NAME = "domain-binding.json";

export interface IdentityBindInput {
  readonly domain: string;
  /** Defaults to `dns-txt`: it needs no web host and survives one moving. */
  readonly mechanism?: DomainBindingMechanism;
}

export interface IdentityBindResult {
  readonly domain: string;
  readonly keyId: string;
  readonly mechanism: DomainBindingMechanism;
  /** What to publish, and where. The operator's own next step. */
  readonly proof: DomainBindingProof;
  /** Absolute path of the written `colophon-domain-binding/1` document. */
  readonly documentPath: string;
}

export function identityBind(
  context: OperationContext,
  input: IdentityBindInput,
): OperationResult<IdentityBindResult> {
  return operate({
    context,
    action: "identity.bind",
    subject: "workspace",
    inputs: input,
    run: () => {
      const mechanism = input.mechanism ?? "dns-txt";
      if (!(DOMAIN_BINDING_MECHANISMS as readonly string[]).includes(mechanism)) {
        refuse(
          "validation",
          "identity.mechanism",
          `"${mechanism}" is not a self-served proof mechanism; use ${DOMAIN_BINDING_MECHANISMS.join(" or ")}`,
        );
      }
      const key = loadOrCreateReportSigningKey(context.workspaceDir);
      const statement = DomainBindingStatementSchema.safeParse({
        format: DOMAIN_BINDING_FORMAT,
        domain: input.domain,
        keyId: key.keyId,
        mechanism,
        statedAt: context.clock(),
      });
      if (!statement.success) {
        refuse(
          "validation",
          "identity.domain",
          `"${input.domain}" is not a lowercase dotted hostname; supply the bare domain, with no scheme, port, path, or trailing dot`,
        );
      }
      const signature = Buffer.from(key.sign(domainBindingStatementBytes(statement.data))).toString("base64");
      const documentBytes = canonicalJsonBytes({ ...statement.data, signature });

      // The shipped reader is the acceptance test for what this writes. A binding this product
      // minted but `colophon-verify` would refuse is a defect that must surface here, at the one
      // moment the operator is still in front of it.
      const verified = verifyDomainBinding(documentBytes, [key.keyId]);

      const documentPath = join(context.workspaceDir, "venue", DOCUMENT_FILE_NAME);
      atomicWriteFileSync(documentPath, Buffer.from(documentBytes), 0o600);
      return {
        domain: verified.domain,
        keyId: verified.keyId,
        mechanism: verified.mechanism,
        proof: verified.proof,
        documentPath,
      };
    },
  });
}

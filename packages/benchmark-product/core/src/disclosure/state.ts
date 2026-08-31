/**
 * The workspace-side disclosure declaration (disclosure-specification-record design §10.3, issue
 * #2839): the six entries a sponsor composes before lock, and the one function that turns them into
 * the sealed record.
 *
 * This is PRODUCT STATE, not a sealed record: it is what a human hands `disclosure declare`, in the
 * shape a human writes. The sealed record is derived from it by `sealDeclaration` below, and from
 * that moment the bytes are the record forever — everything downstream reads the bytes, never this
 * shape.
 *
 * Two fields are supplied by the workspace rather than by the declaring human, and both are why this
 * module exists at all rather than the CLI sealing a record directly:
 *
 * - `author` is taken from the workspace's report-authority identity, which is the same identity
 *   `report.author` resolves to. The verifier's §7 step 4 therefore holds BY CONSTRUCTION rather
 *   than by the declarer remembering to type the right IRI.
 * - `subject` is this run's sealed Matrix digest. The Matrix rather than the Report because the
 *   Report cannot name its own digest inside its own signed payload, and because the record must be
 *   sealable before the Report is (§5).
 */

import {
  DISCLOSURE_SPECIFICATION_RECORD_KIND,
  DISCLOSURE_VARIABLE_KEYS,
  DisclosureVariablesSchema,
  MATRIX_RECORD_KIND,
  SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
  sealDisclosureSpecification,
  type DisclosureVariableEntry,
  type DisclosureVariableKey,
} from "@jinn-network/benchmarking-records";
import { z } from "zod";
import { refuse } from "../errors.js";

/** What a sponsor writes: the six variable entries and nothing else. Everything else on the record
 * is a fact about this run that the workspace already knows. */
export const DisclosureDeclarationSchema = z.strictObject({
  variables: DisclosureVariablesSchema,
});
export type DisclosureDeclaration = z.infer<typeof DisclosureDeclarationSchema>;

export interface SealDisclosureDeclarationInput {
  readonly declaration: unknown;
  /** The workspace's report-authority identity — the same IRI `report.author` resolves to. */
  readonly author: string;
  /** This run's sealed Matrix digest. */
  readonly matrixSha256: string;
}

export interface SealedDisclosureDeclaration {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly statuses: Readonly<Record<DisclosureVariableKey, DisclosureVariableEntry["status"]>>;
}

/**
 * Validates the human-written declaration, composes the record around it, and seals it.
 *
 * A schema failure here is a typed `validation` refusal naming the variable, not a thrown zod error:
 * the person composing six honest sentences about their own experiment should be told which one is
 * wrong, in the product's own error shape.
 */
export function sealDisclosureDeclaration(
  input: SealDisclosureDeclarationInput,
): SealedDisclosureDeclaration {
  const parsed = DisclosureDeclarationSchema.safeParse(input.declaration);
  if (!parsed.success) {
    refuse(
      "validation",
      `disclosure.${parsed.error.issues[0]?.path.join(".") ?? "variables"}`,
      parsed.error.issues[0]?.message ?? "disclosure declaration is invalid",
    );
  }
  const document = {
    kind: DISCLOSURE_SPECIFICATION_RECORD_KIND,
    specification: SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
    author: input.author,
    subject: { kind: MATRIX_RECORD_KIND, digest: { sha256: input.matrixSha256 } },
    variables: parsed.data.variables,
  };
  let sealed: ReturnType<typeof sealDisclosureSpecification>;
  try {
    sealed = sealDisclosureSpecification(document);
  } catch (cause) {
    refuse(
      "validation",
      "disclosure",
      `disclosure declaration does not seal: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return {
    bytes: sealed.bytes,
    sha256: sealed.digest.slice("sha256:".length),
    statuses: Object.fromEntries(
      DISCLOSURE_VARIABLE_KEYS.map((key) => [key, parsed.data.variables[key].status]),
    ) as Readonly<Record<DisclosureVariableKey, DisclosureVariableEntry["status"]>>,
  };
}

/**
 * The `anchor-intent/v1` Run extension (anchor-evidence design §7.3).
 *
 * A draft may declare that it *intends* to anchor, and that declaration is sealed into the Run
 * record. The declaration changes absence semantics downstream: a bundle whose Run declares intent
 * but carries no matching anchor reports *declared-but-absent* rather than clean absence, so a
 * stripped anchor cannot masquerade as never-attempted.
 *
 * Three rules are load-bearing and each is enforced structurally rather than by convention:
 *
 * - **Profiles only, never endpoints.** An endpoint is machine-local configuration; sealing one
 *   would make the record depend on where it was produced, and would leak the operator's provider
 *   choice as a durable public fact about a run.
 * - **The declaration is intent, not proof.** An anchor necessarily postdates sealing, since it
 *   covers the sealed bytes. Nothing here asserts an anchor exists.
 * - **Sorted and unique.** The record is sealed to exact bytes, so two spellings of the same
 *   declaration would be two records claiming one intent. The order is fixed by the schema, the
 *   same discipline `publication-extension.ts` applies to `registrationArtifacts`.
 */

import { z } from "zod";
import { ANCHOR_INTENT_EXTENSION } from "./identifiers.js";

const AbsoluteIriSchema = z.string().refine(
  (value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value),
  "must be an absolute IRI",
);

export const RunAnchorIntentExtensionSchema = z.object({
  /** The anchor-provider profile URIs this run intends to anchor through. */
  providers: z.array(AbsoluteIriSchema).min(1, "declared anchoring intent must name at least one provider profile"),
}).superRefine((extension, ctx) => {
  for (let index = 1; index < extension.providers.length; index += 1) {
    if (extension.providers[index - 1]! >= extension.providers[index]!) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", index],
        message: "providers must be sorted and unique (UTF-16 code-unit order)",
      });
    }
  }
});

export type RunAnchorIntentExtension = z.infer<typeof RunAnchorIntentExtensionSchema>;

type ExtensibleRecord = Record<string, unknown>;

/** Construct the typed namespaced Run extension. Throws on a declaration this schema refuses. */
export function runAnchorIntentExtension(value: unknown): RunAnchorIntentExtension {
  return RunAnchorIntentExtensionSchema.parse(value);
}

export function withRunAnchorIntentExtension<T extends ExtensibleRecord>(
  record: T,
  extension: RunAnchorIntentExtension,
): T & { [ANCHOR_INTENT_EXTENSION]: RunAnchorIntentExtension } {
  return {
    ...record,
    [ANCHOR_INTENT_EXTENSION]: runAnchorIntentExtension(extension),
  } as T & { [ANCHOR_INTENT_EXTENSION]: RunAnchorIntentExtension };
}

export function readRunAnchorIntentExtension(record: ExtensibleRecord): RunAnchorIntentExtension | undefined {
  const value = record[ANCHOR_INTENT_EXTENSION];
  return value === undefined ? undefined : runAnchorIntentExtension(value);
}

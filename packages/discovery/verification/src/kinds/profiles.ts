// SPDX-License-Identifier: Apache-2.0

import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVALUATION_SPEC_MEDIA_TYPE,
  EvaluationSpecSchema,
  TASK_PROFILE_FORMAT_URI,
  TASK_PROFILE_MEDIA_TYPE,
  TaskProfileDocumentSchema,
  assertSafeSchema,
} from "@jinn-network/task-execution-profiles";

import { documentField, isRecordObject } from "../record-view.js";
import type { RecordView } from "../record-view.js";
import { describeError } from "../results.js";
import type { Finding } from "../results.js";
import type { RecordKind, RecordReference } from "./kind.js";
import { descriptorListReferences, descriptorReference, digestReference } from "./references.js";

const UNSIGNED_DOCUMENT = "Task profiles and evaluation specifications are sealed documents named by digest; no signature is part of the document.";

type SafeParsed =
  | { readonly success: true }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] } };

function findings(result: SafeParsed): readonly Finding[] {
  if (result.success) return [];
  return result.error.issues.map(({ path, message }) => ({
    code: "invalid-document",
    path: path.join("."),
    detail: message,
  }));
}

/**
 * The digests a spec pins (facts profile `evaluation-spec/v2`). Which appear depends on the spec's
 * family. Component bytes may be private, and a private grader is the case that profile leads with,
 * so only a composite's sub-specs have to be held.
 */
function evaluationSpecReferences(view: RecordView): readonly RecordReference[] {
  const block = documentField(view, "familyBlock");
  const family = isRecordObject(block) ? block : {};
  const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
  const grader = documentField(view, "grader");
  const predicates = list(family["successPredicates"]) as readonly Record<string, unknown>[];
  const abiRefs = predicates.flatMap((predicate, index) => {
    const groundTruth = predicate["groundTruth"];
    return [
      [predicate["call"], `/familyBlock/successPredicates/${index}/call`],
      [isRecordObject(groundTruth) ? groundTruth["call"] : undefined, `/familyBlock/successPredicates/${index}/groundTruth/call`],
    ] as const;
  }).flatMap(([call, path]) =>
    (isRecordObject(call) ? descriptorReference(call["abiRef"], "abiRefDigests", `${path}/abiRef`, true) : []));
  const parser = family["parser"];
  return [
    ...(Array.isArray(grader)
      ? descriptorListReferences(grader, "graderDigests", "/grader", true)
      : descriptorReference(grader, "graderDigests", "/grader", true)),
    ...descriptorReference(family["environmentRecord"], "environmentRecordDigest", "/familyBlock/environmentRecord", true),
    ...abiRefs,
    ...descriptorReference(family["image"], "imageDigest", "/familyBlock/image", true),
    ...descriptorListReferences(family["testMaterial"], "testMaterialDigests", "/familyBlock/testMaterial", true),
    ...digestReference(isRecordObject(parser) ? parser["digest"] : undefined, "parserDigest", "/familyBlock/parser/digest", true),
    ...descriptorReference(family["rubric"], "rubricDigest", "/familyBlock/rubric", true),
    ...descriptorReference(family["judgeOutputSchema"], "judgeOutputSchemaDigest", "/familyBlock/judgeOutputSchema", true),
    ...descriptorReference(family["reviewForm"], "reviewFormDigest", "/familyBlock/reviewForm", true),
    ...list(family["subSpecs"]).flatMap((sub, index) =>
      (isRecordObject(sub) ? descriptorReference(sub["spec"], "subSpecDigests", `/familyBlock/subSpecs/${index}/spec`, false) : [])),
  ];
}

function profileDocumentReferences(view: RecordView): readonly RecordReference[] {
  const extended = documentField(view, "extends");
  const conventions = documentField(view, "outputConventions");
  const slots = isRecordObject(conventions) && Array.isArray(conventions["slots"])
    ? conventions["slots"] as readonly Record<string, unknown>[]
    : [];
  return [
    ...digestReference(isRecordObject(extended) ? extended["digest"] : undefined, "extendsDigest", "/extends/digest", false),
    ...slots.flatMap((slot, index) =>
      descriptorReference(slot["schema"], "outputSlotSchemaDigests", `/outputConventions/slots/${index}/schema`, true)),
  ];
}

function unsafeSchema(schema: unknown, path: string): readonly Finding[] {
  try {
    assertSafeSchema(schema, new TextEncoder().encode(JSON.stringify(schema)));
    return [];
  } catch (cause) {
    return [{ code: "invalid-document", path, detail: describeError(cause) }];
  }
}

/**
 * A descriptor's `content` is base64 elsewhere in the protocol, and the published profiles carry
 * plain JSON, so a consumer may read it either way, and every reading that yields a schema counts. A
 * JSON Schema is an object or a boolean. A base64 decoder skips what it cannot read, so the quotes of
 * a JSON string, or the punctuation of an object around one key, can hide a second reading.
 */
function inlineSchemaReadings(content: string): readonly unknown[] {
  return [content, Buffer.from(content, "base64").toString("utf8")].flatMap((text) => {
    try {
      const schema: unknown = JSON.parse(text);
      return isRecordObject(schema) || typeof schema === "boolean" ? [schema] : [];
    } catch {
      return [];
    }
  });
}

/** A slot may pin its schema by digest, which is bytes this does not hold, or carry it inline. */
function inlineSlotSchemaFindings(view: RecordView): readonly Finding[] {
  const conventions = documentField(view, "outputConventions");
  const slots = isRecordObject(conventions) && Array.isArray(conventions["slots"])
    ? conventions["slots"] as readonly Record<string, unknown>[]
    : [];
  return slots.flatMap((slot, index) => {
    const descriptor = slot["schema"];
    if (!isRecordObject(descriptor) || typeof descriptor["content"] !== "string") return [];
    const path = `outputConventions.slots.${index}.schema.content`;
    const readings = inlineSchemaReadings(descriptor["content"]);
    return readings.length === 0
      ? [{ code: "invalid-document", path, detail: "This inline schema is neither a JSON Schema nor one in base64, so it cannot be shown safe to load." }]
      : readings.flatMap((schema) => unsafeSchema(schema, path));
  });
}

/** Profiles design §6.4: anyone may publish a profile, so a schema unsafe to load is `invalid-document`. */
function profileFindings(view: RecordView): readonly Finding[] {
  const shaped = findings(TaskProfileDocumentSchema.safeParse(view.document));
  if (shaped.length > 0) return shaped;
  return [...unsafeSchema(documentField(view, "payloadSchema"), "payloadSchema"), ...inlineSlotSchemaFindings(view)];
}

export const PROFILE_KINDS: Readonly<Record<string, RecordKind>> = {
  [RECORD_KINDS.evaluationSpec]: {
    family: "task-profiles",
    identify: (view) => documentField(view, "protocol") === EVALUATION_SPEC_FORMAT_URI,
    validate: ({ document }) => findings(EvaluationSpecSchema.safeParse(document)),
    mediaType: EVALUATION_SPEC_MEDIA_TYPE,
    unsignedBecause: UNSIGNED_DOCUMENT,
    references: evaluationSpecReferences,
  },
  [RECORD_KINDS.profileDocument]: {
    family: "task-profiles",
    identify: (view) => documentField(view, "protocol") === TASK_PROFILE_FORMAT_URI,
    validate: profileFindings,
    mediaType: TASK_PROFILE_MEDIA_TYPE,
    unsignedBecause: UNSIGNED_DOCUMENT,
    references: profileDocumentReferences,
  },
};

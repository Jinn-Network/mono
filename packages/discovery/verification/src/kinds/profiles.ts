// SPDX-License-Identifier: Apache-2.0

import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EvaluationSpecSchema,
  TASK_PROFILE_FORMAT_URI,
  TaskProfileDocumentSchema,
} from "@jinn-network/task-execution-profiles";

import { documentField, isRecordObject } from "../record-view.js";
import type { RecordView } from "../record-view.js";
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

export const PROFILE_KINDS: Readonly<Record<string, RecordKind>> = {
  [RECORD_KINDS.evaluationSpec]: {
    family: "task-profiles",
    identify: (view) => documentField(view, "protocol") === EVALUATION_SPEC_FORMAT_URI,
    validate: ({ document }) => findings(EvaluationSpecSchema.safeParse(document)),
    unsignedBecause: UNSIGNED_DOCUMENT,
    references: evaluationSpecReferences,
  },
  [RECORD_KINDS.profileDocument]: {
    family: "task-profiles",
    identify: (view) => documentField(view, "protocol") === TASK_PROFILE_FORMAT_URI,
    validate: ({ document }) => findings(TaskProfileDocumentSchema.safeParse(document)),
    unsignedBecause: UNSIGNED_DOCUMENT,
    references: profileDocumentReferences,
  },
};

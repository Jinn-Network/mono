// SPDX-License-Identifier: Apache-2.0

import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  ANCHOR_EVIDENCE_KIND,
  AUTHORIZATION_PREDICATE_TYPE,
  DSSE_PAYLOAD_TYPE,
  TRUST_KEY_BINDING_FORMAT,
  TRUST_KEY_BINDING_MEDIA_TYPE,
  TRUST_POLICY_FORMAT,
  TRUST_POLICY_MEDIA_TYPE,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
  validateAnchorEvidence,
  validateAuthorization,
  validateKeyBinding,
  validateRevocation,
  validateTrustPolicy,
} from "@jinn-network/trust-core";
import type { ValidationDiagnostic } from "@jinn-network/trust-core";

import { documentField, isRecordObject } from "../record-view.js";
import type { RecordView } from "../record-view.js";
import type { Finding } from "../results.js";
import type { RecordKind, RecordReference } from "./kind.js";
import { descriptorListReferences, descriptorReference, digestListReferences, digestReference } from "./references.js";

/**
 * Trust layer: §7.1 seals every signed record per Task Execution Protocol §6.1, and DSSE-signs it
 * under its own media type (§21.2), so these are held to the exact sealed envelope. `validate*` in
 * trust-core reads the envelope leniently on purpose, which is why the encoding check is separate.
 */

function findings(diagnostics: readonly ValidationDiagnostic[]): readonly Finding[] {
  return diagnostics.map(({ code, path, message }) => ({ code, ...(path === "" ? {} : { path }), detail: message }));
}

function isFormat(view: RecordView, mediaType: string, format: string): boolean {
  return view.payloadType === mediaType || documentField(view, "protocol") === format;
}

function anchorReferences(view: RecordView): readonly RecordReference[] {
  const anchors = documentField(view, "anchors");
  if (!Array.isArray(anchors)) return [];
  // Time anchors are artifacts, not records (facts profile `key-binding/v2`).
  return (anchors as readonly unknown[]).flatMap((anchor, index) =>
    (isRecordObject(anchor) ? digestReference(anchor["digest"], "anchorDigests", `/anchors/${index}/digest`, true) : []));
}

function keyBindingReferences(view: RecordView): readonly RecordReference[] {
  const ceremony = documentField(view, "ceremony");
  return [
    // Ceremony evidence can be embedded in the record; a digest reference alone is not a record.
    ...digestReference(isRecordObject(ceremony) ? ceremony["digest"] : undefined, "ceremony.digest", "/ceremony/digest", true),
    ...anchorReferences(view),
    ...digestReference(documentField(view, "supersedes"), "supersedes", "/supersedes", false),
  ];
}

function authorizationReferences(view: RecordView): readonly RecordReference[] {
  const predicate = documentField(view, "predicate");
  const fields = isRecordObject(predicate) ? predicate : {};
  return [
    // §8.1: the objects concerned may be an input a reader cannot see.
    ...descriptorListReferences(documentField(view, "subject"), "subjectDigests", "/subject", true),
    ...digestListReferences(fields["proofs"], "proofs", "/predicate/proofs", false),
    ...digestReference(fields["revocation"], "revocation", "/predicate/revocation", false),
  ];
}

export const TRUST_KINDS: Readonly<Record<string, RecordKind>> = {
  [RECORD_KINDS.keyBinding]: {
    family: "trust",
    identify: (view) => isFormat(view, TRUST_KEY_BINDING_MEDIA_TYPE, TRUST_KEY_BINDING_FORMAT),
    validate: ({ bytes }) => findings(validateKeyBinding(bytes).diagnostics),
    // §7.1: signed "by the working key being bound"; that proves possession and nothing more.
    requiredSigners: ({ bytes }) => {
      const didKey = validateKeyBinding(bytes).value?.key.didKey;
      return didKey === undefined ? [] : [didKey];
    },
    references: keyBindingReferences,
    attribution: ({ bytes }) => {
      const binding = validateKeyBinding(bytes).value;
      return binding === undefined
        ? undefined
        : { agent: binding.agent, scope: binding.scope[0]!, atTime: binding.validFrom };
    },
  },
  [TRUST_REVOCATION_FORMAT]: {
    family: "trust",
    identify: (view) => isFormat(view, TRUST_REVOCATION_MEDIA_TYPE, TRUST_REVOCATION_FORMAT),
    validate: ({ bytes }) => findings(validateRevocation(bytes).diagnostics),
    // §7.4b: `revokedBy` signs, as `isRevocationAuthorized` requires. A did:pkh is no key this can
    // verify, so that signature says `skipped`, and a stranger's beside it does not stand in for it.
    requiredSigners: (view) => {
      const revokedBy = documentField(view, "revokedBy");
      return typeof revokedBy === "string" ? [revokedBy] : [];
    },
    references: (view) => [
      ...digestReference(documentField(view, "target"), "target", "/target", false),
      ...anchorReferences(view),
    ],
    // §7.4b judges a revocation against the binding it targets, which is `verifyEnvelopeBinding`'s step 4.
  },
  [RECORD_KINDS.authorization]: {
    family: "trust",
    identify: (view) => documentField(view, "predicateType") === AUTHORIZATION_PREDICATE_TYPE
      && (view.payloadType === undefined || view.payloadType === DSSE_PAYLOAD_TYPE),
    validate: ({ bytes }) => findings(validateAuthorization(bytes).diagnostics),
    references: authorizationReferences,
    attribution: (view) => {
      const predicate = documentField(view, "predicate");
      const issuer = isRecordObject(predicate) ? predicate["issuer"] : undefined;
      // A statement states an expiry, not an issue time, so this needs the caller's `atTime`.
      return typeof issuer === "string" ? { agent: issuer, scope: "authorizations" } : undefined;
    },
  },
  [RECORD_KINDS.trustPolicy]: {
    family: "trust",
    identify: (view) => isFormat(view, TRUST_POLICY_MEDIA_TYPE, TRUST_POLICY_FORMAT),
    validate: ({ bytes }) => findings(validateTrustPolicy(bytes).diagnostics),
    references: (view) => digestReference(documentField(view, "predecessor"), "predecessor", "/predecessor", false),
    // §9: a policy answers to its declared signer set, never to a binding, and `verifyPolicyChain` walks that.
  },
  [ANCHOR_EVIDENCE_KIND]: {
    family: "trust",
    identify: (view) => documentField(view, "kind") === ANCHOR_EVIDENCE_KIND,
    validate: ({ bytes }) => findings(validateAnchorEvidence(bytes).diagnostics),
    unsignedBecause: "Pluggable integrity providers design §5 rule 4: AnchorEvidence is sealed, not signed; the proof inside is the authority's signature.",
    references: (view) => {
      const subject = documentField(view, "subject");
      return isRecordObject(subject) ? descriptorReference(subject, "subject", "/subject", false) : [];
    },
  },
};

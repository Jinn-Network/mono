// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

const PROFILE = "jinn.evidence-repository.ipfs-registration";
const VERSION = 1;
const DIGEST =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id:
    "https://jinn.network/profiles/evidence-repository-ipfs-registration/1/registration.schema.json",
  title: "Jinn Evidence Repository IPFS Registration v1",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["digest", "family", "kind", "profile", "version"],
      properties: {
        digest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        family: {
          enum: [
            "execution-evidence",
            "result-evaluation",
            "execution-verification",
          ],
        },
        kind: { const: "record" },
        profile: { const: PROFILE },
        version: { const: VERSION },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["digest", "kind", "profile", "version"],
      properties: {
        digest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        kind: { const: "artifact" },
        profile: { const: PROFILE },
        version: { const: VERSION },
      },
    },
  ],
};

const fixtureDefinitions = [
  {
    filename: "execution-evidence-registration.json",
    reference: { family: "execution-evidence", digest: DIGEST },
  },
  {
    filename: "result-evaluation-registration.json",
    reference: { family: "result-evaluation", digest: DIGEST },
  },
  {
    filename: "execution-verification-registration.json",
    reference: { family: "execution-verification", digest: DIGEST },
  },
  {
    filename: "artifact-registration.json",
    reference: { digest: DIGEST },
  },
];

export function createProfileAssets() {
  const assets = new Map();
  assets.set(
    "v1/registration.schema.json",
    encoder.encode(`${JSON.stringify(schema, null, 2)}\n`),
  );

  for (const definition of fixtureDefinitions) {
    const registrationText = registrationFor(definition.reference);
    const fixture = {
      reference: definition.reference,
      contentCid: digestToRawCid(definition.reference.digest),
      registrationText,
      registrationCid: rawCidForBytes(encoder.encode(registrationText)),
    };
    assets.set(
      `v1/fixtures/${definition.filename}`,
      encoder.encode(`${JSON.stringify(fixture, null, 2)}\n`),
    );
  }
  return assets;
}

function registrationFor(reference) {
  if ("family" in reference) {
    return (
      `{"digest":"${reference.digest}","family":"${reference.family}",` +
      `"kind":"record","profile":"${PROFILE}","version":${VERSION}}\n`
    );
  }
  return (
    `{"digest":"${reference.digest}","kind":"artifact",` +
    `"profile":"${PROFILE}","version":${VERSION}}\n`
  );
}

function rawCidForBytes(bytes) {
  return `f01551220${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestToRawCid(digest) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("invalid fixture digest");
  }
  return `f01551220${digest.slice("sha256:".length)}`;
}

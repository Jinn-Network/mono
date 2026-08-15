import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(
  packageRoot,
  "fixtures",
  "golden-execution-evidence-v1",
);
const executionRoot = join(fixtureRoot, "execution");
const publicRoot = join(fixtureRoot, "public");
const verificationRoot = join(
  fixtureRoot,
  "claims",
  "execution-verification",
);
const executionId = "urn:uuid:22222222-2222-4222-8222-222222222222";
const scrubberId = "urn:uuid:88888888-8888-4888-8888-888888888888";
const scrubActivityId = "#public-scrub";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function findEntity(document, id) {
  const entity = document["@graph"].find((candidate) => candidate["@id"] === id);
  if (!entity) throw new Error(`Missing fixture entity ${id}`);
  return entity;
}

function upsertEntity(document, next) {
  document["@graph"] = document["@graph"].filter(
    (candidate) => candidate["@id"] !== next["@id"],
  );
  document["@graph"].push(next);
}

const privateMetadataPath = join(executionRoot, "ro-crate-metadata.json");
const privateDocument = JSON.parse(await readFile(privateMetadataPath, "utf8"));
const contextObjects = privateDocument["@context"].filter(
  (value) => typeof value === "object" && value !== null,
);
if (!contextObjects.some((value) => value.jinn)) {
  contextObjects[0].jinn = "https://spec.jinn.network/terms/";
}
findEntity(privateDocument, executionId).subjectOf = {
  "@id": "trace/trace.jsonl",
};
const privateMetadataBytes = json(privateDocument);
await write(privateMetadataPath, privateMetadataBytes);
const privateMetadataDigest = digest(privateMetadataBytes);

const payloadType = "application/vnd.in-toto+json";

function signStatement(statementBytes, seedString) {
  const seed = createHash("sha256").update(seedString).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const typeBytes = Buffer.from(payloadType);
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `),
    typeBytes,
    Buffer.from(` ${statementBytes.length} `),
    statementBytes,
  ]);
  const envelope = {
    payloadType,
    payload: statementBytes.toString("base64"),
    signatures: [
      {
        keyid: digest(publicKeyDer),
        sig: sign(null, pae, privateKey).toString("base64"),
      },
    ],
  };
  return { envelope, publicKeyPem };
}

const statementPath = join(verificationRoot, "statement.json");
const verificationStatement = JSON.parse(await readFile(statementPath, "utf8"));
verificationStatement.subject = [
  {
    name: "ro-crate-metadata.json",
    digest: { sha256: privateMetadataDigest },
  },
];
const statementBytes = Buffer.from(json(verificationStatement));
await write(statementPath, statementBytes);

const { envelope, publicKeyPem } = signStatement(
  statementBytes,
  "jinn execution verification fixture key v1",
);
await write(join(verificationRoot, "public-key.pem"), publicKeyPem);
await write(
  join(verificationRoot, "execution-verification.dsse.json"),
  json(envelope),
);

const evaluationRoot = join(fixtureRoot, "claims", "result-evaluation");
const evaluationStatementPath = join(evaluationRoot, "statement.json");
const evaluationStatementBytes = Buffer.from(
  await readFile(evaluationStatementPath),
);
const { envelope: evaluationEnvelope, publicKeyPem: evaluationPublicKeyPem } =
  signStatement(
    evaluationStatementBytes,
    "jinn result evaluation fixture key v1",
  );
await write(join(evaluationRoot, "public-key.pem"), evaluationPublicKeyPem);
await write(
  join(evaluationRoot, "result-evaluation.dsse.json"),
  json(evaluationEnvelope),
);

const publicTrace = [
  {
    sequence: 1,
    role: "user",
    content: "Work in [REDACTED_ABSOLUTE_PATH] and normalize the slug.",
  },
  {
    sequence: 2,
    role: "assistant",
    content: "Implemented the change and tested with [REDACTED_CREDENTIAL].",
  },
];
const publicTraceBytes = Buffer.from(
  publicTrace.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
);
await write(
  join(publicRoot, "trace", "trace.public.jsonl"),
  publicTraceBytes,
);
const publicTraceDigest = digest(publicTraceBytes);

const policy = {
  schemaVersion: "jinn.fixture.public-execution-policy.v1",
  name: "Synthetic structure-aware public execution policy",
  version: "1.0.0",
  rules: [
    { class: "absolute-path", disposition: "redact" },
    { class: "credential", disposition: "redact" },
    { class: "protocol-commitment", disposition: "retain" },
  ],
};
const policyBytes = Buffer.from(json(policy));
await write(join(publicRoot, "scrub", "public-execution-policy.json"), policyBytes);
const policyDigest = digest(policyBytes);

const privateTraceDigest = findEntity(
  privateDocument,
  "trace/trace.jsonl",
).sha256;
const receipt = {
  schemaVersion: "jinn.fixture.scrub-receipt.v1",
  sourceRecord: `sha256:${privateMetadataDigest}`,
  scrubber: {
    id: scrubberId,
    name: "Synthetic structure-aware scrubber",
    version: "1.0.0",
  },
  policy: {
    name: "scrub/public-execution-policy.json",
    sha256: policyDigest,
  },
  completedAt: "2026-07-23T16:10:00Z",
  mappings: [
    {
      source: `sha256:${privateTraceDigest}`,
      derived: `sha256:${publicTraceDigest}`,
    },
  ],
  dispositions: [
    { class: "absolute-path", disposition: "redact", count: 1 },
    { class: "credential", disposition: "redact", count: 1 },
    { class: "reject", disposition: "reject", count: 0 },
  ],
};
const receiptBytes = Buffer.from(json(receipt));
await write(join(publicRoot, "scrub", "scrub-receipt.json"), receiptBytes);
const receiptDigest = digest(receiptBytes);

await write(
  join(publicRoot, "task", "task.md"),
  await readFile(join(executionRoot, "task", "task.md")),
);
await write(
  join(publicRoot, "results", "slug-normalization.patch"),
  await readFile(join(executionRoot, "results", "slug-normalization.patch")),
);

const publicDocument = structuredClone(privateDocument);
const publicContext = publicDocument["@context"].find(
  (value) => typeof value === "object" && value !== null,
);
publicContext.jinn = "https://spec.jinn.network/terms/";
const publicRootEntity = findEntity(publicDocument, "./");
publicRootEntity.name = "Golden synthetic public Execution Evidence v1 derivative";
publicRootEntity.description =
  "A conforming public derivative retaining exact historical commitments while publishing a separate scrubbed trace.";
publicRootEntity.dateCreated = "2026-07-23T16:10:00Z";
publicRootEntity.datePublished = "2026-07-23T16:10:00Z";
publicRootEntity.creator = { "@id": scrubberId };
publicRootEntity["prov:wasDerivedFrom"] = {
  "@id": "private/ro-crate-metadata.json",
};
publicRootEntity["prov:wasGeneratedBy"] = { "@id": scrubActivityId };
for (const id of [
  "private/ro-crate-metadata.json",
  "trace/trace.public.jsonl",
  "scrub/public-execution-policy.json",
  "scrub/scrub-receipt.json",
]) {
  if (!publicRootEntity.hasPart.some((reference) => reference["@id"] === id)) {
    publicRootEntity.hasPart.push({ "@id": id });
  }
}

upsertEntity(publicDocument, {
  "@id": "private/ro-crate-metadata.json",
  "@type": ["File", "CreativeWork"],
  name: "Unavailable exact private Execution Evidence metadata commitment",
  encodingFormat: "application/ld+json",
  sha256: privateMetadataDigest,
});
upsertEntity(publicDocument, {
  "@id": "trace/trace.public.jsonl",
  "@type": "File",
  name: "Structure-aware scrubbed trace projection",
  encodingFormat: "application/x-ndjson",
  sha256: publicTraceDigest,
  conformsTo: {
    "@id": "https://spec.jinn.network/formats/fixture-trace/v1",
  },
  about: { "@id": executionId },
  "prov:wasDerivedFrom": { "@id": "trace/trace.jsonl" },
  "prov:wasGeneratedBy": { "@id": scrubActivityId },
});
upsertEntity(publicDocument, {
  "@id": "scrub/public-execution-policy.json",
  "@type": ["File", "CreativeWork"],
  name: "Structure-aware public execution policy",
  encodingFormat: "application/json",
  sha256: policyDigest,
});
upsertEntity(publicDocument, {
  "@id": "scrub/scrub-receipt.json",
  "@type": ["File", "CreativeWork"],
  name: "Public derivation scrub receipt",
  encodingFormat: "application/json",
  sha256: receiptDigest,
  "prov:wasGeneratedBy": { "@id": scrubActivityId },
});
upsertEntity(publicDocument, {
  "@id": scrubberId,
  "@type": ["SoftwareApplication", "prov:Agent"],
  name: "Synthetic structure-aware scrubber",
  softwareVersion: "1.0.0",
});
for (const [id, name, propertyID, value] of [
  [
    "#disposition-absolute-path-redact",
    "absolute-path:redact",
    "https://spec.jinn.network/terms/dispositions/absolute-path/redact",
    1,
  ],
  [
    "#disposition-credential-redact",
    "credential:redact",
    "https://spec.jinn.network/terms/dispositions/credential/redact",
    1,
  ],
  [
    "#disposition-reject",
    "reject",
    "https://spec.jinn.network/terms/dispositions/reject",
    0,
  ],
]) {
  upsertEntity(publicDocument, {
    "@id": id,
    "@type": "PropertyValue",
    name,
    propertyID,
    value,
    unitCode: "count",
  });
}
upsertEntity(publicDocument, {
  "@id": scrubActivityId,
  "@type": "prov:Activity",
  name: "Structure-aware public derivation",
  endTime: "2026-07-23T16:10:00Z",
  agent: { "@id": scrubberId },
  instrument: { "@id": "scrub/public-execution-policy.json" },
  "jinn:dispositionCount": [
    { "@id": "#disposition-absolute-path-redact" },
    { "@id": "#disposition-credential-redact" },
    { "@id": "#disposition-reject" },
  ],
});

const publicMetadataBytes = Buffer.from(json(publicDocument));
await write(join(publicRoot, "ro-crate-metadata.json"), publicMetadataBytes);
const publicMetadataDigest = digest(publicMetadataBytes);

const reportPath = join(fixtureRoot, "conformance-report.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
report.executionEvidenceProfile.sha256 = privateMetadataDigest;
report.publicDerivative = {
  status: "structurally-complete-local-fixture",
  record: "public/ro-crate-metadata.json",
  sha256: publicMetadataDigest,
  sameExecutionId: executionId,
  unavailableExactArtifact: "public/trace/trace.jsonl",
  publishedDerivative: "public/trace/trace.public.jsonl",
  transferredPrivateVerification: false,
};
report.publicationCheck = {
  status: "conforming-structure-aware-derivative",
  rejected: false,
  sourceCommitment: `sha256:${privateMetadataDigest}`,
  derivedMetadataDigestRecordedInsideDerivative: false,
};
if (!report.coverage.includes("conforming-public-derivative")) {
  report.coverage.push("conforming-public-derivative");
}
await write(reportPath, json(report));

const collectionPath = join(fixtureRoot, "ro-crate-metadata.json");
const collection = JSON.parse(await readFile(collectionPath, "utf8"));
const collectionRoot = findEntity(collection, "./");
collectionRoot.description =
  "A synthetic collection containing private and public Execution Evidence records and two later signed claims.";
const publicFiles = [
  ["public/ro-crate-metadata.json", "Conforming public Execution Evidence metadata", "application/ld+json"],
  ["public/task/task.md", "Unchanged public Task", "text/markdown"],
  ["public/results/slug-normalization.patch", "Unchanged public Result", "text/x-diff"],
  ["public/trace/trace.public.jsonl", "Scrubbed public trace projection", "application/x-ndjson"],
  ["public/scrub/public-execution-policy.json", "Public derivation policy", "application/json"],
  ["public/scrub/scrub-receipt.json", "Public derivation receipt", "application/json"],
];
for (const [id, name, encodingFormat] of publicFiles) {
  if (!collectionRoot.hasPart.some((reference) => reference["@id"] === id)) {
    collectionRoot.hasPart.push({ "@id": id });
  }
  upsertEntity(collection, {
    "@id": id,
    "@type": id.endsWith(".json") ? ["File", "CreativeWork"] : "File",
    name,
    encodingFormat,
    sha256: digest(await readFile(join(fixtureRoot, id))),
  });
}
if (
  !collectionRoot.mentions.some(
    (reference) => reference["@id"] === "public/ro-crate-metadata.json",
  )
) {
  collectionRoot.mentions.push({ "@id": "public/ro-crate-metadata.json" });
}

for (const entity of collection["@graph"]) {
  if (
    typeof entity["@id"] !== "string" ||
    entity["@id"] === "ro-crate-metadata.json" ||
    entity["@id"] === "./" ||
    entity["@id"].startsWith("urn:") ||
    entity["@id"].startsWith("http")
  ) {
    continue;
  }
  try {
    entity.sha256 = digest(await readFile(join(fixtureRoot, entity["@id"])));
  } catch {
    // Contextual or intentionally unavailable entities are not collection files.
  }
}
await write(collectionPath, json(collection));

console.log(
  `Generated private ${privateMetadataDigest} and public ${publicMetadataDigest}.`,
);

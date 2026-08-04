import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { profileJsonSchemas } from "../dist/profile.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profileRoot = join(
  packageRoot,
  "profiles",
  "execution-evidence",
  "1.0",
);
const schemaRoot = join(profileRoot, "schemas");
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("Expected --write or --check");
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectedAssets() {
  const assets = new Map();
  for (const [name, schema] of Object.entries(profileJsonSchemas())) {
    assets.set(join("schemas", name), jsonBytes(schema));
  }

  const parts = [];
  for (const relativePath of [
    "specification.md",
    "vocabulary.jsonld",
    ...[...assets.keys()].sort(),
  ]) {
    const bytes = assets.get(relativePath) ??
      (await readFile(join(profileRoot, relativePath), "utf8"));
    const mediaType = relativePath.endsWith(".md")
      ? "text/markdown"
      : relativePath.endsWith(".jsonld")
        ? "application/ld+json"
        : "application/schema+json";
    parts.push({
      "@id": relativePath,
      "@type": "File",
      name: relativePath,
      encodingFormat: mediaType,
      sha256: sha256(bytes),
    });
  }

  const metadata = {
    "@context": [
      "https://w3id.org/ro/crate/1.3/context",
      {
        sha256: "https://w3id.org/ro/terms/workflow-run#sha256",
      },
    ],
    "@graph": [
      {
        "@id": "ro-crate-metadata.json",
        "@type": "CreativeWork",
        about: { "@id": "./" },
        conformsTo: {
          "@id": "https://w3id.org/ro/crate/1.3",
        },
      },
      {
        "@id": "./",
        "@type": ["Dataset", "ProfileCrate"],
        name: "Jinn Execution Evidence Profile 1.0",
        description:
          "Normative profile, vocabulary, schemas, and reference implementation metadata.",
        version: "1.0.0",
        license: "https://spdx.org/licenses/MIT",
        mainEntity: { "@id": "specification.md" },
        hasPart: parts.map(({ "@id": id }) => ({ "@id": id })),
        about: {
          "@id": "https://spec.jinn.network/profiles/execution-evidence/v1",
        },
      },
      {
        "@id": "https://spec.jinn.network/profiles/execution-evidence/v1",
        "@type": ["CreativeWork", "Profile"],
        name: "Jinn Execution Evidence Profile 1.0",
        version: "1.0.0",
        isProfileOf: [
          { "@id": "https://w3id.org/ro/crate/1.3" },
          { "@id": "https://in-toto.io/Statement/v1" },
        ],
        subjectOf: {
          "@id": "https://www.npmjs.com/package/@jinn-network/evidence-protocol",
        },
      },
      {
        "@id": "https://www.npmjs.com/package/@jinn-network/evidence-protocol",
        "@type": "SoftwareSourceCode",
        name: "@jinn-network/evidence-protocol",
        version: "0.1.0",
        codeRepository:
          "https://github.com/Jinn-Network/mono/tree/next/packages/evidence/protocol",
      },
      ...parts,
    ],
  };
  assets.set("ro-crate-metadata.json", jsonBytes(metadata));
  return assets;
}

const assets = await expectedAssets();
const drift = [];

for (const [relativePath, expected] of assets) {
  const path = join(profileRoot, relativePath);
  if (mode === "--write") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected);
    continue;
  }

  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    drift.push(`${relativePath} is missing`);
    continue;
  }
  if (actual !== expected) drift.push(`${relativePath} is out of date`);
}

if (drift.length > 0) {
  throw new Error(`Profile asset drift:\n- ${drift.join("\n- ")}`);
}

console.log(
  mode === "--write"
    ? `Wrote ${assets.size} profile assets.`
    : `Checked ${assets.size} profile assets.`,
);

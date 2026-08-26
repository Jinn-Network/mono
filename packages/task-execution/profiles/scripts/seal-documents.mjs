// Regenerates sealed profile and parser-semantics documents from builders in `dist/` (run after
// `yarn build`; see `package.json`'s `check:documents`/`generate:documents`). `--write` emits raw,
// no-indentation, no-trailing-newline JCS bytes and a pinned sha256 file; `--check` fails on drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealTaskProfile } from "../dist/task-profile/seal.js";
import { sealDocument } from "../dist/bytes.js";
import { buildRepositoryWorkProfile } from "../dist/documents/repository-work-1.0.js";
import { buildPredictionForecastProfile } from "../dist/documents/prediction-forecast-1.0.js";
import { buildEvaluationTaskProfile } from "../dist/documents/evaluation-task-1.0.js";
import { buildBinaryJudgmentProfile } from "../dist/documents/binary-judgment-2.0.js";
import {
  buildBinaryAcceptRejectParserSemantics,
  buildBinaryCompleteJsonLabelParserSemantics,
  buildBinaryCorrectWrongParserSemantics,
  buildBinaryEvermemJsonLabelParserSemantics,
  buildBinaryJsonVerdictParserSemantics,
  buildBinaryJudgmentEvaluationParserSemantics,
  buildBinaryLabelInProseParserSemantics,
  buildBinaryMem0JsonLabelParserSemantics,
  buildBinaryStrictJsonLabelParserSemantics,
  buildBinaryYesNoParserSemantics,
} from "../dist/binary-judgment/contracts.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("Expected --write or --check");
}

const DOCUMENTS = [
  {
    dir: join("profiles", "task-profiles", "repository-work", "1.0"),
    build: buildRepositoryWorkProfile,
  },
  {
    dir: join("profiles", "task-profiles", "prediction-forecast", "1.0"),
    build: buildPredictionForecastProfile,
  },
  {
    dir: join("profiles", "task-profiles", "evaluation-task", "1.0"),
    build: buildEvaluationTaskProfile,
    seal: sealTaskProfile,
    jsonName: "profile.json",
    shaName: "profile.sha256",
  },
  {
    dir: join("profiles", "task-profiles", "binary-judgment", "2.0"),
    build: buildBinaryJudgmentProfile,
    seal: sealTaskProfile,
    jsonName: "profile.json",
    shaName: "profile.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-accept-reject", "1.0.0"),
    build: buildBinaryAcceptRejectParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-complete-json-label", "1.0.0"),
    build: buildBinaryCompleteJsonLabelParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-yes-no", "1.0.0"),
    build: buildBinaryYesNoParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-correct-wrong", "1.0.0"),
    build: buildBinaryCorrectWrongParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-evermem-json-label", "1.0.0"),
    build: buildBinaryEvermemJsonLabelParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-json-verdict", "1.0.0"),
    build: buildBinaryJsonVerdictParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-label-in-prose", "1.0.0"),
    build: buildBinaryLabelInProseParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-mem0-json-label", "1.0.0"),
    build: buildBinaryMem0JsonLabelParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-strict-json-label", "1.0.0"),
    build: buildBinaryStrictJsonLabelParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
  {
    dir: join("profiles", "binary-judgment", "parsers", "binary-judgment-evaluation", "1.0.0"),
    build: buildBinaryJudgmentEvaluationParserSemantics,
    seal: (value) => sealDocument(value),
    jsonName: "semantics.json",
    shaName: "semantics.sha256",
  },
];

const drift = [];

for (const { dir, build, seal = sealTaskProfile, jsonName = "profile.json", shaName = "profile.sha256" } of DOCUMENTS) {
  const { bytes, digest } = seal(build());
  const jsonPath = join(packageRoot, dir, jsonName);
  const shaPath = join(packageRoot, dir, shaName);
  const shaText = `${digest}\n`;

  if (mode === "--write") {
    await mkdir(join(packageRoot, dir), { recursive: true });
    await writeFile(jsonPath, bytes);
    await writeFile(shaPath, shaText);
    continue;
  }

  const [actualJson, actualSha] = await Promise.all([
    readFile(jsonPath).catch(() => undefined),
    readFile(shaPath, "utf8").catch(() => undefined),
  ]);
  if (actualJson === undefined || Buffer.compare(Buffer.from(actualJson), Buffer.from(bytes)) !== 0) {
    drift.push(`${dir}/${jsonName} is out of date or missing`);
  }
  if (actualSha !== shaText) {
    drift.push(`${dir}/${shaName} is out of date or missing`);
  }
}

if (drift.length > 0) {
  throw new Error(`Sealed document drift:\n- ${drift.join("\n- ")}`);
}

console.log(
  mode === "--write"
    ? `Wrote ${DOCUMENTS.length} sealed document(s).`
    : `Checked ${DOCUMENTS.length} sealed document(s).`,
);

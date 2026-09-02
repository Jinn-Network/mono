#!/usr/bin/env node
// Derives the tampered variants of the conformance kit from golden/ + keys/.
// Every variant is a byte-copy of the golden with one surgical mutation chain;
// where a case targets a late verification seam, the earlier seams are
// repaired the way a dishonest producer would repair them (digest refresh,
// mirror updates, re-signing with the kit's own test keys) so exactly the
// intended check fails. Mutations are same-length byte-splices where possible;
// documents this script must rewrite wholesale (catalogs, the manifest, DSSE
// envelopes) are ASCII-keyed and reconstructed with a JCS-compatible
// sorted-compact serializer. The golden's sealed bytes are never re-emitted
// as the same document.
import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import {
  cpSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const kitDir = resolve(here, "..", "fixtures", "public-bundle-conformance-v1");
const goldenDir = join(kitDir, "golden");
const keysDir = join(kitDir, "keys");

const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// JCS-compatible for the documents this script rewrites: ASCII member names,
// safe-integer numbers, string values (JSON.stringify leaves non-ASCII string
// content unescaped, matching RFC 8785 for these inputs).
function sortedStringify(value) {
  if (Array.isArray(value)) return `[${value.map(sortedStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${sortedStringify(value[key])}`,
    );
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

const read = (dir, rel) => readFileSync(join(dir, rel));
const readJson = (dir, rel) => JSON.parse(read(dir, rel).toString("utf8"));
const writeBytes = (dir, rel, bytes) => writeFileSync(join(dir, rel), bytes);
const writeDoc = (dir, rel, value) => writeBytes(dir, rel, Buffer.from(sortedStringify(value), "utf8"));

// Replace one exact occurrence, refusing ambiguity and length drift unless allowed.
function splice(dir, rel, from, to, { allowLengthChange = false } = {}) {
  if (!allowLengthChange && from.length !== to.length) {
    throw new Error(`splice in ${rel}: length drift ${from.length} -> ${to.length}`);
  }
  const text = read(dir, rel).toString("utf8");
  const first = text.indexOf(from);
  if (first === -1) throw new Error(`splice in ${rel}: needle not found`);
  if (text.indexOf(from, first + 1) !== -1) throw new Error(`splice in ${rel}: ambiguous needle`);
  writeBytes(dir, rel, Buffer.from(text.slice(0, first) + to + text.slice(first + from.length), "utf8"));
}

// Replace every occurrence (the dishonest producer's repair of all references),
// requiring at least one and equal lengths.
function substituteAll(dir, rel, from, to) {
  if (from.length !== to.length) throw new Error(`substituteAll in ${rel}: length drift`);
  const text = read(dir, rel).toString("utf8");
  if (!text.includes(from)) throw new Error(`substituteAll in ${rel}: needle not found`);
  writeBytes(dir, rel, Buffer.from(text.replaceAll(from, to), "utf8"));
}

// Same, but tolerate absence (presentation surfaces embed only some digests).
function substituteIfPresent(dir, rel, from, to) {
  if (from.length !== to.length) throw new Error(`substituteIfPresent in ${rel}: length drift`);
  const text = read(dir, rel).toString("utf8");
  if (!text.includes(from)) return;
  writeBytes(dir, rel, Buffer.from(text.replaceAll(from, to), "utf8"));
}

function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

// Rewrite bundle.json from the files actually present (the dishonest
// producer's repair step), preserving every non-files member (e.g. format).
// bundle.json itself is never listed.
function refreshManifest(dir) {
  const manifest = readJson(dir, "bundle.json");
  manifest.files = walkFiles(dir)
    .filter((rel) => rel !== "bundle.json")
    .sort()
    .map((rel) => {
      const bytes = read(dir, rel);
      return { bytes: bytes.length, path: rel, sha256: sha256hex(bytes) };
    });
  writeDoc(dir, "bundle.json", manifest);
}

function dssePae(payloadType, payloadBytes) {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payloadBytes.length} `, "utf8"),
    payloadBytes,
  ]);
}

function resignReportEnvelope(dir) {
  const reportBytes = read(dir, "report.json");
  const envelope = readJson(dir, "report-envelope.json");
  const key = createPrivateKey({
    key: readFileSync(join(keysDir, "report-signing-key.pem"), "utf8"),
    format: "pem",
    type: "pkcs8",
  });
  const signature = cryptoSign(null, dssePae(envelope.payloadType, reportBytes), key);
  writeDoc(dir, "report-envelope.json", {
    payload: reportBytes.toString("base64"),
    payloadType: envelope.payloadType,
    signatures: [{ keyid: envelope.signatures[0].keyid, sig: signature.toString("base64") }],
  });
}

// A fixed, unrelated Ed25519 public key for the trust-key-swapped case. It is a
// constant rather than a freshly minted key so regeneration is byte-reproducible:
// an external implementer who regenerates the kit must get identical bytes, and a
// per-run key would churn the fixtures and their pinned digest manifest.
//
// Provenance, since a reader of a verification kit should not have to take this
// on trust: minted once with `generateKeyPairSync("ed25519")` and its private
// half discarded, so nothing can sign for it. That is also why the case works —
// the golden's report signature was made by a different key, so swapping this
// one in breaks both the did:key derivation and the signature check. You can
// confirm it is a well-formed Ed25519 SPKI and not the golden's key by decoding
// it and comparing against `golden/trust/public-keys.json`.
const SWAPPED_REPORT_SPKI_BASE64 = "MCowBQYDK2VwAyEA78oJ6JN54PDG3WoaZihaerox3QHlG4Zxd8u8uUlcVS0=";

// The exact field claim-text-tampered edits. Shared by the mutation and by its
// expected-message pattern below so the two cannot drift apart.
const CLAIM_TEXT_TAMPERED_PATH = ["verification", "trustRoot"];

const goldenTrust = readJson(goldenDir, "trust/public-keys.json");
const goldenVerdictCatalog = readJson(goldenDir, "verdicts.json");
const goldenReport = readJson(goldenDir, "report.json");

const CASES = [];
const defineCase = (id, description, expectedFailingCheck, externallyDetectable, apply) => {
  CASES.push({ id, description, expectedFailingCheck, externallyDetectable, apply });
};

defineCase(
  "file-truncated",
  "verdicts.json deleted; the manifest still lists it",
  "manifest",
  true,
  (dir) => rmSync(join(dir, "verdicts.json")),
);

defineCase(
  "manifest-digest-mismatch",
  "one byte of share.txt is flipped in place; length matches, the manifest digest does not",
  "manifest",
  true,
  (dir) => {
    const bytes = Buffer.from(read(dir, "share.txt"));
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0x2e ? 0x21 : 0x2e;
    writeBytes(dir, "share.txt", bytes);
  },
);

defineCase(
  "manifest-length-mismatch",
  "share.txt gains a trailing byte; its manifest byte length is stale",
  "manifest",
  true,
  (dir) => writeBytes(dir, "share.txt", Buffer.concat([read(dir, "share.txt"), Buffer.from("\n")])),
);

defineCase(
  "envelope-payload-malleated",
  "newlines are inserted into the report envelope's base64 payload; a lenient decoder sees identical bytes, a strict one refuses; digests are repaired",
  "report-verification",
  true,
  (dir) => {
    const envelope = readJson(dir, "report-envelope.json");
    const payload = envelope.payload;
    const cut = Math.floor(payload.length / 2);
    const malleated = `${payload.slice(0, cut)}\n${payload.slice(cut)}\n`;
    writeDoc(dir, "report-envelope.json", { ...envelope, payload: malleated });
    const claim = readJson(dir, "claim-package.json");
    splice(dir, "claim-package.json", `"reportEnvelopeSha256":"${claim.records.reportEnvelopeSha256}"`,
      `"reportEnvelopeSha256":"${sha256hex(read(dir, "report-envelope.json"))}"`);
    refreshManifest(dir);
  },
);

defineCase(
  "record-digest-mismatch",
  "one content-addressed record's bytes change; its filename and catalog digest are stale; the manifest is repaired",
  "evidence-closure",
  true,
  (dir) => {
    const rel = `records/${goldenVerdictCatalog.verdicts[0].sha256}.bin`;
    writeBytes(dir, rel, Buffer.concat([read(dir, rel), Buffer.from(" ")]));
    refreshManifest(dir);
  },
);

defineCase(
  "record-substituted",
  "one verdict record is removed from the store and both catalogs; the signed matrix still references its digest",
  "evidence-closure",
  true,
  (dir) => {
    const removed = goldenVerdictCatalog.verdicts[0].sha256;
    rmSync(join(dir, `records/${removed}.bin`));
    const evidence = readJson(dir, "evidence.json");
    evidence.records = evidence.records.filter((record) => record.sha256 !== removed);
    writeDoc(dir, "evidence.json", evidence);
    const verdicts = readJson(dir, "verdicts.json");
    verdicts.verdicts = verdicts.verdicts.filter((verdict) => verdict.sha256 !== removed);
    writeDoc(dir, "verdicts.json", verdicts);
    refreshManifest(dir);
  },
);

defineCase(
  "report-payload-edited",
  "one Wilson bound digit changes in report.json and the envelope payload; the signature is not re-made; digests are repaired",
  "report-verification",
  true,
  (dir) => {
    const armId = Object.keys(goldenReport.results.perSubject[0].results.arms).sort()[0];
    const arm = goldenReport.results.perSubject[0].results.arms[armId];
    const oldLow = arm.wilsonInterval.low;
    const newLow = oldLow.at(-1) === "9" ? `${oldLow.slice(0, -1)}8` : `${oldLow.slice(0, -1)}9`;
    const envelope = readJson(dir, "report-envelope.json");
    const payload = Buffer.from(envelope.payload, "base64").toString("utf8");
    // Full canonical arm snippet (JCS member order) keeps the needle unambiguous
    // even when both arms carry identical statistics.
    const armSnippet = (low) =>
      `"${armId}":{"n":${arm.n},"passRate":"${arm.passRate}","wilsonInterval":{"high":"${arm.wilsonInterval.high}","low":"${low}"}}`;
    const needle = armSnippet(oldLow);
    const replacement = armSnippet(newLow);
    splice(dir, "report.json", needle, replacement);
    const editedPayload = payload.replace(needle, replacement);
    if (editedPayload === payload) throw new Error("payload edit did not apply");
    splice(dir, "report-envelope.json", envelope.payload, Buffer.from(editedPayload, "utf8").toString("base64"));
    for (const [field, rel] of [["reportSha256", "report.json"], ["reportEnvelopeSha256", "report-envelope.json"]]) {
      const claim = readJson(dir, "claim-package.json");
      splice(dir, "claim-package.json", `"${field}":"${claim.records[field]}"`, `"${field}":"${sha256hex(read(dir, rel))}"`);
    }
    refreshManifest(dir);
  },
);

defineCase(
  "report-signature-grafted",
  "the report envelope carries a genuine signature lifted from a verdict envelope; digests are repaired",
  "report-verification",
  true,
  (dir) => {
    const envelope = readJson(dir, "report-envelope.json");
    const verdictEnvelope = JSON.parse(read(dir, `records/${goldenVerdictCatalog.verdicts[0].sha256}.bin`).toString("utf8"));
    splice(dir, "report-envelope.json", envelope.signatures[0].sig, verdictEnvelope.signatures[0].sig);
    const claim = readJson(dir, "claim-package.json");
    splice(dir, "claim-package.json", `"reportEnvelopeSha256":"${claim.records.reportEnvelopeSha256}"`,
      `"reportEnvelopeSha256":"${sha256hex(read(dir, "report-envelope.json"))}"`);
    refreshManifest(dir);
  },
);

defineCase(
  "trust-key-swapped",
  "the report public key in the trust file is replaced by a fresh key; keyId, did:key, and the signature no longer match",
  "trust",
  true,
  (dir) => {
    splice(dir, "trust/public-keys.json", goldenTrust.report.spkiDerBase64, SWAPPED_REPORT_SPKI_BASE64);
    refreshManifest(dir);
  },
);

defineCase(
  "verdict-signature-grafted-resigned",
  "two verdict envelopes swap signatures; the store, catalogs, matrix, report, and claim are all repaired and re-signed with the venue keys, so only the verdict signatures themselves are wrong",
  "matrix-rederivation",
  true,
  (dir) => {
    const [first, second] = goldenVerdictCatalog.verdicts;
    const firstRel = `records/${first.sha256}.bin`;
    const secondRel = `records/${second.sha256}.bin`;
    const firstEnvelope = JSON.parse(read(dir, firstRel).toString("utf8"));
    const secondEnvelope = JSON.parse(read(dir, secondRel).toString("utf8"));
    splice(dir, firstRel, firstEnvelope.signatures[0].sig, secondEnvelope.signatures[0].sig);
    splice(dir, secondRel, secondEnvelope.signatures[0].sig, firstEnvelope.signatures[0].sig);

    // Cascade the digest change through the content-addressed store: records
    // that reference a renamed record are rewritten and renamed themselves
    // (the sample bundle's records are all JSON text). The reference graph is
    // acyclic, so this reaches a fixpoint.
    const digestMap = new Map();
    const renameToOwnDigest = (rel) => {
      const digest = sha256hex(read(dir, rel));
      const oldHex = rel.slice("records/".length, -".bin".length);
      if (digest === oldHex) return;
      renameSync(join(dir, rel), join(dir, `records/${digest}.bin`));
      digestMap.set(oldHex, digest);
    };
    renameToOwnDigest(firstRel);
    renameToOwnDigest(secondRel);
    let changed = true;
    while (changed) {
      changed = false;
      for (const fileName of readdirSync(join(dir, "records")).sort()) {
        const rel = `records/${fileName}`;
        let text = read(dir, rel).toString("utf8");
        let touched = false;
        for (const [oldHex, newHex] of digestMap) {
          if (text.includes(oldHex)) {
            text = text.replaceAll(oldHex, newHex);
            touched = true;
          }
        }
        if (touched) {
          writeBytes(dir, rel, Buffer.from(text, "utf8"));
          renameToOwnDigest(rel);
          changed = true;
        }
      }
    }

    // Repair every catalog, graph, and record-list reference.
    for (const rel of ["evidence.json", "verdicts.json", "matrix.json", "verification/assembly.jsonl"]) {
      for (const [oldHex, newHex] of digestMap) substituteIfPresent(dir, rel, oldHex, newHex);
    }
    // matrix changed -> re-pin it in the signed report and re-sign; repair the claim mirror.
    const matrixDigest = sha256hex(read(dir, "matrix.json"));
    const oldMatrixDigest = sha256hex(read(goldenDir, "matrix.json"));
    digestMap.set(oldMatrixDigest, matrixDigest);
    const reportText = read(dir, "report.json").toString("utf8");
    writeBytes(dir, "report.json", Buffer.from(reportText.replaceAll(oldMatrixDigest, matrixDigest), "utf8"));
    resignReportEnvelope(dir);
    const claim = readJson(dir, "claim-package.json");
    const claimText = read(dir, "claim-package.json").toString("utf8")
      .replaceAll(oldMatrixDigest, matrixDigest)
      .replace(`"reportSha256":"${claim.records.reportSha256}"`, `"reportSha256":"${sha256hex(read(dir, "report.json"))}"`);
    writeBytes(dir, "claim-package.json", Buffer.from(claimText, "utf8"));
    splice(dir, "claim-package.json", `"reportEnvelopeSha256":"${claim.records.reportEnvelopeSha256}"`,
      `"reportEnvelopeSha256":"${sha256hex(read(dir, "report-envelope.json"))}"`);
    digestMap.set(claim.records.reportSha256, sha256hex(read(dir, "report.json")));
    digestMap.set(claim.records.reportEnvelopeSha256, sha256hex(read(dir, "report-envelope.json")));
    // The projection and presentation surfaces embed digests too; the dishonest
    // producer repairs every reference so only the verdict signatures stay wrong.
    for (const rel of ["static-bundle.json", "README.md", "index.html", "share.txt", "claim-package.json"]) {
      for (const [oldHex, newHex] of digestMap) substituteIfPresent(dir, rel, oldHex, newHex);
    }
    refreshManifest(dir);
  },
);

defineCase(
  "recanonicalized-report-bytes",
  "report.json is pretty-printed; schema-valid JSON, but no longer the sealed bytes the envelope payload carries",
  "evidence-closure",
  true,
  (dir) => {
    writeBytes(dir, "report.json", Buffer.from(`${JSON.stringify(readJson(dir, "report.json"), null, 2)}\n`, "utf8"));
    const claim = readJson(dir, "claim-package.json");
    splice(dir, "claim-package.json", `"reportSha256":"${claim.records.reportSha256}"`,
      `"reportSha256":"${sha256hex(read(dir, "report.json"))}"`);
    refreshManifest(dir);
  },
);

defineCase(
  "claim-headline-tampered",
  "the claim package's stored headline pass rate disagrees with the signed report's results",
  "claim-consistency",
  true,
  (dir) => {
    const claim = readJson(dir, "claim-package.json");
    const armId = Object.keys(claim.headline).sort()[0];
    const oldRate = claim.headline[armId].passRate;
    const newRate = oldRate.at(-1) === "9" ? `${oldRate.slice(0, -1)}8` : `${oldRate.slice(0, -1)}9`;
    // Anchor on the headline container: the same arm object also appears in the
    // claim's per-subject results mirror.
    splice(dir, "claim-package.json", `"headline":{"${armId}":{"n":${claim.headline[armId].n},"passRate":"${oldRate}"`,
      `"headline":{"${armId}":{"n":${claim.headline[armId].n},"passRate":"${newRate}"`);
    refreshManifest(dir);
  },
);

defineCase(
  "claim-text-tampered",
  "a claim-package field outside every digest mirror changes; only full claim recomputation catches it",
  "claim-consistency",
  false,
  (dir) => {
    const claim = readJson(dir, "claim-package.json");
    const leaf = CLAIM_TEXT_TAMPERED_PATH.at(-1);
    const original = CLAIM_TEXT_TAMPERED_PATH.reduce((node, key) => node[key], claim);
    splice(dir, "claim-package.json", `"${leaf}":${JSON.stringify(original)}`,
      `"${leaf}":${JSON.stringify(`${original.slice(0, -1)}!`)}`);
    refreshManifest(dir);
  },
);

defineCase(
  "results-miscomputed-resigned",
  "the report's stored interval disagrees with its own method recomputation; everything is internally consistent and genuinely re-signed with the venue key",
  "report-verification",
  false,
  (dir) => {
    const armIds = Object.keys(goldenReport.results.perSubject[0].results.arms).sort();
    const arm = goldenReport.results.perSubject[0].results.arms[armIds[0]];
    const oldLow = arm.wilsonInterval.low;
    const newLow = oldLow.at(-1) === "9" ? `${oldLow.slice(0, -1)}8` : `${oldLow.slice(0, -1)}9`;
    const reportText = read(dir, "report.json").toString("utf8");
    writeBytes(dir, "report.json", Buffer.from(reportText.replaceAll(`"low":"${oldLow}"`, `"low":"${newLow}"`), "utf8"));
    resignReportEnvelope(dir);
    const claimText = read(dir, "claim-package.json").toString("utf8").replaceAll(`"low":"${oldLow}"`, `"low":"${newLow}"`);
    writeBytes(dir, "claim-package.json", Buffer.from(claimText, "utf8"));
    const claim = readJson(dir, "claim-package.json");
    splice(dir, "claim-package.json", `"reportSha256":"${claim.records.reportSha256}"`,
      `"reportSha256":"${sha256hex(read(dir, "report.json"))}"`);
    splice(dir, "claim-package.json", `"reportEnvelopeSha256":"${claim.records.reportEnvelopeSha256}"`,
      `"reportEnvelopeSha256":"${sha256hex(read(dir, "report-envelope.json"))}"`);
    refreshManifest(dir);
  },
);

rmSync(join(kitDir, "tampered"), { recursive: true, force: true });
for (const tamperCase of CASES) {
  const dir = join(kitDir, "tampered", tamperCase.id);
  cpSync(goldenDir, dir, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, dereference: false });
  tamperCase.apply(dir);
  statSync(dir);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The claim-consistency refusal names the field that actually differs, so each
// claim case pins its own field rather than a shared wildcard — that is what
// makes the two cases distinguishable to an external implementation. Both are
// derived from the same values the mutations above use, so they survive a
// golden regeneration that changes arm names.
const claimDifferencePattern = (path) =>
  `^claim package ${escapeRegExp(path)} is not the exact projection of verified facts$`;
const tamperedHeadlineArmId = Object.keys(
  JSON.parse(read(goldenDir, "claim-package.json").toString("utf8")).headline,
).sort()[0];

// Stable regular expressions over the reference verifier's failure message,
// one per case, verified empirically by test/conformance-kit.test.mjs.
const EXPECTED_MESSAGE_PATTERNS = {
  "claim-headline-tampered": claimDifferencePattern(`headline.${tamperedHeadlineArmId}.passRate`),
  "claim-text-tampered": claimDifferencePattern(CLAIM_TEXT_TAMPERED_PATH.join(".")),
  "envelope-payload-malleated": "not strict standard or URL-safe base64",
  "file-truncated": "^manifest entry \"verdicts\\.json\" is missing$",
  "manifest-digest-mismatch": "^digest mismatch for \"share\\.txt\"$",
  "manifest-length-mismatch": "^byte length mismatch for \"share\\.txt\"$",
  "recanonicalized-report-bytes": "schema validation at sealing",
  "record-digest-mismatch": "^evidence record digest mismatch",
  "record-substituted": "^verdict [0-9a-f]{64} bytes are missing$",
  "report-payload-edited": "^report-authenticity:",
  "report-signature-grafted": "^report-authenticity:",
  "results-miscomputed-resigned": "^report-recompute: recomputed results do not match",
  "trust-key-swapped": "^Report author/keyId/didKey are not derived",
  "verdict-signature-grafted-resigned": "^matrix-rederivation:",
};

writeFileSync(
  join(kitDir, "manifest.json"),
  `${JSON.stringify(
    {
      format: "benchmark-product-conformance-kit/1",
      semantics: "expectedMessagePattern is the behavioral pin (a regular expression over the reference verifier's failure message); expectedFailingCheck names the reference check family it belongs to and is advisory. externallyDetectable states whether the external-subset checks alone must reject the variant.",
      golden: {
        expectedChecks: [
          "manifest",
          "evidence-closure",
          "trust",
          "matrix-rederivation",
          "report-verification",
          "claim-consistency",
        ],
        expectedDisposition: "valid",
        path: "golden",
      },
      fixtures: CASES.map(({ id, description, expectedFailingCheck, externallyDetectable }) => {
        const expectedMessagePattern = EXPECTED_MESSAGE_PATTERNS[id];
        if (expectedMessagePattern === undefined) throw new Error(`no expected message pattern for ${id}`);
        return {
          description,
          expectedDisposition: "invalid",
          expectedFailingCheck,
          expectedMessagePattern,
          externallyDetectable,
          id,
          path: `tampered/${id}`,
        };
      }).sort((a, b) => a.id.localeCompare(b.id)),
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${CASES.length} tampered variants`);

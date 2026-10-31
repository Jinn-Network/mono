// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "jinn-verify-"));
const archive = join(temporary, "verify.tgz");
const consumer = join(temporary, "consumer");

/** The runtime closure, each reached through a portal here and so packed from its built tree. */
const CLOSURE = {
  "@jinn-network/evidence-offer": "../../evidence/offer",
  "@jinn-network/evidence-protocol": "../../evidence/protocol",
  "@jinn-network/record-discovery-protocol": "../protocol",
  "@jinn-network/task-execution-profiles": "../../task-execution/profiles",
  "@jinn-network/task-execution-protocol": "../../task-execution/protocol",
  "@jinn-network/trust-core": "../../trust/core",
};

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const stdout = [];
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${command} exited ${code}`)));
  });
}

const CONSUMER = `
import { generateKeyPairSync, sign } from "node:crypto";
import { dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { TASK_EXECUTION_PROTOCOL_URI, sealTask } from "@jinn-network/task-execution-protocol";
import {
  anchorCertificateReader,
  anchorChainVerifier,
  anchorSignatureVerifier,
  checkRecord,
  checkRecordSet,
  createDidKeyDsseVerifier,
  defaultRecordKinds,
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
  evaluateAnchors,
  nodeCryptoAnchorPorts,
  recordDigest,
  verifyDsseSignatures,
  verifyEd25519Signature,
} from "@jinn-network/verify";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = didKeyFromEd25519PublicKey(publicKey);
const payloadType = "application/vnd.in-toto+json";
const payloadBytes = new TextEncoder().encode("{}");
const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
const signature = new Uint8Array(sign(null, preAuthEncoding, privateKey));
const envelope = sealDsseEnvelope({ payloadType, payloadBytes, signatures: [{ keyid: keyId, signature }] });

const task = sealTask({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  profile: { uri: "https://example.test/profile", digest: { sha256: "1".repeat(64) } },
  instructions: "Do the work.",
  outputs: [],
});
const taskDigest = recordDigest(task);
const taskReport = await checkRecord(task, { digest: taskDigest });
const setReport = await checkRecordSet({ records: [{ bytes: task }], roots: [taskDigest] });
const anchors = evaluateAnchors({ records: [], subjects: [{ id: "task", sha256: taskDigest.slice("sha256:".length) }] });

const results = [
  taskReport.outcome === "checked",
  taskReport.kind in defaultRecordKinds,
  setReport.summary.records === 1,
  anchors.subjects[0].outcome === "absent",
  recordDigest(new Uint8Array(0)) === "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ed25519PublicKeyBytesFromDidKey(keyId)?.length === 32,
  ed25519PublicKeyFromDidKey(keyId)?.asymmetricKeyType === "ed25519",
  verifyEd25519Signature(publicKey, preAuthEncoding, signature),
  verifyDsseSignatures(envelope, [{ keyId, publicKey }]).validSignerKeyids[0] === keyId,
  createDidKeyDsseVerifier()(envelope).validSignerKeyids[0] === keyId,
  nodeCryptoAnchorPorts.signatureVerifier === anchorSignatureVerifier,
  nodeCryptoAnchorPorts.certificateReader === anchorCertificateReader,
  nodeCryptoAnchorPorts.chainVerifier === anchorChainVerifier,
];
if (results.some((result) => result !== true)) throw new Error("packed public API failed: " + JSON.stringify(results));
`;

try {
  /** @type {Record<string, string>} */
  const dependencies = {};
  for (const [name, directory] of Object.entries(CLOSURE)) {
    const packed = JSON.parse(await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
      join(root, directory),
    ));
    dependencies[name] = `file:${join(temporary, packed[0].filename)}`;
  }
  await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], root);

  const entries = (await run("tar", ["-tzf", archive], root)).split(/\r?\n/u).filter(Boolean);
  for (const required of ["package/README.md", "package/dist/index.js", "package/dist/index.d.ts"]) {
    if (!entries.includes(required)) throw new Error(`packed package is missing ${required}`);
  }
  const leakedTests = entries.filter((entry) => /\.test\./u.test(entry));
  if (leakedTests.length > 0) throw new Error(`test files leaked into the tarball: ${leakedTests.join(", ")}`);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { ...dependencies, "@jinn-network/verify": `file:${archive}` },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  await writeFile(join(consumer, "smoke.mjs"), CONSUMER);
  await run(process.execPath, ["smoke.mjs"], consumer);
  console.log("Packed @jinn-network/verify distribution and archive shape verified.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

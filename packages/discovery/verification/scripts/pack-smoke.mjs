// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "jinn-verify-"));
const archive = join(temporary, "verify.tgz");
const trustArchive = join(temporary, "trust-core.tgz");
const consumer = join(temporary, "consumer");

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
import {
  anchorCertificateReader,
  anchorChainVerifier,
  anchorSignatureVerifier,
  createDidKeyDsseVerifier,
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
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

const results = [
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
  const packed = JSON.parse(await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
    join(root, "../../trust/core"),
  ));
  await writeFile(trustArchive, await readFile(join(temporary, packed[0].filename)));
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
    dependencies: {
      "@jinn-network/trust-core": `file:${trustArchive}`,
      "@jinn-network/verify": `file:${archive}`,
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  await writeFile(join(consumer, "smoke.mjs"), CONSUMER);
  await run(process.execPath, ["smoke.mjs"], consumer);
  console.log("Packed @jinn-network/verify distribution and archive shape verified.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

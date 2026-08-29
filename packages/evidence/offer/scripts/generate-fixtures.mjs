// SPDX-License-Identifier: Apache-2.0
// Generates the golden and refused offer corpora. Fixtures are derived from the
// specification and this generator, never captured from a product run. `--write`
// regenerates; the default detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const offerFixtures = join(root, "fixtures", "offer");
const write = process.argv.includes("--write");

const { OFFER_RECORD_KIND, sealOffer } = await import(join(root, "dist", "index.js"));
const { createFixtureOfferSigner } = await import(join(root, "dist", "testing.js"));

const SUBJECT = `sha256:${"a".repeat(64)}`;
const OTHER_SUBJECT = `sha256:${"b".repeat(64)}`;
const GATE = { uri: "https://gate.example/offers" };
const USDC_BASE = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";
const OLAS_BASE = "https://spec.jinn.network/rails/eip155-8453-erc20-olas/v1";

/** Zero is first-class: an empty rails list is an explicit free offer, served on sight. */
const free = {
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [],
  gate: GATE,
};

/** Two rails, one subject. Equivalence across them is the holder's assertion, not a rate. */
const priced = {
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [
    { rail: OLAS_BASE, to: "0x1111111111111111111111111111111111111111", amount: "2500000000000000000" },
    { rail: USDC_BASE, to: "0x2222222222222222222222222222222222222222", amount: "1500000" },
  ],
  gate: GATE,
};

const supersedingDocument = (predecessorDigest) => ({
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [
    { rail: USDC_BASE, to: "0x2222222222222222222222222222222222222222", amount: "900000" },
  ],
  gate: GATE,
  supersedes: predecessorDigest,
  "com.example.note": { campaign: "launch-week" },
});

const INVALID = {
  // Free has one spelling: the empty list. A zero-amount rail is the second.
  "zero-amount": { ...priced, rails: [{ ...priced.rails[1], amount: "0" }] },
  "signed-amount": { ...priced, rails: [{ ...priced.rails[1], amount: "+1500000" }] },
  "leading-zero-amount": { ...priced, rails: [{ ...priced.rails[1], amount: "01500000" }] },
  "duplicate-rail": {
    ...priced,
    rails: [priced.rails[1], { ...priced.rails[1], amount: "1" }],
  },
  "unsorted-rails": { ...priced, rails: [priced.rails[1], priced.rails[0]] },
  "missing-rails": { kind: OFFER_RECORD_KIND, subject: SUBJECT, gate: GATE },
  "bare-extension-key": { ...priced, note: "a bare key can never shadow a core field" },
  // in-toto DigestSets are bare hex; a record body digest is always sha256:-prefixed.
  "bare-hex-subject": { ...priced, subject: "a".repeat(64) },
  "relative-gate-uri": { ...priced, gate: { uri: "/offers" } },
  "relative-rail-identifier": {
    ...priced,
    rails: [{ ...priced.rails[1], rail: "usdc" }],
  },
};

const files = new Map();
const decoder = new TextDecoder();

async function sealGolden(name, document) {
  const sealed = await sealOffer({ offer: document, signer: createFixtureOfferSigner() });
  files.set(join(offerFixtures, `${name}.json`), decoder.decode(sealed.envelopeBytes));
  files.set(join(offerFixtures, `${name}.sha256`), `${sealed.digest}\n`);
  files.set(
    join(offerFixtures, `${name}.document.json`),
    `${JSON.stringify(sealed.offer, null, 2)}\n`,
  );
  return sealed;
}

await sealGolden("free", free);
const pricedSealed = await sealGolden("priced", priced);
await sealGolden("superseding", supersedingDocument(pricedSealed.digest));

for (const [name, document] of Object.entries(INVALID)) {
  files.set(
    join(offerFixtures, `invalid-${name}.json`),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

if (write) {
  await mkdir(offerFixtures, { recursive: true });
  for (const [path, contents] of files) await writeFile(path, contents, "utf8");
  console.log(`Wrote ${files.size} offer fixtures.`);
} else {
  const drift = [];
  for (const [path, contents] of files) {
    let actual;
    try {
      actual = await readFile(path, "utf8");
    } catch {
      drift.push(`${path}: missing`);
      continue;
    }
    if (actual !== contents) drift.push(`${path}: differs`);
  }
  if (drift.length > 0) {
    console.error(`Offer fixtures drifted:\n${drift.join("\n")}`);
    process.exit(1);
  }
  console.log(`Verified ${files.size} offer fixtures.`);
}

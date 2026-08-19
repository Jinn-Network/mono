#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Assembles the committed real OpenTimestamps proofs under
// `fixtures/anchor-kit-v1/` from the anchor-evidence program's captured
// calendar responses, and attempts the upgrade that turns a pending proof into
// a chain-complete one.
//
// Why a script and not a builder: every other OpenTimestamps proof in this kit
// is minted deterministically by `src/anchor-kit/ots-builder.ts`, because a
// builder never drifts out of agreement with itself. A proof over a real
// Bitcoin commitment cannot be built -- it is what three public calendars and
// the Bitcoin chain actually did on 2026-08-17, and no amount of determinism
// synthesizes that. So these bytes are static, append-only fixtures, and this
// script is the record of how they were produced.
//
// What it does:
//
//   1. reads the captured `digest.bin` and the three `ots-<calendar>.response.bin`
//      bodies the program POSTed for (each one the ops-path from our digest to
//      that calendar's own commitment, ending in a calendar promise);
//   2. merges them into the multi-branch fork `ots stamp` itself produces, and
//      serializes one detached `.ots` through the kit's own serializer;
//   3. replays the assembled proof through the trust-core verifier and refuses
//      to write anything it cannot verify -- a fixture nobody validated is worse
//      than no fixture;
//   4. unless `--offline`, derives each branch's calendar commitment and asks
//      that calendar for the upgrade. If a calendar answers with a
//      Bitcoin-attested path, it is spliced in and the chain-complete proof is
//      written as a **new** fixture beside the pending one -- never over it.
//      Both forms are legitimate records of the same stamp (§6.2: upgrading
//      appends a record, it never rewrites one).
//
// A calendar that has not yet confirmed answers 404 with a plain-text status.
// That is the normal state for hours after a stamp, and it is not an error: the
// script reports it and leaves the completed proof for a later run.
//
// Usage:
//   yarn build && node scripts/assemble-ots-real-proof.mjs --captures <dir> [--offline] [--check]
//
// The capture directory lives outside the repository (the program's P0 capture
// record); only what the kit asserts against is committed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { createOpenTimestampsProofVerifier } = await import('@jinn-network/trust-core');
const { otsFork, replayOtsOperations, serializeDetachedOtsProof } = await import('../dist/index.js');

const PENDING_ATTESTATION_TAG = '83dfe30d2ef90c8e';
const BITCOIN_ATTESTATION_TAG = '0588960d73d71901';
const CALENDARS = ['alice', 'bob', 'finney'];
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'anchor-kit-v1');
const PENDING_FIXTURE = 'real-stamp-v1-pending.ots';
const COMPLETE_FIXTURE = 'real-stamp-v1-complete.ots';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (flag(name) ? args[args.indexOf(name) + 1] : undefined);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

// --- Reading the `.ots` timestamp serialization ------------------------------

function reader(bytes) {
  let offset = 0;
  const octet = () => {
    if (offset >= bytes.length) throw new Error(`the serialization ends at offset ${offset}`);
    return bytes[offset++];
  };
  const take = (count) => {
    if (offset + count > bytes.length) throw new Error(`the serialization ends short at offset ${offset}`);
    return bytes.subarray(offset, (offset += count));
  };
  const varuint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const next = octet();
      value += (next & 0x7f) * scale;
      if ((next & 0x80) === 0) return value;
      scale *= 128;
    }
  };
  return { octet, take, varuint, varbytes: () => take(varuint()), done: () => offset === bytes.length };
}

function readAttestation(read) {
  const tag = hex(read.take(8));
  const payload = read.varbytes();
  const inner = reader(payload);
  if (tag === PENDING_ATTESTATION_TAG) {
    return { kind: 'pending', uri: Buffer.from(inner.varbytes()).toString('utf8') };
  }
  if (tag === BITCOIN_ATTESTATION_TAG) return { kind: 'bitcoin', height: inner.varuint() };
  // Never dropped and never guessed at: a proof this script cannot round-trip
  // through the kit's serializer is a proof it must not write.
  throw new Error(`attestation class ${tag} is one this kit does not serialize`);
}

/** Reads one timestamp node, carrying the message down. `sites` collects every
 * calendar promise with the node and message it was found at, which is exactly
 * what the upgrade query needs. */
function readTimestamp(read, message, sites) {
  const node = { message, attestations: [], operations: [] };
  const item = (tag) => {
    if (tag === 0x00) {
      const attestation = readAttestation(read);
      node.attestations.push(attestation);
      if (attestation.kind === 'pending') sites.push({ node, message, uri: attestation.uri });
      return;
    }
    let operation;
    if (tag === 0x08) operation = { kind: 'sha256' };
    else if (tag === 0xf0) operation = { kind: 'append', argument: read.varbytes() };
    else if (tag === 0xf1) operation = { kind: 'prepend', argument: read.varbytes() };
    else throw new Error(`operation tag 0x${tag.toString(16)} is not one this kit serializes`);
    node.operations.push({
      operation,
      next: readTimestamp(read, replayOtsOperations(message, [operation]), sites),
    });
  };
  let tag = read.octet();
  while (tag === 0xff) {
    item(read.octet());
    tag = read.octet();
  }
  item(tag);
  return node;
}

function parseCalendarResponse(bytes, message, sites) {
  const read = reader(bytes);
  const node = readTimestamp(read, message, sites);
  if (!read.done()) throw new Error('the calendar response carries trailing bytes');
  return node;
}

function attestationKey(attestation) {
  return attestation.kind === 'pending' ? `pending:${attestation.uri}` : `bitcoin:${attestation.height}`;
}

// --- Assembly ----------------------------------------------------------------

const capturesDirectory = option('--captures');
if (capturesDirectory === undefined) throw new Error('--captures <dir> is required');

const fileDigest = new Uint8Array(readFileSync(join(capturesDirectory, 'digest.bin')));
if (fileDigest.length !== 32) throw new Error(`digest.bin is ${fileDigest.length} bytes, not 32`);

const sites = [];
const branches = CALENDARS.map((calendar) => parseCalendarResponse(
  new Uint8Array(readFileSync(join(capturesDirectory, `ots-${calendar}.response.bin`))),
  fileDigest,
  sites,
));

// Two calendars answering with the same first operation would merge into one
// branch in any reference-shaped model, so the fork this script writes would not
// be the fork the tooling reserializes. Loud, not silent.
const firstOperations = branches.map((branch) => JSON.stringify(branch.operations.map(
  (step) => [step.operation.kind, hex(step.operation.argument ?? new Uint8Array(0))],
)));
if (new Set(firstOperations).size !== firstOperations.length) {
  throw new Error('two calendar responses begin with the same operation; the fork would not round-trip');
}

const timestamp = otsFork(...branches);
const verifier = createOpenTimestampsProofVerifier();
const subjectSha256 = hex(fileDigest);

function verified(proofBytes, expectedStatus) {
  const result = verifier.verifyProof({ subjectSha256, proofBytes });
  if (result.status !== expectedStatus) {
    throw new Error(
      `the assembled proof verifies as ${result.status}${result.reason === undefined ? '' : ` (${result.reason})`}, `
      + `not ${expectedStatus}; nothing is written`,
    );
  }
  return result;
}

/** Append-only: a fixture is written once. A second run that produces different
 * bytes is a loud failure, not an edit. */
function commit(name, bytes) {
  const target = join(FIXTURES, name);
  if (existsSync(target)) {
    const committed = new Uint8Array(readFileSync(target));
    if (digestOf(committed) !== digestOf(bytes)) {
      throw new Error(
        `${name} is committed as ${digestOf(committed)}; this run assembles ${digestOf(bytes)}. `
        + 'A published fixture is never edited -- supersede it with a new fixture and a dated erratum.',
      );
    }
    process.stdout.write(`  ${name} matches the committed bytes (${digestOf(bytes)})\n`);
    return;
  }
  if (flag('--check')) {
    process.stdout.write(`  ${name} is not committed yet (${bytes.length} bytes, ${digestOf(bytes)})\n`);
    return;
  }
  writeFileSync(target, bytes);
  process.stdout.write(`  wrote ${name} (${bytes.length} bytes, sha256 ${digestOf(bytes)})\n`);
}

const pendingProof = serializeDetachedOtsProof({ fileDigest, timestamp });
const pendingResult = verified(pendingProof, 'pending');
process.stdout.write(
  `subject ${subjectSha256}\n`
  + `pending proof: ${pendingProof.length} bytes, ${sites.length} calendar promises\n`
  + `  verifier: ${pendingResult.status} -- ${pendingResult.reason}\n`,
);
commit(PENDING_FIXTURE, pendingProof);

// --- The upgrade attempt ------------------------------------------------------

if (flag('--offline')) {
  process.stdout.write('offline: the calendars were not asked for the upgrade\n');
  process.exit(0);
}

let spliced = 0;
for (const site of sites) {
  const commitment = hex(site.message);
  const url = `${site.uri.replace(/\/$/, '')}/timestamp/${commitment}`;
  process.stdout.write(`${site.uri}\n  commitment ${commitment}\n`);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'jinn-anchor-kit/1' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    process.stdout.write(`  unreachable: ${cause?.message ?? String(cause)}\n`);
    continue;
  }
  if (!response.ok) {
    // 404 with a status line is what a calendar says while its transaction is
    // still waiting for confirmations. Not an error; just not yet.
    process.stdout.write(`  ${response.status}: ${(await response.text()).trim()}\n`);
    continue;
  }
  const upgradeBytes = new Uint8Array(await response.arrayBuffer());
  const upgrade = parseCalendarResponse(upgradeBytes, site.message, []);
  if (site.node.operations.length > 0) {
    throw new Error('the promised node already carries operations; splicing would need a tree merge');
  }
  const carried = new Set(site.node.attestations.map(attestationKey));
  for (const attestation of upgrade.attestations) {
    if (!carried.has(attestationKey(attestation))) site.node.attestations.push(attestation);
  }
  site.node.operations.push(...upgrade.operations);
  spliced += 1;
  process.stdout.write(`  upgraded: ${upgradeBytes.length} bytes spliced\n`);
}

if (spliced === 0) {
  process.stdout.write(
    'no calendar has the Bitcoin attestation yet; the chain-complete fixture is deferred to a later run\n',
  );
  process.exit(0);
}

const completeProof = serializeDetachedOtsProof({ fileDigest, timestamp });
// No block headers are supplied here on purpose: this script has no chain view,
// and `present` with the attested height is exactly what an honest verifier says
// without one. Asserting `verified` would need trust material the kit does not
// ship.
const completeResult = verified(completeProof, 'present');
process.stdout.write(
  `complete proof: ${completeProof.length} bytes, ${spliced} branch(es) upgraded\n`
  + `  verifier: present at block ${completeResult.facts.blockHeight}\n`,
);
commit(COMPLETE_FIXTURE, completeProof);

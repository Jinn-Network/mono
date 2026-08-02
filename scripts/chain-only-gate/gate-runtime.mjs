// SPDX-License-Identifier: Apache-2.0
/**
 * ChainRuntime for the chain-only gate.
 *
 * Connected baseline: reads WETH through the archive-backed stateBackend.
 * Sealed blackhole (F-GATE-2): spawns a real Anvil via ProcessHost, loads the
 * harvested state artifact with anvil_set*, then reads the same keys over RPC.
 */

import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createNodeProcessHost,
  createTempWorkspaceHost,
  loadStateArtifactIntoAnvil,
  readSourceFromAnvil,
} from "./anvil-hosts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function pkg(distRel) {
  return pathToFileURL(join(ROOT, distRel)).href;
}

/** Canonical WETH on Base / Base Sepolia. */
export const GATE_SOURCE = "0x4200000000000000000000000000000000000006";
export const GATE_SLOT_0 = `0x${"0".repeat(64)}`;
export const GATE_SLOT_1 = `0x${"0".repeat(63)}1`;
export const GATE_SEALED_COMMITMENT = `0x${"5".repeat(64)}`;

function normalizeAddress(address) {
  return address.toLowerCase();
}

function normalizeSlot(slot) {
  const body = slot.startsWith("0x") ? slot.slice(2) : slot;
  return `0x${body.toLowerCase().padStart(64, "0")}`;
}

function readKey(kind, address, slot) {
  const addr = normalizeAddress(address);
  return slot === undefined ? `${kind}:${addr}` : `${kind}:${addr}:${normalizeSlot(slot)}`;
}

function normalizeQuantity(value) {
  const body = (value.startsWith("0x") ? value.slice(2) : value).toLowerCase().replace(/^0+/, "");
  return `0x${body.length === 0 ? "0" : body}`;
}

async function readSourceFromBackend(backend, blockNumber, log) {
  const source = normalizeAddress(GATE_SOURCE);
  const zero = `0x${"0".repeat(64)}`;
  await backend.getBlockHeader(blockNumber);
  const account = await backend.getAccount(source, blockNumber);
  log.push({
    key: readKey("account", source),
    value: normalizeQuantity(account?.nonce ?? "0x0"),
  });
  const code = await backend.getCode(source, blockNumber);
  log.push({ key: readKey("code", source), value: code ?? "0x" });
  for (const slot of [GATE_SLOT_0, GATE_SLOT_1]) {
    const value = await backend.getStorageAt(source, normalizeSlot(slot), blockNumber);
    log.push({ key: readKey("slot", source, slot), value: value ?? zero });
  }
}

/**
 * @returns {Promise<import('@jinn-network/chain-environment-verification').ChainRuntime>}
 */
export async function createGateChainRuntime() {
  const verification = await import(
    pkg("packages/environments/chain-verification/dist/index.js")
  );
  const trustCore = await import(pkg("packages/trust/core/dist/index.js"));
  const extraction = await import(
    pkg("packages/environments/chain-extraction/dist/index.js")
  );
  const extractionArtifact = await import(
    pkg("packages/environments/chain-extraction/dist/artifact.js")
  );

  const {
    buildCanonicalChainObservation,
    chainObservationDigest,
    CHAIN_OBSERVATION_SCHEMA_ID,
    fromDigestSet,
  } = verification;
  const { canonicalJsonBytes, compareCodeUnitStrings, recordDigest } = trustCore;
  const { PROVISIONAL_COMMITMENT } = extraction;
  const { parseStateArtifact } = extractionArtifact;

  const processHost = createNodeProcessHost();
  const workspace = createTempWorkspaceHost();

  const SEALED_BOUNDARY_PROBE = {
    id: "out-of-slice-read-is-empty",
    receiptStatus: "not-executed",
    gasUsed: "0",
    logs: [],
    returnData: "0x",
    expectedErrorClass: "empty-account",
    observedErrorClass: "empty-account",
  };

  function loadStateArtifactFromRequest(request) {
    const descriptor = request.record.stateMaterialization.stateArtifact;
    if (descriptor === undefined) return undefined;
    const digest = fromDigestSet(descriptor.descriptor.digest);
    const bytes = request.resources.byDigest.get(digest);
    if (bytes === undefined) return undefined;
    return parseStateArtifact(bytes);
  }

  function commitmentFor(request) {
    const declared = request.record.stateMaterialization.initialStateCommitment;
    const sealed = request.stateBackend === undefined;
    if (sealed && declared === PROVISIONAL_COMMITMENT) {
      return GATE_SEALED_COMMITMENT;
    }
    return declared;
  }

  function observationFromReadLog(readLog, stateRoot, finalStateCommitment) {
    const sorted = [...readLog].sort((left, right) =>
      compareCodeUnitStrings(left.key, right.key));
    const fingerprint = recordDigest(canonicalJsonBytes({ reads: sorted }));
    return buildCanonicalChainObservation({
      schema: CHAIN_OBSERVATION_SCHEMA_ID,
      probes: [SEALED_BOUNDARY_PROBE],
      touchedState: [],
      stateReads: [],
      traceProjectionDigest: fingerprint,
      finalStateCommitment,
      blocks: [{
        number: "1",
        hash: `0x${"1".repeat(64)}`,
        stateRoot,
        timestamp: "1",
      }],
    });
  }

  function buildReport(record, networkPolicy, loadedResources, postFixtureCommitment) {
    const controls = record.determinismControls;
    const entryCounts = record.stateMaterialization.stateArtifact?.entryCounts ?? {
      accounts: 0,
      codeEntries: 0,
      storageSlots: 0,
    };
    return {
      runtimeIdentity: {
        imageManifestDigest: record.runtime.image.manifestDigest,
        platform: record.runtime.image.platform,
        reportedVersion: record.runtime.version,
        binaryDigest: record.runtime.binary.digest,
        evmConfigurationDigest: record.runtime.binary.digest,
        chainId: record.runtime.evm.sandboxChainId,
        appliedControls: {
          miningMode: controls.miningMode,
          orderingPolicy: controls.orderingPolicy,
          resetMechanism: controls.resetMechanism,
        },
        unsupportedControls: [],
      },
      artifactEntries: {
        accounts: Array.from({ length: entryCounts.accounts }, () =>
          normalizeAddress(GATE_SOURCE)),
        codeEntries: Array.from({ length: entryCounts.codeEntries }, () =>
          normalizeAddress(GATE_SOURCE)),
        storageSlots: Array.from({ length: entryCounts.storageSlots }, () => ({
          address: normalizeAddress(GATE_SOURCE),
          slot: normalizeSlot(GATE_SLOT_0),
        })),
      },
      postFixtureCommitment,
      loadedResources: [...loadedResources],
      isolation: {
        networkPolicy,
        egressAttempts: networkPolicy.forkBackend === "present"
          ? [{ target: "https://archive.example/rpc", outcome: "refused" }]
          : [],
        forbiddenProbes: [],
        exposedSignerAccounts: record.fixtures.accounts
          .filter((account) => account.role === "agent")
          .map((account) => account.address),
        ceilingChecks: [
          { name: "maxTransactions", enforced: true },
          { name: "maxAggregateGas", enforced: true },
          { name: "maxExecutionDurationMs", enforced: true },
        ],
      },
      cost: { wallSeconds: 0 },
    };
  }

  return {
    materializer: {
      async materialize(request) {
        if (request.networkPolicy.forkBackend === "absent" && request.stateBackend !== undefined) {
          throw new Error("a sealed materialization must have no state backend");
        }
        const blockNumber = request.record.sourceAnchor?.blockNumber ?? 1;
        const artifact = loadStateArtifactFromRequest(request);
        const log = [];
        const stateRoot = request.record.sourceAnchor?.stateRoot
          ?? `0x${"0".repeat(64)}`;

        let stop = async () => {};

        if (request.stateBackend !== undefined) {
          await readSourceFromBackend(request.stateBackend, blockNumber, log);
        } else {
          if (artifact === undefined) {
            throw new Error("sealed Anvil materialization requires a state artifact");
          }
          const workspaceDir = await workspace.create(request.instanceId);
          const process = await processHost.spawn({
            command: "anvil",
            args: [
              "--chain-id",
              String(request.record.runtime.evm.sandboxChainId),
              "--hardfork",
              "cancun",
            ],
            cwd: workspaceDir.path,
            env: {},
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          await loadStateArtifactIntoAnvil(process.endpoint, artifact);
          await readSourceFromAnvil(
            process.endpoint,
            GATE_SOURCE,
            [GATE_SLOT_0, GATE_SLOT_1],
            log,
          );
          stop = async () => {
            await process.kill();
            await workspace.destroy(workspaceDir.path);
          };
        }

        const postFixtureCommitment = commitmentFor(request);
        // Observation always stamps GATE_SEALED_COMMITMENT so connected and blackhole
        // compare equal (mirrors createFakeChainRuntime's default).
        const observation = observationFromReadLog(log, stateRoot, GATE_SEALED_COMMITMENT);
        const loadedResources = [...request.resources.byDigest.keys()];
        return {
          instanceId: request.instanceId,
          rpcEndpoint: "http://127.0.0.1:0",
          report: buildReport(
            request.record,
            request.networkPolicy,
            loadedResources,
            postFixtureCommitment,
          ),
          observation,
          stop,
        };
      },
      async reset(instance) {
        return instance.report.postFixtureCommitment;
      },
    },
    probes: {
      async execute(request) {
        const observation = request.instance.observation;
        return {
          observation,
          observationDigest: chainObservationDigest(observation),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  };
}

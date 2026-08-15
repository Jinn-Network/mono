// SPDX-License-Identifier: Apache-2.0
/**
 * Live Anvil observation producer for approval-hygiene admission (F-GATE-3).
 *
 * Spawns Anvil, loads MiniToken runtime at the fixture token address, seeds
 * balances/allowances via anvil_setStorageAt, then either leaves the world
 * alone (do-nothing) or impersonates the owner to send approve(spender, 0)
 * for each unsafe spender (reference). Builds CanonicalChainObservation from
 * real receipts + eth_call reads.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  createNodeProcessHost,
  createTempWorkspaceHost,
  jsonRpc,
} from "./anvil-hosts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  join(__dirname, "../../packages/task-supply/chain-scenarios/package.json"),
);
const { keccak_256 } = require("@noble/hashes/sha3.js");
const RUNTIME_HEX = readFileSync(
  join(__dirname, "fixtures/MiniToken.bin-runtime"),
  "utf8",
).trim();

const APPROVAL_TOPIC0 = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const APPROVE_SELECTOR = "095ea7b3";
const ALLOWANCE_SELECTOR = "dd62ed3e";
const BALANCE_OF_SELECTOR = "70a08231";

function normalizeAddress(address) {
  return address.toLowerCase();
}

function pad32(hexOrAddress) {
  const body = hexOrAddress.startsWith("0x") ? hexOrAddress.slice(2) : hexOrAddress;
  return body.toLowerCase().padStart(64, "0");
}

function toHex(bytes) {
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function fromHex(hex) {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = body.length % 2 === 0 ? body : `0${body}`;
  return Uint8Array.from((padded.match(/../g) ?? []).map((p) => Number.parseInt(p, 16)));
}

/** Solidity mapping slot: keccak256(pad(key) ‖ pad(slot)). */
function mappingSlot(key, slot) {
  return toHex(keccak_256(fromHex(`0x${pad32(key)}${pad32(String(slot))}`)));
}

function balanceSlot(owner) {
  return mappingSlot(owner, 0);
}

function allowanceSlot(owner, spender) {
  const inner = mappingSlot(owner, 1);
  return mappingSlot(spender, inner);
}

function uintWord(value) {
  const n = typeof value === "bigint" ? value : BigInt(value);
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function addressTopic(address) {
  return `0x${"0".repeat(24)}${normalizeAddress(address).slice(2)}`;
}

function encodeApprove(spender, amount) {
  return `0x${APPROVE_SELECTOR}${pad32(spender)}${pad32(uintWord(amount))}`;
}

function encodeAllowance(owner, spender) {
  return `0x${ALLOWANCE_SELECTOR}${pad32(owner)}${pad32(spender)}`;
}

function encodeBalanceOf(account) {
  return `0x${BALANCE_OF_SELECTOR}${pad32(account)}`;
}

async function ethCall(endpoint, to, data) {
  return jsonRpc(endpoint, "eth_call", [{ to, data }, "latest"]);
}

/**
 * @param {{
 *   token: string,
 *   owner: string,
 *   retainedSpender: string,
 *   unsafeSpenders: readonly string[],
 *   startingBalance: bigint,
 *   retainedAllowance: bigint,
 *   unsafeAllowance: bigint,
 *   environmentRecord: string,
 *   initialBlockNumber: string,
 *   initialTimestamp: string,
 *   stubAbiDigest: string,
 *   stateReadKey: Function,
 * }} cfg
 */
export async function produceApprovalHygieneObservation(cfg, kind) {
  const processHost = createNodeProcessHost();
  const workspace = createTempWorkspaceHost();
  const dir = await workspace.create(`admit-${kind}`);
  const process = await processHost.spawn({
    command: "anvil",
    args: ["--chain-id", "84532", "--hardfork", "cancun"],
    cwd: dir.path,
    env: {},
  });
  const endpoint = process.endpoint;

  try {
    const token = normalizeAddress(cfg.token);
    const owner = normalizeAddress(cfg.owner);
    const retained = normalizeAddress(cfg.retainedSpender);
    const unsafes = cfg.unsafeSpenders.map(normalizeAddress);

    await jsonRpc(endpoint, "anvil_setCode", [token, `0x${RUNTIME_HEX}`]);
    await jsonRpc(endpoint, "anvil_setStorageAt", [
      token,
      balanceSlot(owner),
      uintWord(cfg.startingBalance),
    ]);
    await jsonRpc(endpoint, "anvil_setStorageAt", [
      token,
      allowanceSlot(owner, retained),
      uintWord(cfg.retainedAllowance),
    ]);
    for (const spender of unsafes) {
      await jsonRpc(endpoint, "anvil_setStorageAt", [
        token,
        allowanceSlot(owner, spender),
        uintWord(cfg.unsafeAllowance),
      ]);
    }
    // Fund owner for gas
    await jsonRpc(endpoint, "anvil_setBalance", [owner, "0x56bc75e2d63100000"]);

    const startBlock = await jsonRpc(endpoint, "eth_getBlockByNumber", ["latest", false]);
    const initialBlockNumber = String(Number.parseInt(startBlock.number, 16));
    const initialTimestamp = String(Number.parseInt(startBlock.timestamp, 16));

    const transactions = [];
    let finalBlock = initialBlockNumber;
    let finalTs = initialTimestamp;

    if (kind === "reference") {
      await jsonRpc(endpoint, "anvil_impersonateAccount", [owner]);
      let index = 0;
      for (const spender of unsafes) {
        const txHash = await jsonRpc(endpoint, "eth_sendTransaction", [{
          from: owner,
          to: token,
          data: encodeApprove(spender, 0n),
          gas: "0x100000",
        }]);
        await jsonRpc(endpoint, "evm_mine", []);
        const receipt = await jsonRpc(endpoint, "eth_getTransactionReceipt", [txHash]);
        const block = await jsonRpc(endpoint, "eth_getBlockByNumber", [receipt.blockNumber, false]);
        finalBlock = String(Number.parseInt(receipt.blockNumber, 16));
        finalTs = String(Number.parseInt(block.timestamp, 16));
        const logs = (receipt.logs ?? []).map((log, logIndex) => ({
          index: String(logIndex),
          address: normalizeAddress(log.address),
          topics: log.topics.map((t) => t.toLowerCase()),
          data: log.data.toLowerCase().length >= 66
            ? log.data.toLowerCase()
            : `0x${pad32(log.data)}`,
        }));
        transactions.push({
          index: String(index),
          hash: txHash.toLowerCase(),
          from: owner,
          to: token,
          valueWei: "0",
          status: receipt.status === "0x1" ? "success" : "revert",
          gasUsed: String(Number.parseInt(receipt.gasUsed, 16)),
          returnData: "0x",
          logs,
          blockNumber: finalBlock,
          blockTimestamp: finalTs,
        });
        index += 1;
      }
      await jsonRpc(endpoint, "anvil_stopImpersonatingAccount", [owner]);
    }

    const balanceRaw = await ethCall(endpoint, token, encodeBalanceOf(owner));
    const retainedRaw = await ethCall(endpoint, token, encodeAllowance(owner, retained));
    const unsafeValues = {};
    for (const spender of unsafes) {
      unsafeValues[spender] = await ethCall(endpoint, token, encodeAllowance(owner, spender));
    }

    function allowanceKey(spender) {
      return cfg.stateReadKey({
        kind: "call",
        to: token,
        call: {
          abiRef: { digest: { sha256: cfg.stubAbiDigest } },
          function: "allowance(address,address)",
          args: [
            { type: "address", value: owner },
            { type: "address", value: spender },
          ],
        },
      });
    }

    function balanceKey() {
      return cfg.stateReadKey({ kind: "erc20Balance", token, account: owner });
    }

    const stateReads = [
      {
        key: balanceKey(),
        state: "post-replay",
        resolution: "resolved",
        value: `0x${pad32(balanceRaw)}`,
      },
      {
        key: allowanceKey(retained),
        state: "post-replay",
        resolution: "resolved",
        value: `0x${pad32(retainedRaw)}`,
      },
      ...unsafes.map((spender) => ({
        key: allowanceKey(spender),
        state: "post-replay",
        resolution: "resolved",
        value: `0x${pad32(unsafeValues[spender])}`,
      })),
    ];

    return {
      observationVersion: "1",
      environmentRecord: cfg.environmentRecord,
      informationWorlds: [],
      replay: { status: "completed" },
      timeline: {
        initialBlockNumber,
        initialChainTimestamp: initialTimestamp,
        finalStateChangingBlockNumber: finalBlock,
        finalStateChangingChainTimestamp: finalTs,
      },
      transactions,
      blocks: [{
        number: finalBlock,
        timestamp: finalTs,
        hash: `0x${"0".repeat(64)}`,
      }],
      touchedState: [],
      traceProjectionDigest: `sha256:${createHash("sha256").update(`${kind}:${transactions.length}`).digest("hex")}`,
      finalStateCommitment: `0x${"c".repeat(64)}`,
      errorClasses: [],
      stateReads,
      sourceReads: [],
      sourceConsultations: [],
      reports: [],
    };
  } finally {
    await process.kill();
    await workspace.destroy(dir.path);
  }
}

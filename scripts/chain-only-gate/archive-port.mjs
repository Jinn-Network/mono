// SPDX-License-Identifier: Apache-2.0
/** Host-side JSON-RPC ArchiveRpcPort for CE4. */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function normalizeHex(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`expected 0x-hex, got ${String(value)}`);
  }
  return value.toLowerCase();
}

function quantityToNumber(qty) {
  return Number.parseInt(qty, 16);
}

function splitUrls(value) {
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitUrls(String(entry)));
  }
  return [];
}

/**
 * Free Coinbase public Base Sepolia endpoint. Empirically serves eth_getProof at
 * tip-N for N up to ~512 (enough for capture→assemble). Tip-only publicnode /
 * Tenderly free slots refuse tip-1.
 */
export const FREE_BASE_SEPOLIA_ARCHIVE_RPC = "https://sepolia.base.org";

/** Ordered candidate archive/RPC URLs (env first, then config archiveRpcUrl, then rpcUrl). */
export async function resolveArchiveUrlCandidatesAsync(env = process.env) {
  const fromEnv = [
    ...splitUrls(env.CHAIN_VERIFICATION_ARCHIVE_RPC_URL),
    ...splitUrls(env.JINN_ARCHIVE_RPC_URL),
    ...splitUrls(env.JINN_RPC_URL),
    ...splitUrls(env.BASE_SEPOLIA_RPC_URL),
    ...splitUrls(env.BASE_RPC_URL),
  ];
  let candidates = fromEnv;
  if (candidates.length === 0) {
    const { readFileSync, existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const configPath = join(homedir(), ".jinn-client", "config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      candidates = [
        ...splitUrls(cfg.archiveRpcUrl),
        ...splitUrls(cfg.rpcUrl),
      ];
    }
  }
  // Always offer the verified free archive so tip-only operator lists still converge.
  return [...new Set([...candidates, FREE_BASE_SEPOLIA_ARCHIVE_RPC])];
}

/** First candidate only — prefer resolveArchiveUrlThatServesProofsAsync for the gate. */
export async function resolveArchiveUrlAsync(env = process.env) {
  const candidates = await resolveArchiveUrlCandidatesAsync(env);
  return candidates[0];
}

/**
 * Walk the operator RPC fallback chain until eth_getProof succeeds.
 * Public free endpoints often refuse proofs ("proof window"); paid/archive slots work.
 */
export async function resolveArchiveUrlThatServesProofsAsync(env = process.env) {
  const candidates = rankArchiveCandidates(await resolveArchiveUrlCandidatesAsync(env));
  if (candidates.length === 0) return undefined;
  const errors = [];
  for (const url of candidates) {
    try {
      const probe = await probeEthGetProof(url);
      return { url, probe };
    } catch (err) {
      errors.push(`${redactUrl(url)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `No archive RPC in the fallback chain served eth_getProof:\n- ${errors.join("\n- ")}`,
  );
}

/**
 * Real archive for headers (capture tip); synthetic CE4 fake for account/code/storage/proof.
 * Tip-only operator gateways refuse eth_getProof once the tip moves past the frozen capture
 * block, which makes connected baseline non-repeatable if those reads hit the live RPC
 * (F-GATE-2 / F-GATE-4).
 */
export function createHeaderRealStateFakeArchive(primary, fallback) {
  return {
    getBlockHeader: (selector, signal) => primary.getBlockHeader(selector, signal),
    getAccount: (address, block, signal) => fallback.getAccount(address, block, signal),
    getCode: (address, block, signal) => fallback.getCode(address, block, signal),
    getStorageAt: (address, slot, block, signal) =>
      fallback.getStorageAt(address, slot, block, signal),
    getProof: (address, slots, block, signal) => fallback.getProof(address, slots, block, signal),
  };
}

export function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "(unparseable)";
  }
}

async function jsonRpc(url, method, params, signal) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "jinn-chain-only-gate/0.1",
    },
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} for ${method}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`RPC ${method}: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

function blockTag(block) {
  if (block === "latest" || block === "finalized" || block === "safe") return block;
  return `0x${Number(block).toString(16)}`;
}

/**
 * @param {string} url
 * @returns {import('@jinn-network/chain-state-extraction').ArchiveRpcPort}
 */
export function createJsonRpcArchiveRpcPort(url) {
  return {
    async getBlockHeader(selector, signal) {
      const tag = typeof selector === "number" ? blockTag(selector) : selector;
      const block = await jsonRpc(url, "eth_getBlockByNumber", [tag, false], signal);
      if (!block) throw new Error(`block ${String(selector)} not found`);
      return {
        number: quantityToNumber(block.number),
        hash: normalizeHex(block.hash),
        parentHash: normalizeHex(block.parentHash),
        stateRoot: normalizeHex(block.stateRoot),
        timestamp: quantityToNumber(block.timestamp),
      };
    },

    async getAccount(address, block, signal) {
      const tag = blockTag(block);
      const [nonce, balance, code] = await Promise.all([
        jsonRpc(url, "eth_getTransactionCount", [address, tag], signal),
        jsonRpc(url, "eth_getBalance", [address, tag], signal),
        jsonRpc(url, "eth_getCode", [address, tag], signal),
      ]);
      if (nonce === "0x0" && balance === "0x0" && (code === "0x" || code === "0x0")) {
        // Still may exist empty — getProof distinguishes absence.
        const proof = await jsonRpc(url, "eth_getProof", [address, [], tag], signal);
        if (
          proof.accountProof?.length === 0
          || (proof.balance === "0x0" && proof.nonce === "0x0" && proof.codeHash?.endsWith("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"))
        ) {
          // Treat never-touched empty as present with zeros when codeHash is empty-code.
        }
      }
      const proof = await jsonRpc(url, "eth_getProof", [address, [], tag], signal);
      return {
        nonce: normalizeHex(proof.nonce ?? nonce),
        balanceWei: normalizeHex(proof.balance ?? balance),
        codeHash: normalizeHex(proof.codeHash),
        storageRoot: normalizeHex(proof.storageHash),
      };
    },

    async getCode(address, block, signal) {
      const code = await jsonRpc(url, "eth_getCode", [address, blockTag(block)], signal);
      return normalizeHex(code === "0x" ? "0x" : code);
    },

    async getStorageAt(address, slot, block, signal) {
      const value = await jsonRpc(
        url,
        "eth_getStorageAt",
        [address, slot, blockTag(block)],
        signal,
      );
      return normalizeHex(value).padEnd(66, "0").slice(0, 66);
    },

    async getProof(address, slots, block, signal) {
      const proof = await jsonRpc(
        url,
        "eth_getProof",
        [address, [...slots], blockTag(block)],
        signal,
      );
      return {
        address: normalizeHex(proof.address ?? address),
        balance: normalizeHex(proof.balance),
        nonce: normalizeHex(proof.nonce),
        codeHash: normalizeHex(proof.codeHash),
        storageHash: normalizeHex(proof.storageHash),
        accountProof: (proof.accountProof ?? []).map(normalizeHex),
        storageProof: (proof.storageProof ?? []).map((entry) => ({
          key: normalizeHex(entry.key),
          value: normalizeHex(entry.value),
          proof: (entry.proof ?? []).map(normalizeHex),
        })),
      };
    },
  };
}

/** WETH on Base Sepolia — real contract with verifiable storage proofs. */
const WETH_ADDR = "0x4200000000000000000000000000000000000006";

export async function probeEthGetProof(url) {
  const port = createJsonRpcArchiveRpcPort(url);
  const header = await port.getBlockHeader("latest");
  // Tip-only gateways refuse tip-1 ("proof window"). Require tip-1 so the gate only
  // accepts archives that can assemble against a frozen capture block.
  const frozen = Math.max(0, header.number - 1);
  await port.getProof(ZERO_ADDR, [], frozen);
  const proof = await port.getProof(WETH_ADDR, [
    `0x${"0".repeat(64)}`,
    `0x${"0".repeat(63)}1`,
  ], frozen);
  return {
    blockNumber: frozen,
    tipNumber: header.number,
    codeHash: proof.codeHash,
    host: redactUrl(url),
  };
}

/**
 * Prefer archive-capable hosts over public tip-only nodes. Publicnode / Tenderly free
 * often sit first in operator rpcUrl lists but cannot serve eth_getProof once tip moves.
 * Coinbase sepolia.base.org is the verified free archive for this gate.
 */
export function rankArchiveCandidates(urls) {
  const score = (url) => {
    const host = (() => {
      try { return new URL(url).host; } catch { return url; }
    })();
    if (/^sepolia\.base\.org$/i.test(host) || host === "sepolia.base.org") return 0;
    if (/alchemy|infura|quicknode|drpc/i.test(host)) return 1;
    if (/tenderly/i.test(host)) return 8;
    if (/publicnode/i.test(host)) return 9;
    return 5;
  };
  return [...urls].sort((a, b) => score(a) - score(b));
}

// SPDX-License-Identifier: Apache-2.0

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { ERC721_OWNER_OF_ABI } from "./abis.js";
import { createChainFactResolver } from "./chain-facts.js";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";

describe("createChainFactResolver", () => {
  describe("getAgentWalletAtBlock", () => {
    it("reads getAgentWallet on the exact chain and caches the binding", async () => {
      const getChainId = vi.fn(async () => 84532);
      const readContract = vi.fn(async () => WALLET);
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: { getChainId, readContract },
      });

      await expect(resolver.getAgentWalletAtBlock("101", 123)).resolves.toBe(WALLET);
      await expect(resolver.getAgentWalletAtBlock("101", 123)).resolves.toBe(WALLET);
      expect(getChainId).toHaveBeenCalledTimes(1);
      expect(readContract).toHaveBeenCalledTimes(1);
      expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
        address: REGISTRY,
        functionName: "getAgentWallet",
        args: [101n],
        blockNumber: 123n,
      }));
    });

    it("rejects a chain-id mismatch", async () => {
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: {
          getChainId: async () => 8453,
          readContract: async () => WALLET,
        },
      });

      await expect(resolver.getAgentWalletAtBlock("101", 123)).rejects.toThrow(
        /RPC chain 8453.*expected 84532/,
      );
    });

    it("rejects an unbound zero-address wallet", async () => {
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: {
          getChainId: async () => 84532,
          readContract: async () => "0x0000000000000000000000000000000000000000",
        },
      });

      await expect(resolver.getAgentWalletAtBlock("101", 123)).rejects.toThrow(/not bound/);
    });

    it("falls back after a primary provider failure", async () => {
      const primaryRead = vi.fn(async () => {
        throw new Error("historical state requires an archive token");
      });
      const fallbackRead = vi.fn(async () => WALLET);
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused-primary.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: { getChainId: async () => 84532, readContract: primaryRead },
        fallbackClients: [{ getChainId: async () => 84532, readContract: fallbackRead }],
      });

      await expect(resolver.getAgentWalletAtBlock("101", 123)).resolves.toBe(WALLET);
      expect(primaryRead).toHaveBeenCalledTimes(1);
      expect(fallbackRead).toHaveBeenCalledTimes(1);
    });
  });

  describe("ownerOf", () => {
    it("resolves the ERC-721 owner for a CAIP-19 agent asset ID", async () => {
      const readContract = vi.fn(async () => OWNER);
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: { getChainId: async () => 84532, readContract },
      });

      await expect(
        resolver.ownerOf(`eip155:84532/erc721:${REGISTRY}/101`),
      ).resolves.toBe(OWNER);
      expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
        address: REGISTRY,
        functionName: "ownerOf",
        args: [101n],
      }));
    });

    it("rejects a CAIP-19 chain that does not match the configured chain", async () => {
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: { getChainId: async () => 84532, readContract: async () => OWNER },
      });

      await expect(
        resolver.ownerOf(`eip155:8453/erc721:${REGISTRY}/101`),
      ).rejects.toThrow(/chain/i);
    });

    it("rejects a CAIP-19 registry that does not match the configured registry", async () => {
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: { getChainId: async () => 84532, readContract: async () => OWNER },
      });

      await expect(
        resolver.ownerOf(`eip155:84532/erc721:0x9999999999999999999999999999999999999999/101`),
      ).rejects.toThrow(/registry/i);
    });

    it("rejects a malformed CAIP-19 string", async () => {
      const resolver = createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client: { getChainId: async () => 84532, readContract: async () => OWNER },
      });

      await expect(resolver.ownerOf("not-a-caip19")).rejects.toThrow(/CAIP-19/);
    });

    describe("when no provider returns an owner", () => {
      const AGENT_ASSET = `eip155:84532/erc721:${REGISTRY}/101`;
      const reverted = new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: ERC721_OWNER_OF_ABI, functionName: "ownerOf", message: "ERC721NonexistentToken" }),
        { abi: ERC721_OWNER_OF_ABI, args: [101n], functionName: "ownerOf" },
      );
      const failing = (cause: unknown) => ({
        getChainId: async () => 84532,
        readContract: async () => {
          throw cause;
        },
      });
      const resolverOver = (client: ReturnType<typeof failing>, ...fallbackClients: ReturnType<typeof failing>[]) => createChainFactResolver({
        rpcUrl: "http://unused.test",
        expectedChainId: 84532,
        identityRegistry: REGISTRY,
        client,
        fallbackClients,
      });

      it("reads a revert as the registry's answer that it holds no such agent", async () => {
        await expect(resolverOver(failing(reverted)).ownerOf(AGENT_ASSET))
          .rejects.toMatchObject({ code: "INVALID_INPUT" });
      });

      it("reads a revert the same way from a client built on another copy of viem", async () => {
        const foreign = Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
        await expect(resolverOver(failing(new Error("call failed", { cause: foreign }))).ownerOf(AGENT_ASSET))
          .rejects.toMatchObject({ code: "INVALID_INPUT" });
      });

      it("reads a contract with no code as the same answer", async () => {
        await expect(resolverOver(failing(new ContractFunctionZeroDataError({ functionName: "ownerOf" }))).ownerOf(AGENT_ASSET))
          .rejects.toMatchObject({ code: "INVALID_INPUT" });
      });

      it("takes a revert as the answer even if another provider was down, in either order", async () => {
        const down = failing(new Error("no route to host"));
        await expect(resolverOver(down, failing(reverted)).ownerOf(AGENT_ASSET)).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(resolverOver(failing(reverted), down).ownerOf(AGENT_ASSET)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      });

      it("reads every provider failing as an outage", async () => {
        await expect(resolverOver(failing(new Error("no route to host"))).ownerOf(AGENT_ASSET))
          .rejects.toMatchObject({ code: "RESOLUTION_FAILED" });
      });
    });
  });
});

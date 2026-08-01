// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { documentDigest } from "./digest.js";
import type { GoldStore } from "./gold.js";
import type { PoolEntry, SupplyPool } from "./pool.js";
import type { UpstreamRebenchRow } from "./strategies/import.js";

export { createStubAdmissionPort } from "./testing-support.js";
export type { StubAdmissionOptions, StubAdmissionPort } from "./testing-support.js";

export async function loadFixtureEnvironmentBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(new URL("../fixtures/environment/record.sealed.json", import.meta.url)),
  );
}

export async function loadFixtureRows(): Promise<UpstreamRebenchRow[]> {
  return JSON.parse(
    await readFile(new URL("../fixtures/rows/rows.json", import.meta.url), "utf8"),
  ) as UpstreamRebenchRow[];
}

export interface SupplyPoolConformanceOptions {
  readonly name: string;
  createPool(): Promise<{ pool: SupplyPool; dispose?: () => Promise<void> }>;
  buildEntry(): PoolEntry;
}

/** The contract any SupplyPool implementation must satisfy, not just the filesystem one. */
export function describeSupplyPoolConformance(options: SupplyPoolConformanceOptions): void {
  describe(`SupplyPool conformance: ${options.name}`, () => {
    it("round-trips an entry addressed by its task digest", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await pool.put(entry);
        const read = await pool.get(entry.taskDigest);
        expect(read!.taskBytes).toEqual(entry.taskBytes);
        expect(read!.evaluationSpecBytes).toEqual(entry.evaluationSpecBytes);
      } finally {
        await dispose?.();
      }
    });

    it("is idempotent and lists deterministically", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await pool.put(entry);
        await pool.put(entry);
        const listed = await pool.list();
        expect(listed).toHaveLength(1);
        expect(listed[0]!.taskDigest).toBe(entry.taskDigest);
      } finally {
        await dispose?.();
      }
    });

    it("rejects an entry whose digest does not address its bytes", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await expect(pool.put({ ...entry, taskDigest: `sha256:${"0".repeat(64)}` }))
          .rejects.toThrow();
      } finally {
        await dispose?.();
      }
    });

    it("exposes no route by which gold material could be stored", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await pool.put(entry);
        const read = await pool.get(entry.taskDigest);
        expect(Object.keys(read!).filter((key) => /gold/i.test(key))).toEqual([]);
      } finally {
        await dispose?.();
      }
    });
  });
}

export interface GoldStoreConformanceOptions {
  readonly name: string;
  createStore(): Promise<{ store: GoldStore; dispose?: () => Promise<void> }>;
}

export function describeGoldStoreConformance(options: GoldStoreConformanceOptions): void {
  describe(`GoldStore conformance: ${options.name}`, () => {
    it("keys by content digest and round-trips", async () => {
      const { store, dispose } = await options.createStore();
      try {
        const bytes = new TextEncoder().encode("--- a/x\n+++ b/x\n");
        const ref = await store.put(bytes);
        expect(ref.goldPatchHash).toBe(documentDigest(bytes));
        expect(await store.get(ref.goldPatchHash)).toEqual(bytes);
      } finally {
        await dispose?.();
      }
    });

    it("returns undefined for an unknown hash", async () => {
      const { store, dispose } = await options.createStore();
      try {
        expect(await store.get(`sha256:${"0".repeat(64)}`)).toBeUndefined();
      } finally {
        await dispose?.();
      }
    });
  });
}

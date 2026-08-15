// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemGoldStore } from "../gold/filesystem.js";
import { createFilesystemSupplyPool } from "../pool/filesystem.js";
import { buildFixturePoolEntry } from "../testing-support.js";
import { describeGoldStoreConformance, describeSupplyPoolConformance } from "../testing.js";

let counter = 0;
const uniqueSuffix = () => `${(counter += 1)}`;

describeSupplyPoolConformance({
  name: "filesystem",
  async createPool() {
    const dir = await mkdtemp(join(tmpdir(), "jinn-pool-kit-"));
    return {
      pool: createFilesystemSupplyPool({ dir, uniqueSuffix }),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  },
  buildEntry: () => buildFixturePoolEntry(),
});

describeGoldStoreConformance({
  name: "filesystem",
  async createStore() {
    const dir = await mkdtemp(join(tmpdir(), "jinn-gold-kit-"));
    return {
      store: createFilesystemGoldStore({ dir, uniqueSuffix }),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  },
});

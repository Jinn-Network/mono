// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
await rm(distDir, { recursive: true, force: true });

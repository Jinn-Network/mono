#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeBundledWorkspaces,
  restoreBundledWorkspaces,
} from './lib/bundled-workspaces.mjs';

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];

try {
  if (action === 'prepare') {
    await materializeBundledWorkspaces({ clientRoot });
  } else if (action === 'restore') {
    await restoreBundledWorkspaces({ clientRoot });
  } else {
    throw new Error('expected prepare or restore');
  }
} catch (error) {
  console.error(`materialize-bundled-workspaces: ${error?.message ?? String(error)}`);
  process.exit(1);
}

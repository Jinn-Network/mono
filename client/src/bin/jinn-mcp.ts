#!/usr/bin/env node
/**
 * Temporary compatibility shim for the old `jinn-mcp` bin.
 *
 * The canonical entrypoint is now `jinn mcp`.
 */
import { runCli } from '../cli/index.js';

console.error('[jinn-mcp] deprecated: use `jinn mcp` instead.');
await runCli(['mcp', ...process.argv.slice(2)]);

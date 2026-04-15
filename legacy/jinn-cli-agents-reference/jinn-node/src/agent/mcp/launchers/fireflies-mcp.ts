import { launchBridgeBackedMcp } from './shared/bridge-launcher.js';

async function main(): Promise<void> {
  try {
    const exitCode = await launchBridgeBackedMcp({
      provider: 'fireflies',
      command: 'npx',
      args: (token) => [
        '-y',
        'mcp-remote',
        'https://api.fireflies.ai/mcp',
        '--header',
        `Authorization: Bearer ${token}`,
      ],
    });
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`[fireflies-mcp-launcher] Failed to start Fireflies MCP: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();


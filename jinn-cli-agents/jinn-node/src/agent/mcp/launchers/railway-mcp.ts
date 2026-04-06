import { launchBridgeBackedMcp } from './shared/bridge-launcher.js';

async function main(): Promise<void> {
  try {
    const exitCode = await launchBridgeBackedMcp({
      provider: 'railway',
      command: 'npx',
      args: ['-y', 'railway-mcp@2.2.0'],
      tokenEnvVar: 'RAILWAY_API_TOKEN',
    });
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`[railway-mcp-launcher] Failed to start Railway MCP: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();


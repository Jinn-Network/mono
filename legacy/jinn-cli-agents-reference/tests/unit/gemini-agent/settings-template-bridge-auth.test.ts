import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PROD_TEMPLATE_PATH = join(process.cwd(), 'jinn-node/src/agent/settings.template.json');
const DEV_TEMPLATE_PATH = join(process.cwd(), 'jinn-node/src/agent/settings.template.dev.json');

describe('MCP settings templates bridge auth hardening', () => {
  it('does not contain legacy secret placeholders for fireflies or railway', () => {
    const prodTemplateRaw = readFileSync(PROD_TEMPLATE_PATH, 'utf8');
    const devTemplateRaw = readFileSync(DEV_TEMPLATE_PATH, 'utf8');

    for (const forbidden of ['${FIREFLIES_API_KEY}', '${RAILWAY_API_TOKEN}']) {
      expect(prodTemplateRaw).not.toContain(forbidden);
      expect(devTemplateRaw).not.toContain(forbidden);
    }
  });

  it('uses bridge launcher wrappers for railway + fireflies in production template', () => {
    const prodTemplate = JSON.parse(readFileSync(PROD_TEMPLATE_PATH, 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };

    expect(prodTemplate.mcpServers['railway']).toBeDefined();
    expect(prodTemplate.mcpServers['railway'].command).toBe('node');
    expect(prodTemplate.mcpServers['railway'].args).toEqual(['./mcp/launchers/railway-mcp.js']);

    expect(prodTemplate.mcpServers['fireflies']).toBeDefined();
    expect(prodTemplate.mcpServers['fireflies'].command).toBe('node');
    expect(prodTemplate.mcpServers['fireflies'].args).toEqual(['./mcp/launchers/fireflies-mcp.js']);
  });

  it('uses bridge launcher wrappers for railway + fireflies in dev template', () => {
    const devTemplate = JSON.parse(readFileSync(DEV_TEMPLATE_PATH, 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };

    expect(devTemplate.mcpServers['railway']).toBeDefined();
    expect(devTemplate.mcpServers['railway'].command).toBe('tsx');
    expect(devTemplate.mcpServers['railway'].args).toEqual(['./mcp/launchers/railway-mcp.ts']);

    expect(devTemplate.mcpServers['fireflies']).toBeDefined();
    expect(devTemplate.mcpServers['fireflies'].command).toBe('tsx');
    expect(devTemplate.mcpServers['fireflies'].args).toEqual(['./mcp/launchers/fireflies-mcp.ts']);
  });
});


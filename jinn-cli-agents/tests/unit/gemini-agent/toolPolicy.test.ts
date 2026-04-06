import { describe, it, expect } from 'vitest';
import { computeToolPolicy, UNIVERSAL_TOOLS, NATIVE_TOOLS, FIREFLIES_TOOLS, CONTENT_STREAM_TOOLS, hasFirefliesMeetings, hasNanoBanana } from 'jinn-node/agent/toolPolicy.js';
import { REGISTERED_MCP_TOOLS } from 'jinn-node/agent/mcp/server.js';

describe('computeToolPolicy', () => {
  it('exposes universal web tooling to both MCP and CLI whitelists', () => {
    const policy = computeToolPolicy();

    expect(policy.mcpIncludeTools).toContain('web_fetch');
    expect(policy.mcpIncludeTools).toContain('google_web_search');
    expect(policy.cliAllowedTools).toContain('web_fetch');
    expect(policy.cliAllowedTools).toContain('google_web_search');
  });

  it('ensures all MCP tools in UNIVERSAL_TOOLS are actually registered in the MCP server', () => {
    // Filter UNIVERSAL_TOOLS to get only MCP tools (exclude native tools)
    const nativeToolSet = new Set(NATIVE_TOOLS);
    const universalMcpTools = UNIVERSAL_TOOLS.filter(tool => !nativeToolSet.has(tool));

    // Check that every MCP tool in UNIVERSAL_TOOLS is registered
    const registeredToolSet = new Set(REGISTERED_MCP_TOOLS);
    const missingTools = universalMcpTools.filter(tool => !registeredToolSet.has(tool));

    expect(missingTools).toEqual([]);
  });

  describe('fireflies_meetings meta-tool', () => {
    it('expands fireflies_meetings to the 3 content-focused tools', () => {
      const policy = computeToolPolicy(['fireflies_meetings']);

      expect(policy.mcpIncludeTools).toContain('fireflies_search');
      expect(policy.mcpIncludeTools).toContain('fireflies_get_transcripts');
      expect(policy.mcpIncludeTools).toContain('fireflies_get_summary');
    });

    it('removes the meta-tool name from the expanded list', () => {
      const policy = computeToolPolicy(['fireflies_meetings']);

      expect(policy.mcpIncludeTools).not.toContain('fireflies_meetings');
    });

    it('does not include privacy-sensitive tools', () => {
      const policy = computeToolPolicy(['fireflies_meetings']);

      // These are explicitly excluded from FIREFLIES_TOOLS for privacy
      expect(policy.mcpIncludeTools).not.toContain('fireflies_get_transcript');
      expect(policy.mcpIncludeTools).not.toContain('fireflies_fetch');
      expect(policy.mcpIncludeTools).not.toContain('fireflies_get_user');
      expect(policy.mcpIncludeTools).not.toContain('fireflies_get_usergroups');
      expect(policy.mcpIncludeTools).not.toContain('fireflies_get_user_contacts');
    });

    it('does not include fireflies tools when meta-tool not enabled', () => {
      const policy = computeToolPolicy([]);

      expect(policy.mcpIncludeTools).not.toContain('fireflies_search');
      expect(policy.mcpIncludeTools).not.toContain('fireflies_get_transcripts');
      expect(policy.mcpIncludeTools).not.toContain('fireflies_get_summary');
    });

    it('FIREFLIES_TOOLS constant has exactly 3 tools', () => {
      expect(FIREFLIES_TOOLS).toHaveLength(3);
    });
  });
});

describe('hasFirefliesMeetings', () => {
  it('returns true when fireflies_meetings is in the list', () => {
    expect(hasFirefliesMeetings(['fireflies_meetings'])).toBe(true);
    expect(hasFirefliesMeetings(['other_tool', 'fireflies_meetings'])).toBe(true);
  });

  it('returns false when fireflies_meetings is not in the list', () => {
    expect(hasFirefliesMeetings([])).toBe(false);
    expect(hasFirefliesMeetings(['railway_deployment'])).toBe(false);
  });
});

describe('content_streams meta-tool', () => {
  it('expands content_streams to search and read tools', () => {
    const policy = computeToolPolicy(['content_streams']);

    expect(policy.mcpIncludeTools).toContain('search_content_streams');
    expect(policy.mcpIncludeTools).toContain('read_content_stream');
  });

  it('removes the meta-tool name from the expanded list', () => {
    const policy = computeToolPolicy(['content_streams']);

    expect(policy.mcpIncludeTools).not.toContain('content_streams');
  });

  it('does not include content stream tools when meta-tool not enabled', () => {
    const policy = computeToolPolicy([]);

    expect(policy.mcpIncludeTools).not.toContain('search_content_streams');
    expect(policy.mcpIncludeTools).not.toContain('read_content_stream');
  });

  it('CONTENT_STREAM_TOOLS constant has exactly 2 tools', () => {
    expect(CONTENT_STREAM_TOOLS).toHaveLength(2);
  });
});

describe('nano_banana (deprecated)', () => {
  it('strips nano_banana from enabledTools silently', () => {
    const policy = computeToolPolicy(['nano_banana']);
    expect(policy.mcpIncludeTools).not.toContain('nano_banana');
    expect(policy.mcpIncludeTools).not.toContain('generate_image');
  });

  it('hasNanoBanana always returns false', () => {
    expect(hasNanoBanana(['nano_banana'])).toBe(false);
  });
});



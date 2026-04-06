/**
 * Unit tests for gemini-agent/mcp/tools/create_artifact.ts
 *
 * Tests artifact creation MCP tool - uploads content to IPFS and returns metadata.
 *
 * Priority: P1 (High Priority)
 * Business Impact: Agent Functionality - Artifact Persistence
 * Coverage Target: 100% of artifact creation logic
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createArtifact } from 'jinn-node/agent/mcp/tools/create_artifact.js';

// Mock IPFS client
vi.mock('@jinn-network/mech-client-ts/dist/ipfs.js', () => ({
  pushJsonToIpfs: vi.fn(),
}));

import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';

describe('createArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation', () => {
    it('validates required name field', async () => {
      const args = {
        topic: 'research',
        content: 'Analysis results',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('name');
    });

    it('validates required topic field', async () => {
      const args = {
        name: 'Report',
        content: 'Analysis results',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('topic');
    });

    it('validates required content field', async () => {
      const args = {
        name: 'Report',
        topic: 'research',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
      expect(response.meta.message).toContain('content');
    });

    it('validates minimum length for name (min 1)', async () => {
      const args = {
        name: '',
        topic: 'research',
        content: 'Analysis',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates minimum length for topic (min 1)', async () => {
      const args = {
        name: 'Report',
        topic: '',
        content: 'Analysis',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });

    it('validates minimum length for content (min 1)', async () => {
      const args = {
        name: 'Report',
        topic: 'research',
        content: '',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('successful artifact creation', () => {
    it('creates artifact with only required fields', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest123']);

      const args = {
        name: 'Research Report',
        topic: 'market-analysis',
        content: 'Detailed analysis of market trends...',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(pushJsonToIpfs).toHaveBeenCalledWith({
        name: 'Research Report',
        topic: 'market-analysis',
        content: 'Detailed analysis of market trends...',
        mimeType: 'text/plain',
        type: undefined,
        tags: undefined,
      });

      expect(response.meta.ok).toBe(true);
      expect(response.data).toEqual({
        cid: 'QmTest123',
        name: 'Research Report',
        topic: 'market-analysis',
        contentPreview: 'Detailed analysis of market trends...',
        type: undefined,
        tags: undefined,
      });
    });

    it('creates artifact with all optional fields', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest456']);

      const args = {
        name: 'Bug Fix Solution',
        topic: 'debugging',
        content: 'Found root cause and implemented fix...',
        mimeType: 'text/markdown',
        type: 'MEMORY',
        tags: ['bug-fix', 'authentication', 'security'],
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(pushJsonToIpfs).toHaveBeenCalledWith({
        name: 'Bug Fix Solution',
        topic: 'debugging',
        content: 'Found root cause and implemented fix...',
        mimeType: 'text/markdown',
        type: 'MEMORY',
        tags: ['bug-fix', 'authentication', 'security'],
      });

      expect(response.meta.ok).toBe(true);
      expect(response.data.type).toBe('MEMORY');
      expect(response.data.tags).toEqual(['bug-fix', 'authentication', 'security']);
    });

    it('defaults mimeType to text/plain when not provided', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest789']);

      const args = {
        name: 'Config',
        topic: 'settings',
        content: 'configuration data',
      };

      await createArtifact(args);

      expect(pushJsonToIpfs).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType: 'text/plain',
        })
      );
    });

    it('returns CID from pushJsonToIpfs', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ipfs://Qm...', 'QmExpectedCID']);

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.data.cid).toBe('QmExpectedCID');
    });
  });

  describe('content preview', () => {
    it('truncates content preview to 100 characters', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest']);

      const longContent =
        'A'.repeat(50) + 'B'.repeat(50) + 'C'.repeat(50); // 150 chars total

      const args = {
        name: 'Long Document',
        topic: 'documentation',
        content: longContent,
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.data.contentPreview).toHaveLength(100);
      expect(response.data.contentPreview).toBe('A'.repeat(50) + 'B'.repeat(50));
    });

    it('does not truncate content preview when under 100 characters', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest']);

      const shortContent = 'Short content';

      const args = {
        name: 'Short Doc',
        topic: 'notes',
        content: shortContent,
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.data.contentPreview).toBe('Short content');
      expect(response.data.contentPreview).toHaveLength(13);
    });

    it('handles exactly 100 character content', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest']);

      const exactContent = 'X'.repeat(100);

      const args = {
        name: 'Exact Length',
        topic: 'test',
        content: exactContent,
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.data.contentPreview).toBe(exactContent);
      expect(response.data.contentPreview).toHaveLength(100);
    });
  });

  describe('error handling', () => {
    it('handles IPFS upload failure', async () => {
      (pushJsonToIpfs as any).mockRejectedValue(new Error('IPFS gateway unreachable'));

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('EXECUTION_ERROR');
      expect(response.meta.message).toBe('IPFS gateway unreachable');
      expect(response.data).toBeNull();
    });

    it('handles non-Error exceptions', async () => {
      (pushJsonToIpfs as any).mockRejectedValue('String error');

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('EXECUTION_ERROR');
      expect(response.meta.message).toBe('String error');
    });

    it('handles null error', async () => {
      (pushJsonToIpfs as any).mockRejectedValue(null);

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('EXECUTION_ERROR');
      expect(response.meta.message).toBe('null');
    });

    it('handles undefined error', async () => {
      (pushJsonToIpfs as any).mockRejectedValue(undefined);

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(false);
      expect(response.meta.code).toBe('EXECUTION_ERROR');
      expect(response.meta.message).toBe('undefined');
    });
  });

  describe('MCP response format', () => {
    it('returns proper MCP content array format', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest']);

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });

    it('returns valid JSON in response text', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest']);

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);

      // Should not throw
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveProperty('data');
      expect(parsed).toHaveProperty('meta');
    });

    it('includes ok status in meta', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmTest']);

      const args = {
        name: 'Artifact',
        topic: 'data',
        content: 'content',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta).toHaveProperty('ok');
      expect(typeof response.meta.ok).toBe('boolean');
    });
  });

  describe('special content types', () => {
    it('handles code content with special characters', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmCode']);

      const codeContent = `function test() {
  const x = "Hello \\"world\\"";
  return x.length > 0 ? true : false;
}`;

      const args = {
        name: 'Code Snippet',
        topic: 'implementation',
        content: codeContent,
        mimeType: 'text/javascript',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(pushJsonToIpfs).toHaveBeenCalledWith(
        expect.objectContaining({
          content: codeContent,
          mimeType: 'text/javascript',
        })
      );
    });

    it('handles JSON content', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmJson']);

      const jsonContent = JSON.stringify({
        config: {
          enabled: true,
          timeout: 5000,
        },
      });

      const args = {
        name: 'Configuration',
        topic: 'settings',
        content: jsonContent,
        mimeType: 'application/json',
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
    });

    it('handles unicode and emoji content', async () => {
      (pushJsonToIpfs as any).mockResolvedValue(['ignored', 'QmUnicode']);

      const unicodeContent = 'Hello 世界 🌍 Привет مرحبا';

      const args = {
        name: 'Multilingual',
        topic: 'i18n',
        content: unicodeContent,
      };

      const result = await createArtifact(args);
      const response = JSON.parse(result.content[0].text);

      expect(response.meta.ok).toBe(true);
      expect(response.data.contentPreview).toBe(unicodeContent);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { extractToolName, normalizeToolArray, parseAnnotatedTools } from 'jinn-node/shared/template-tools.js';

describe('extractToolName', () => {
    it('should extract name from string tool', () => {
        expect(extractToolName('blog_create_post')).toBe('blog_create_post');
    });

    it('should extract name from object tool with name property', () => {
        expect(extractToolName({ name: 'blog_create_post', required: true })).toBe('blog_create_post');
    });

    it('should extract name from object tool without required property', () => {
        expect(extractToolName({ name: 'telegram_send_message' })).toBe('telegram_send_message');
    });

    it('should return null for object without name property', () => {
        expect(extractToolName({ required: true })).toBe(null);
    });

    it('should return null for empty string', () => {
        expect(extractToolName('')).toBe(null);
    });

    it('should return null for whitespace-only string', () => {
        expect(extractToolName('   ')).toBe(null);
    });

    it('should return null for null input', () => {
        expect(extractToolName(null)).toBe(null);
    });

    it('should return null for undefined input', () => {
        expect(extractToolName(undefined)).toBe(null);
    });
});

describe('normalizeToolArray', () => {
    it('should handle mixed array of strings and objects', () => {
        const input = [
            'list_tools',
            { name: 'blog_create_post', required: true },
            { name: 'telegram_send_message' },
            'get_details'
        ];

        expect(normalizeToolArray(input)).toEqual([
            'list_tools',
            'blog_create_post',
            'telegram_send_message',
            'get_details'
        ]);
    });

    it('should filter out invalid entries', () => {
        const input = [
            'valid_tool',
            { name: 'another_tool' },
            { required: true }, // no name - should be filtered
            '',                  // empty string - should be filtered
            null,               // null - should be filtered
        ];

        expect(normalizeToolArray(input)).toEqual([
            'valid_tool',
            'another_tool'
        ]);
    });

    it('should filter out [object Object] strings (legacy corruption)', () => {
        const input = [
            'valid_tool',
            '[object Object]', // corrupted entry - should be filtered
            { name: 'another_tool' }
        ];

        expect(normalizeToolArray(input)).toEqual([
            'valid_tool',
            'another_tool'
        ]);
    });

    it('should return empty array for non-array input', () => {
        expect(normalizeToolArray(null)).toEqual([]);
        expect(normalizeToolArray(undefined)).toEqual([]);
        expect(normalizeToolArray('string')).toEqual([]);
    });
});

describe('parseAnnotatedTools', () => {
    it('should parse simple string tools', () => {
        const result = parseAnnotatedTools(['tool_a', 'tool_b']);
        expect(result.requiredTools).toEqual([]);
        expect(result.availableTools).toContain('tool_a');
        expect(result.availableTools).toContain('tool_b');
    });

    it('should parse object tools with required flag', () => {
        const result = parseAnnotatedTools([
            { name: 'tool_a', required: true },
            { name: 'tool_b' }
        ]);
        expect(result.requiredTools).toEqual(['tool_a']);
        expect(result.availableTools).toContain('tool_a');
        expect(result.availableTools).toContain('tool_b');
    });

    it('should expand workstream_analysis meta-tool', () => {
        const result = parseAnnotatedTools([
            { name: 'workstream_analysis', required: true }
        ]);

        // Should include the meta-tool itself
        expect(result.availableTools).toContain('workstream_analysis');

        // Should include expanded individual tools
        expect(result.availableTools).toContain('inspect_workstream');
        expect(result.availableTools).toContain('inspect_job');
        expect(result.availableTools).toContain('inspect_job_run');

        // Required should only have the meta-tool
        expect(result.requiredTools).toEqual(['workstream_analysis']);
    });

    it('should expand telegram_messaging meta-tool', () => {
        const result = parseAnnotatedTools(['telegram_messaging']);

        expect(result.availableTools).toContain('telegram_messaging');
        expect(result.availableTools).toContain('telegram_send_message');
        expect(result.availableTools).toContain('telegram_send_photo');
        expect(result.availableTools).toContain('telegram_send_document');
    });

    it('should expand ventures_registry meta-tool', () => {
        const result = parseAnnotatedTools(['ventures_registry']);

        expect(result.availableTools).toContain('ventures_registry');
        expect(result.availableTools).toContain('venture_mint');
        expect(result.availableTools).toContain('venture_query');
        expect(result.availableTools).toContain('venture_update');
        expect(result.availableTools).toContain('venture_delete');
    });

    it('should deduplicate when same tool appears multiple times', () => {
        const result = parseAnnotatedTools([
            'workstream_analysis',
            'inspect_workstream' // Already included via expansion
        ]);

        const inspectCount = result.availableTools.filter(t => t === 'inspect_workstream').length;
        expect(inspectCount).toBe(1);
    });

    it('should handle mixed meta-tools and regular tools', () => {
        const result = parseAnnotatedTools([
            { name: 'workstream_analysis', required: true },
            'get_details',
            'dispatch_new_job'
        ]);

        // Meta-tool and its expansions
        expect(result.availableTools).toContain('workstream_analysis');
        expect(result.availableTools).toContain('inspect_workstream');

        // Regular tools
        expect(result.availableTools).toContain('get_details');
        expect(result.availableTools).toContain('dispatch_new_job');
    });

    it('should return empty arrays for non-array input', () => {
        expect(parseAnnotatedTools(null)).toEqual({ requiredTools: [], availableTools: [] });
        expect(parseAnnotatedTools(undefined)).toEqual({ requiredTools: [], availableTools: [] });
        expect(parseAnnotatedTools('string')).toEqual({ requiredTools: [], availableTools: [] });
    });
});

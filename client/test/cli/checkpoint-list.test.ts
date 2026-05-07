import { describe, it, expect, vi } from 'vitest';
import { checkpointListCommand } from '../../src/cli/commands/checkpoint.js';

describe('jinn checkpoint list', () => {
  it('returns local published + installed checkpoints', async () => {
    const deps = {
      listLocallyPublished: vi.fn().mockResolvedValue([{ cid: 'bafy_pub', name: '@me/fork', version: '0.1.0' }]),
      listLocallyInstalled: vi.fn().mockResolvedValue([{ cid: 'bafy_inst', name: '@other/checkpoint', version: '0.2.0' }]),
    };
    const result = await checkpointListCommand({ deps });
    expect(result.published).toHaveLength(1);
    expect(result.installed).toHaveLength(1);
    expect(result.published[0].name).toBe('@me/fork');
    expect(result.installed[0].name).toBe('@other/checkpoint');
  });
});

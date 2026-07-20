import { describe, expect, it } from 'vitest';
import { runJinnLayerCli } from '../src/cli.js';

describe('layer contract entry', () => {
  it('reports the exact process contract v1 payload', async () => {
    let output = '';
    const code = await runJinnLayerCli(['contract', '--json'], {
      writer: {
        write(value: string) {
          output += value;
          return true;
        },
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ contractVersion: 1 });
  });
});

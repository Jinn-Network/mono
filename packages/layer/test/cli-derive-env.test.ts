import { describe, expect, it } from 'vitest';
import { runJinnLayerCli } from '../src/cli.js';

function capture(): {
  writer: { write: (value: string) => boolean };
  out: () => string;
} {
  let output = '';
  return {
    writer: {
      write(value) {
        output += value;
        return true;
      },
    },
    out: () => output,
  };
}

describe('jinn-layer client-only wallet boundary', () => {
  it('fails explicitly instead of linking client wallet code for derive-env', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(2);
    expect(out()).toContain('requires the client wallet adapter');
    expect(out()).toContain('does not link wallet code');
    expect(out()).not.toContain('JINN_LAYER_PRIVATE_KEY=');
  });
});

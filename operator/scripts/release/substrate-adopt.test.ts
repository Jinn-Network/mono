import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptOperator } from './substrate-adopt.js';

const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

describe('substrate-adopt', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-adopt-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function setupSource(): Promise<string> {
    const source = path.join(root, 'source', '.jinn-client');
    await fs.mkdir(path.join(source, 'earning'), { recursive: true });
    await fs.writeFile(
      path.join(source, 'config.json'),
      JSON.stringify(
        {
          apiPort: 7777,
          rpcUrl: 'https://base-sepolia.publicnode.com',
          executionWiring: [{
            workKind: 'swe-rebench-v2.v1',
            harness: 'claude-code',
            model: 'claude-haiku-4-5-20251001',
            plugins: [],
            credentialRef: 'claude-code-default',
            isolationPolicy: 'process',
            legacyManifestDigest: 'QmManifestCidA',
          }],
        },
        null,
        2,
      ) + '\n',
    );
    await fs.writeFile(
      path.join(source, 'earning', 'earning_state.json'),
      JSON.stringify(
        {
          master_address: ADDR(1),
          chain: 'base-sepolia',
          fleet_agent_id: '42',
          fleet_safe_address: ADDR(2),
          fleet_stage: 'staked',
          services: [
            {
              agent_address: ADDR(3),
              safe_address: ADDR(2),
              service_id: 7,
              step: 'complete',
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
    return source;
  }

  it('preserves evaluator admission state while still excluding transient engine work', async () => {
    const source = await setupSource();
    const evaluatorState = path.join(source, 'engine', 'impl-state', 'swe-rebench-v2-evaluator');
    await fs.mkdir(path.join(evaluatorState, 'upstream'), { recursive: true });
    await fs.mkdir(path.join(source, 'engine', 'work', 'request-1'), { recursive: true });
    await fs.writeFile(path.join(evaluatorState, 'state.json'), '{"enabled":true}\n');
    await fs.writeFile(path.join(evaluatorState, 'validated-pool.json'), '{"entries":{"sympy__sympy-27510":{"scorable":true}}}\n');
    await fs.writeFile(path.join(evaluatorState, 'upstream', 'eval.py'), '# heavy checkout\n');
    await fs.writeFile(path.join(source, 'engine', 'work', 'request-1', 'trace.json'), '{}\n');

    await adoptOperator({
      sourceDir: source,
      opName: 'op-a',
      role: 'participant',
      shape: 'current',
      apiPort: 7331,
      substrateRoot: root,
    });

    const goldJinn = path.join(root, 'operators', 'op-a', '.jinn-client');
    await expect(fs.readFile(path.join(goldJinn, 'engine', 'impl-state', 'swe-rebench-v2-evaluator', 'state.json'), 'utf-8')).resolves.toContain('"enabled":true');
    await expect(fs.readFile(path.join(goldJinn, 'engine', 'impl-state', 'swe-rebench-v2-evaluator', 'validated-pool.json'), 'utf-8')).resolves.toContain('sympy__sympy-27510');
    await expect(fs.access(path.join(goldJinn, 'engine', 'impl-state', 'swe-rebench-v2-evaluator', 'upstream', 'eval.py'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(goldJinn, 'engine', 'work', 'request-1', 'trace.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

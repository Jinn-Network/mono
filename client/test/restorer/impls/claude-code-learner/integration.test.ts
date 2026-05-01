/**
 * Path 1 plug-in slot-registry hand-off integration tests.
 *
 * Exercises the full daemon-side path: load `jinn-plugin.json` → build
 * registry → serialise → write to JINN_SLOT_REGISTRY_JSON → synthetic
 * session-start hook materialises the registry under
 * `workingDir/.coordinator/slots.json`. Phase skills `Read` that file.
 *
 * See plan
 * docs/superpowers/plans/2026-04-30-plug-in-surface-path-1-mechanism.md
 * Tasks 5, 7, 8.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadPlugIns,
  serialiseRegistry,
} from '../../../../src/restorer/plug-ins/index.js';
import { makeSyntheticSession } from '../../../../src/restorer/impls/claude-code-learner/test-utils/synthetic-session.js';

describe('plug-in registry hand-off', () => {
  it('threads from config to slots.json via the synthetic session', async () => {
    const pkgDir = mkdtempSync(join(tmpdir(), 'jinn-pi-'));
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@x/calib', version: '0.1.0' }),
    );
    writeFileSync(
      join(pkgDir, 'jinn-plugin.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        name: '@x/calib',
        version: '0.1.0',
        compatibility: {
          claudeCodeLearner: '>=0.1.0',
          supportedKinds: ['prediction.v0'],
        },
        slots: [
          {
            type: 'phase-agent-override',
            phase: 'execute',
            agent: 'step-worker',
            entry: 'agents/calib.md',
            scope: { matchKinds: ['prediction.v0'] },
          },
        ],
      }),
    );
    mkdirSync(join(pkgDir, 'agents'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'agents', 'calib.md'),
      '---\nname: calib\n---\n# stub',
    );

    const result = await loadPlugIns({
      entries: [{ name: '@x/calib', entry: pkgDir }],
      learnerVersion: '0.1.0',
    });
    expect(result.errors).toEqual([]);
    const json = JSON.stringify(serialiseRegistry(result.registry, '0.1.0'));

    const session = makeSyntheticSession();
    session.applySessionStart({ JINN_SLOT_REGISTRY_JSON: json });
    const slots = session.readSlots() as { phaseAgentOverrides: unknown[] };
    expect(slots.phaseAgentOverrides).toHaveLength(1);
  });

  it('phase-agent override is discoverable from slots.json by skill consumer', () => {
    const session = makeSyntheticSession();
    session.applySessionStart({
      JINN_SLOT_REGISTRY_JSON: JSON.stringify({
        builtAt: '2026-04-30T00:00:00.000Z',
        learnerVersion: '0.1.0',
        phaseAgentOverrides: [
          {
            plugInName: '@x/calib',
            packageRoot: '/tmp/calib',
            slot: {
              type: 'phase-agent-override',
              phase: 'execute',
              agent: 'step-worker',
              entry: 'agents/calib.md',
              scope: { matchKinds: ['prediction.v0'] },
            },
          },
        ],
        topicExplorers: [],
        mcpTools: [],
        skillBundles: [],
        memoryBackends: [],
        hooks: [],
      }),
    });
    const slots = session.readSlots() as {
      phaseAgentOverrides: Array<{ slot: { phase: string; agent: string } }>;
    };
    const matchExecute = slots.phaseAgentOverrides.find(
      (o) => o.slot.phase === 'execute' && o.slot.agent === 'step-worker',
    );
    expect(matchExecute).toBeDefined();
  });

  it('topic explorer slots are discoverable from slots.json for orient + debrief', () => {
    const session = makeSyntheticSession();
    session.applySessionStart({
      JINN_SLOT_REGISTRY_JSON: JSON.stringify({
        builtAt: '2026-04-30T00:00:00.000Z',
        learnerVersion: '0.1.0',
        phaseAgentOverrides: [],
        topicExplorers: [
          {
            plugInName: '@x/news',
            packageRoot: '/tmp/news',
            slot: {
              type: 'topic-explorer',
              phase: 'orient',
              topic: 'news-context',
              entry: 'agents/news.md',
              scope: { matchKinds: ['prediction.v0'] },
            },
          },
          {
            plugInName: '@x/comp',
            packageRoot: '/tmp/comp',
            slot: {
              type: 'topic-explorer',
              phase: 'debrief',
              topic: 'cross-operator-comparison',
              entry: 'agents/comp.md',
            },
          },
        ],
        mcpTools: [],
        skillBundles: [],
        memoryBackends: [],
        hooks: [],
      }),
    });
    const slots = session.readSlots() as {
      topicExplorers: Array<{ slot: { phase: string; topic: string } }>;
    };
    expect(
      slots.topicExplorers.filter((t) => t.slot.phase === 'orient'),
    ).toHaveLength(1);
    expect(
      slots.topicExplorers.filter((t) => t.slot.phase === 'debrief'),
    ).toHaveLength(1);
  });
});

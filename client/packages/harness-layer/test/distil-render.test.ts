import { describe, it, expect } from 'vitest';
import {
  renderConsentDisclosure,
  renderModeSet,
  renderDeferredRun,
  renderRecorded,
  renderEmpty,
  renderSkillsPanel,
  renderRunSummary,
  renderFailure,
  renderResumeNothing,
  type RenderedSkill,
} from '../src/distil-render.js';

/** The two hard rules apply to every string this surface prints. */
const EMOJI = /\p{Extended_Pictographic}/u;

const SKILLS: RenderedSkill[] = [
  { name: 'retry-backoff-patterns', installed: true, provenance: ['fix flaky retry', 'retry budget'] },
  { name: 'json-schema-hardening', installed: true, provenance: ['json schema hardening'] },
];

describe('distil render — consent disclosure (1a)', () => {
  const s = renderConsentDisclosure({ captureCount: 6, distillModel: 'llama-4-405b' });

  it('leads with what distillation is for and states it is compute, not money', () => {
    expect(s).toMatch(/reusable skills/i);
    expect(s).toContain('not money');
  });

  it('discloses READS / COSTS / LEAVES with the capture count and the distiller', () => {
    expect(s).toContain('READS');
    expect(s).toContain('COSTS');
    expect(s).toContain('LEAVES');
    expect(s).toContain('6 captures');
    expect(s).toContain('llama-4-405b');
    expect(s).toContain('--distiller');
  });

  it('names the safe default plainly — defer, nothing runs, nothing is spent', () => {
    expect(s).toMatch(/default is defer/i);
    expect(s).toMatch(/nothing published to the Jinn network|nothing is published/i);
  });

  it('carries no emoji', () => {
    expect(s).not.toMatch(EMOJI);
  });
});

describe('distil render — persistent mode echo (1c)', () => {
  it('echoes local as running here with a frontier-class model', () => {
    const s = renderModeSet('local');
    expect(s).toMatch(/mode set to local/i);
    expect(s).toMatch(/frontier/i);
  });
  it('echoes defer as held locally, nothing runs or publishes', () => {
    const s = renderModeSet('defer');
    expect(s).toMatch(/mode set to deferred/i);
    expect(s).toMatch(/nothing runs/i);
  });
  it('echoes off as not reserved for distillation', () => {
    const s = renderModeSet('off');
    expect(s).toMatch(/mode set to off/i);
    expect(s).toMatch(/not reserved/i);
  });
});

describe('distil render — deferred path (1c)', () => {
  const s = renderDeferredRun({ captureCount: 6, capturesDir: '/caps' });
  it('says captures are held locally and nothing runs', () => {
    expect(s).toMatch(/deferred/i);
    expect(s).toContain('6 captures');
    expect(s).toMatch(/nothing runs/i);
  });
  it('points at the local run command to change course', () => {
    expect(s).toContain('--where local');
  });
  it('carries no emoji', () => {
    expect(s).not.toMatch(EMOJI);
  });
});

describe('distil render — recorded states (1a)', () => {
  it('recorded defer explains captures are held, nothing spent or published', () => {
    const s = renderRecorded('defer', { captureCount: 6 });
    expect(s).toMatch(/DEFERRED/);
    expect(s).toMatch(/held on this machine/i);
  });
  it('recorded off explains distillation disabled, nothing deleted', () => {
    const s = renderRecorded('off', { captureCount: 0 });
    expect(s).toMatch(/OFF/);
    expect(s).toMatch(/disabled/i);
  });
});

describe('distil render — empty state (1d)', () => {
  const s = renderEmpty({ capturesDir: '/caps' });
  it('says there are no eligible captures and what produces one', () => {
    expect(s).toMatch(/no eligible captures/i);
    expect(s).toMatch(/run a task/i);
  });
  it('carries no emoji', () => {
    expect(s).not.toMatch(EMOJI);
  });
});

describe('distil render — skills panel (1b)', () => {
  const s = renderSkillsPanel(SKILLS, 'skills · installed · ready');

  it('shows each skill with an install-state word (not a glyph) and its name', () => {
    expect(s).toContain('installed');
    expect(s).toContain('retry-backoff-patterns');
    expect(s).toContain('json-schema-hardening');
    // No check/cross glyphs as status.
    expect(s).not.toMatch(/[✓✔✗✘]/);
  });

  it('shows the source-capture provenance under each skill', () => {
    expect(s).toContain('from');
    expect(s).toContain('fix flaky retry');
    expect(s).toContain('retry budget');
  });

  it('renders not-installed skills with the words "not installed"', () => {
    const panel = renderSkillsPanel(
      [{ name: 'nil-guard-defensive', installed: false, provenance: ['empty-payload panic'] }],
      'skills · distilled locally · not installed',
    );
    expect(panel).toContain('not installed');
  });

  it('is a box that contains its widest line without overflow', () => {
    const lines = s.split('\n');
    const widths = new Set(lines.map((l) => [...l].length));
    // Top / bottom / body borders all share one frame width.
    expect(widths.size).toBe(1);
  });
});

describe('distil render — run summary (1b)', () => {
  const s = renderRunSummary({ distillModel: 'llama-4-405b', captureCount: 6, skills: SKILLS });
  it('headers with the mode, distiller and capture count', () => {
    expect(s).toMatch(/distil: local/);
    expect(s).toContain('llama-4-405b');
    expect(s).toContain('6 capture');
  });
  it('summarises captures in → skills out and that nothing left the machine', () => {
    expect(s).toMatch(/6 capture/);
    expect(s).toMatch(/2 skill/);
    expect(s).toMatch(/nothing left this machine/i);
  });
  it('embeds the skills panel and the /jinn skills management hint', () => {
    expect(s).toContain('retry-backoff-patterns');
    expect(s).toContain('/jinn skills');
  });
});

describe('distil render — failure (1d)', () => {
  const s = renderFailure({
    distillModel: 'llama-4-405b',
    installedCount: 3,
    errors: [{ clusterId: 'c4', error: 'the distiller stopped responding' }],
  });
  it('says what stopped, what survived, and the one command to resume', () => {
    expect(s).toMatch(/distil failed/i);
    expect(s).toContain('3');
    expect(s).toMatch(/kept|nothing was (sent or )?lost/i);
    expect(s).toContain('--resume');
  });
});

describe('distil render — nothing to resume (1c/1d)', () => {
  it('says all captures are already distilled', () => {
    const s = renderResumeNothing({ captureCount: 6 });
    expect(s).toMatch(/already distilled|nothing to resume/i);
  });
});

import { describe, expect, it } from 'vitest';
import { PLUGIN_SHAPE_FIELDS, PLUGIN_MODES } from './shape-fields.js';

describe('PLUGIN_SHAPE_FIELDS (hfmf)', () => {
  it('covers every required top-level field of SolverPluginManifest', () => {
    const names = PLUGIN_SHAPE_FIELDS.map((f) => f.name);
    expect(names).toContain('name');
    expect(names).toContain('version');
    expect(names).toContain('jinn.supports');
  });

  it('marks name + version + jinn.supports as required', () => {
    const required = PLUGIN_SHAPE_FIELDS.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(expect.arrayContaining(['name', 'version', 'jinn.supports']));
  });

  it('matches the snapshot', () => {
    expect(PLUGIN_SHAPE_FIELDS).toMatchSnapshot();
  });

  it('describes both modes from the validator', () => {
    expect(PLUGIN_MODES.map((m) => m.id)).toEqual(['runtime', 'solver-type']);
  });

  it('runtime mode is documented as a singleton', () => {
    const runtime = PLUGIN_MODES.find((m) => m.id === 'runtime');
    expect(runtime?.requires).toMatch(/singleton/i);
    expect(runtime?.example).toContain('jinn.runtime');
  });

  it('solver-type mode anchors on swe-rebench-v2.v1', () => {
    const st = PLUGIN_MODES.find((m) => m.id === 'solver-type');
    expect(st?.example).toContain('swe-rebench-v2.v1');
  });
});

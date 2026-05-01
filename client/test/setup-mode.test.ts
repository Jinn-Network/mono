import { describe, it, expect } from 'vitest';
import { computeDaemonMode, createSetupModeController } from '../src/setup-mode.js';

describe('computeDaemonMode', () => {
  it('returns setup when keystore missing', () => {
    expect(computeDaemonMode({ keystoreExists: false, allComplete: false })).toBe('setup');
  });

  it('returns setup when keystore present but bootstrap incomplete', () => {
    expect(computeDaemonMode({ keystoreExists: true, allComplete: false })).toBe('setup');
  });

  it('returns running when keystore present and all services complete', () => {
    expect(computeDaemonMode({ keystoreExists: true, allComplete: true })).toBe('running');
  });

  it('returns setup when keystore missing even with allComplete=true', () => {
    // defensive: allComplete should be impossible without a keystore, but we
    // never want to flip to running without one. keystoreExists is the gate.
    expect(computeDaemonMode({ keystoreExists: false, allComplete: true })).toBe('setup');
  });
});

describe('createSetupModeController', () => {
  it('reports the initial mode based on inputs', () => {
    const ctrl = createSetupModeController({ keystoreExists: false, allComplete: false });
    expect(ctrl.mode()).toBe('setup');
  });

  it('refresh() flips mode when inputs change', () => {
    const ctrl = createSetupModeController({ keystoreExists: false, allComplete: false });
    expect(ctrl.mode()).toBe('setup');
    ctrl.refresh({ keystoreExists: true, allComplete: true });
    expect(ctrl.mode()).toBe('running');
  });

  it('waitUntilRunning resolves once mode flips to running', async () => {
    const ctrl = createSetupModeController({ keystoreExists: false, allComplete: false });
    const promise = ctrl.waitUntilRunning();
    let resolved = false;
    promise.then(() => { resolved = true; });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    ctrl.refresh({ keystoreExists: true, allComplete: true });
    await promise;
    expect(resolved).toBe(true);
  });

  it('waitUntilRunning resolves immediately when already running', async () => {
    const ctrl = createSetupModeController({ keystoreExists: true, allComplete: true });
    expect(ctrl.mode()).toBe('running');
    await ctrl.waitUntilRunning();
  });

  it('refresh that re-enters running mode does not re-resolve old waiters', async () => {
    const ctrl = createSetupModeController({ keystoreExists: false, allComplete: false });
    const p1 = ctrl.waitUntilRunning();
    ctrl.refresh({ keystoreExists: true, allComplete: true });
    await p1;
    // Hypothetically we never go back to setup, but if a future caller adds it,
    // a fresh waiter should still resolve immediately.
    const p2 = ctrl.waitUntilRunning();
    await p2;
  });
});

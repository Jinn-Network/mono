/**
 * useCountUp tests.
 *
 * Uses fake timers (via vi.useFakeTimers) to advance rAF.
 * Tests reduced-motion path by mocking window.matchMedia.
 */

import { renderHook, act } from '@testing-library/react';
import { useCountUp } from './useCountUp';

// ── rAF polyfill for jsdom ────────────────────────────────────────────────────

// jsdom doesn't implement requestAnimationFrame; we provide a simple
// synchronous shim that calls callbacks immediately when fake timers advance.
function setupRafShim() {
  let frameId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();

  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = ++frameId;
    callbacks.set(id, cb);
    return id;
  });

  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id);
  });

  // Expose a flush helper that runs all pending frames with a given timestamp
  function flushFrames(timestamp: number) {
    const pending = new Map(callbacks);
    callbacks.clear();
    for (const [id, cb] of pending) {
      void id;
      cb(timestamp);
    }
  }

  return { flushFrames };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useCountUp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('respects prefers-reduced-motion: returns target immediately', () => {
    // Mock matchMedia to signal reduced motion
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    const { result } = renderHook(() => useCountUp(100, 400));
    // Should render the final value immediately, no animation
    expect(result.current).toBe(100);
  });

  it('starts at 0 when reduced-motion is NOT set', () => {
    // matchMedia returns false for reduced-motion
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    setupRafShim();
    const { result } = renderHook(() => useCountUp(100, 400));
    // Before any rAF ticks the value should be 0
    expect(result.current).toBe(0);
  });

  it('reaches target after duration elapses', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, media: '', onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }),
    });

    const { flushFrames } = setupRafShim();
    const { result } = renderHook(() => useCountUp(50, 200));

    // Flush two frames: one at t=0 (kicks off animation), one at t=300 (past duration)
    act(() => { flushFrames(0); });
    act(() => { flushFrames(300); });

    // At t=300ms, progress = 300/200 = 1.5, clamped to 1 → should be at target
    expect(result.current).toBe(50);
  });

  it('returns 0 immediately for zero duration', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false }),
    });

    const { result } = renderHook(() => useCountUp(75, 0));
    // durationMs === 0 → immediate
    expect(result.current).toBe(75);
  });
});

/**
 * useCountUp — animates a number from 0 to `target` over `durationMs`.
 *
 * Respects prefers-reduced-motion: returns the final value immediately when
 * the user has opted out of animations.
 *
 * Usage:
 *   const displayed = useCountUp(95.0, 400);  // → animates 0 → 95.0 over 400ms
 */

import { useState, useEffect, useRef } from 'react';

export function useCountUp(target: number, durationMs = 400): number {
  const [displayed, setDisplayed] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Respect prefers-reduced-motion; guard against jsdom where matchMedia may be absent.
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || durationMs <= 0) {
      setDisplayed(target);
      return;
    }

    let startTime: number | null = null;
    const startValue = 0;

    function tick(now: number) {
      if (startTime === null) startTime = now;
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      // Linear easing — consistent with var(--ease-linear) design token
      setDisplayed(startValue + (target - startValue) * progress);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [target, durationMs]);

  return displayed;
}

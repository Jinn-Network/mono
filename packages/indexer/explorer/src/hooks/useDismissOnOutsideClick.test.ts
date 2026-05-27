/**
 * Unit tests for useDismissOnOutsideClick (#687 bug 3).
 *
 * Verifies the hook dismisses only when mousedown lands outside the
 * tracked ref, and unsubscribes cleanly on unmount.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import { useDismissOnOutsideClick } from './useDismissOnOutsideClick';

afterEach(() => {
  cleanup();
});

function setup() {
  const panel = document.createElement('div');
  const inside = document.createElement('button');
  const outside = document.createElement('div');
  panel.appendChild(inside);
  document.body.appendChild(panel);
  document.body.appendChild(outside);
  const onDismiss = vi.fn();
  const { unmount } = renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(panel as HTMLDivElement);
    useDismissOnOutsideClick(
      ref as RefObject<HTMLElement | null>,
      onDismiss,
    );
  });
  return { panel, inside, outside, onDismiss, unmount };
}

describe('useDismissOnOutsideClick', () => {
  it('fires onDismiss for a mousedown on an outside element', () => {
    const { outside, onDismiss } = setup();
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a mousedown inside the panel ref', () => {
    const { inside, onDismiss } = setup();
    inside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not fire on document body mousedown after unmount', () => {
    const { outside, onDismiss, unmount } = setup();
    unmount();
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

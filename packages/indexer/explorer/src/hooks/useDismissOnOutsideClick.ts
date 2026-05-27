/**
 * useDismissOnOutsideClick — call `onDismiss` when a mousedown lands
 * outside the referenced element.
 *
 * Use to add background-click dismissal to popovers, dropdowns, or any
 * floating panel that doesn't ship with its own backdrop. Pairs naturally
 * with an Escape-key handler at the call site (or in the same hook by
 * adding a `keydown` listener).
 *
 * Implementation notes:
 *   - `mousedown` (not `click`) — fires before any click handler inside
 *     the panel, so dismiss runs cleanly even when the panel mounted in
 *     response to a click on its trigger button.
 *   - Capture phase — the same trigger-button click that opens the panel
 *     fires a `mousedown` first; capturing here lets us skip dismissal on
 *     the same-frame open by ignoring the very first mousedown after
 *     mount. We don't bother with that subtlety because the trigger sits
 *     OUTSIDE the panel ref anyway — the check `!ref.current.contains(target)`
 *     would dismiss immediately if we ran on the open-click. The hook
 *     subscribes after the open render commits, so the mousedown that
 *     opened the panel is already finished by the time we listen.
 *
 * Returns nothing — purely effectful.
 */

import { useEffect, type RefObject } from 'react';

export function useDismissOnOutsideClick(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!ref.current || !target) return;
      if (ref.current.contains(target)) return;
      onDismiss();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onDismiss]);
}

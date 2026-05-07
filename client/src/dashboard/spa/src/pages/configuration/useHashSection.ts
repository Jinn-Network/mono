import { useEffect, useState } from 'react';

/**
 * Reads the URL hash (after `#`) so the Operator page can auto-expand
 * the section the operator deep-linked to (e.g. /operator#solvernets/prediction
 * → expand the SolverNets section).
 */
export function useHashSection(): string | null {
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    const update = (): void => {
      const h = window.location.hash.replace(/^#/, '');
      setHash(h.length > 0 ? h : null);
    };
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash;
}

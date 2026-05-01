import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { ClaudeAuthState } from '../api/types.js';

/**
 * Surfaces unauthed-claude state as a passive notice, not a button.
 *
 * Same in-panel OAuth flow for both bare and docker runtime modes — the
 * agent session auto-walks claude's first-run wizard (see agent-ws.ts
 * dismiss handlers), reaches the OAuth prompt, and our URL scanner opens
 * the auth URL in a new tab automatically. The operator just completes
 * sign-in in that tab.
 *
 * The wrinkle in docker / container modes: claude's OAuth callback uses a
 * loopback redirect that can't reach the container from the host browser,
 * so instead of auto-completing, claude prompts "Paste code here >". The
 * operator copies the OAuth code from the auth page back into the agent
 * terminal. claude validates → writes credentials to /root/.claude →
 * persists across container recreates (jinn-claude-state volume mount in
 * client/docker-compose.yml).
 *
 * For bare mode the callback works directly and there's no paste step.
 */
export function ClaudeAuthCard(): JSX.Element | null {
  const { data } = useQuery<ClaudeAuthState>({
    queryKey: ['claude-auth'],
    queryFn: () => api.getClaudeAuth(),
    refetchInterval: 5000,
  });

  if (!data) return null;
  if (data.authenticated) return null;

  const cardStyle = {
    border: '1px solid var(--seer-violet)',
    background: 'rgba(122, 109, 176, 0.05)',
    borderRadius: 'var(--radius-2)',
  } as const;

  const isContainer = data.context !== 'bare';

  return (
    <div className="px-6 py-5 flex flex-col gap-2" style={cardStyle}>
      <span className="j-label" style={{ color: 'var(--seer-violet)' }}>
        Sign in via the Claude agent
      </span>
      <p className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
        We've opened a sign-in tab in your browser. Complete it there and the
        agent panel becomes interactive — the daemon's restorations use the
        same sign-in, so this is the only auth step you'll take.
      </p>
      {isContainer && (
        <p className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
          <span style={{ color: 'var(--accent-gold)' }}>Container mode:</span>{' '}
          after OAuth, copy the code from the auth page and paste it into the
          agent terminal where claude is waiting at <span style={{ color: 'var(--fg)' }}>Paste code here</span>.
        </p>
      )}
      <p className="j-mono text-[10px]" style={{ color: 'var(--fg-dim)' }}>
        Polling every 5s. This card disappears once sign-in completes.
      </p>
    </div>
  );
}

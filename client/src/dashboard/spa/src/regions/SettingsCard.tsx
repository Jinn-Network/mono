import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api/client.js';

export function SettingsCard(): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const matches = next.length > 0 && next === confirm;
  const canSubmit =
    current.length > 0 && next.length >= 8 && matches && !submitting;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setOk(false);
    try {
      await api.changeKeystorePassword(current, next);
      setOk(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Change failed';
      let friendly = raw;
      if (raw.startsWith('401')) {
        friendly = 'Current password is incorrect.';
      } else if (raw.startsWith('400')) {
        friendly = 'New password must be at least 8 characters.';
      } else if (raw.startsWith('404')) {
        friendly = 'No keystore found on this daemon.';
      }
      setError(friendly);
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    background: 'var(--bg-sunken)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-1)',
    color: 'var(--fg)',
    fontFamily: 'var(--mono)',
    fontSize: '13px',
  } as const;

  return (
    <div
      className="px-5 py-4 flex flex-col gap-3"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        background: 'var(--bg-elevated)',
      }}
    >
      <span className="j-label">Change keystore password</span>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="w-full px-3 py-2"
          style={inputStyle}
          disabled={submitting}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password (8+ chars)"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="w-full px-3 py-2"
          style={inputStyle}
          disabled={submitting}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Confirm new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full px-3 py-2"
          style={inputStyle}
          disabled={submitting}
        />
        {confirm.length > 0 && !matches && (
          <span className="j-mono text-xs" style={{ color: 'var(--wane)' }}>
            Passwords don't match.
          </span>
        )}
        {error && (
          <span className="j-mono text-xs" style={{ color: 'var(--break-red)' }}>
            {error}
          </span>
        )}
        {ok && (
          <span className="j-mono text-xs" style={{ color: 'var(--vow-green)' }}>
            Password updated.
          </span>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="self-start px-3 py-1.5 j-label disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'var(--accent-sky)',
            color: 'var(--bg)',
            borderRadius: 'var(--radius-1)',
          }}
        >
          {submitting ? 'Updating…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

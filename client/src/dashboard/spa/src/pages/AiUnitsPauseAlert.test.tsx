/**
 * AiUnitsPauseAlert — issue #815 running-mode surface.
 *
 * Shows a compact banner per paused credential, naming the reason
 * (which window tripped) and the next reset instant in operator-local
 * time. Renders nothing when no credentials are paused.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AiUnitsPauseAlert } from './AiUnitsPauseAlert.js';

afterEach(() => cleanup());

describe('AiUnitsPauseAlert', () => {
  it('renders nothing when no aiUnits block is present', () => {
    const { container } = render(<AiUnitsPauseAlert aiUnits={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no credentials are paused', () => {
    const { container } = render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'anthropic:api-key',
              unitsThisBlock: 30,
              unitsThisWeek: 200,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: false,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a banner per paused credential with the reset time', () => {
    render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'anthropic:api-key',
              unitsThisBlock: 100,
              unitsThisWeek: 200,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    const alert = screen.getByTestId('ai-units-pause-alert-anthropic:api-key');
    expect(alert.textContent).toContain('anthropic:api-key');
    expect(alert.textContent).toContain('Paused');
    expect(alert.textContent).toContain('AI-unit');
  });

  it('names the binding window (block or week)', () => {
    render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'a:k',
              unitsThisBlock: 100,
              unitsThisWeek: 500,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
            {
              credentialId: 'b:k',
              unitsThisBlock: 5,
              unitsThisWeek: 2800,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('ai-units-pause-alert-a:k').textContent).toMatch(/6h/);
    expect(screen.getByTestId('ai-units-pause-alert-b:k').textContent).toMatch(/7d|week/i);
  });
});

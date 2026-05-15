import { render, screen } from '@testing-library/react';
import { FreezeIntegrity } from './FreezeIntegrity';
import type { FreezeIntegrityData } from './FreezeIntegrity';

describe('FreezeIntegrity', () => {
  it('renders "no attempts" state when frozenAttempts is 0', () => {
    const data: FreezeIntegrityData = {
      violations: [],
      verifiedFrozenShare: 0,
      frozenAttempts: 0,
    };
    render(<FreezeIntegrity data={data} />);
    expect(
      screen.getByText('No frozen-mode attempts yet.'),
    ).toBeInTheDocument();
  });

  it('renders green "no violations" when attempts > 0 and violations empty', () => {
    const data: FreezeIntegrityData = {
      violations: [],
      verifiedFrozenShare: 1.0,
      frozenAttempts: 42,
    };
    render(<FreezeIntegrity data={data} />);
    expect(
      screen.getByText('No freeze violations recorded.'),
    ).toBeInTheDocument();
  });

  it('renders violation count message when violations exist', () => {
    const data: FreezeIntegrityData = {
      violations: [
        {
          operator: '0xabcdef1234567890abcd',
          modalCodeDigest: 'bafkreiabc12345678xyz',
          total: 10,
          violatingCount: 3,
        },
      ],
      verifiedFrozenShare: 0.7,
      frozenAttempts: 10,
    };
    render(<FreezeIntegrity data={data} />);
    expect(screen.getByText(/1 violation detected/)).toBeInTheDocument();
  });

  it('renders the violations table when violations exist', () => {
    const data: FreezeIntegrityData = {
      violations: [
        {
          operator: '0xabcdef1234567890abcd',
          modalCodeDigest: 'bafkreiabc12345678xyz',
          total: 10,
          violatingCount: 3,
        },
      ],
      verifiedFrozenShare: 0.7,
      frozenAttempts: 10,
    };
    render(<FreezeIntegrity data={data} />);
    // Table headers
    expect(screen.getByText('Operator')).toBeInTheDocument();
    expect(screen.getByText('Code digest')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Violations')).toBeInTheDocument();
  });

  it('renders verified-frozen share when attempts > 0', () => {
    const data: FreezeIntegrityData = {
      violations: [],
      verifiedFrozenShare: 0.85,
      frozenAttempts: 20,
    };
    render(<FreezeIntegrity data={data} />);
    expect(screen.getByText(/Verified-frozen/)).toBeInTheDocument();
    expect(screen.getByText('85.0%')).toBeInTheDocument();
  });

  it('renders frozen attempts count', () => {
    const data: FreezeIntegrityData = {
      violations: [],
      verifiedFrozenShare: 1.0,
      frozenAttempts: 42,
    };
    render(<FreezeIntegrity data={data} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('handles multiple violations', () => {
    const data: FreezeIntegrityData = {
      violations: [
        {
          operator: '0xaaa',
          modalCodeDigest: 'bafk1',
          total: 5,
          violatingCount: 1,
        },
        {
          operator: '0xbbb',
          modalCodeDigest: 'bafk2',
          total: 8,
          violatingCount: 4,
        },
      ],
      verifiedFrozenShare: 0.5,
      frozenAttempts: 15,
    };
    render(<FreezeIntegrity data={data} />);
    expect(screen.getByText(/2 violations detected/)).toBeInTheDocument();
  });
});

/**
 * Frontend tests for dependencies-section.tsx
 * Phase 2 verification: Full dependency graph display
 * 
 * Tests the DependenciesSection component for displaying both "Depends On" and "Depended On By" sections.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DependenciesSection } from './dependencies-section';
import { getDependencyInfo, getDependents } from '@/lib/subgraph';

// Mock the subgraph module
vi.mock('@/lib/subgraph', () => ({
  getDependencyInfo: vi.fn(),
  getDependents: vi.fn(),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

describe('DependenciesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Loading state', () => {
    it('shows loading message while fetching data', () => {
      (getDependencyInfo as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {})); // Never resolves
      (getDependents as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));

      render(<DependenciesSection requestId="0xRequest1" dependencies={['dep-1']} />);

      expect(screen.getByText('Loading dependency information...')).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('shows "No dependencies" message when no dependencies exist', async () => {
      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.getByText('No dependencies for this job.')).toBeInTheDocument();
      });

      expect(getDependencyInfo).not.toHaveBeenCalled();
      expect(getDependents).toHaveBeenCalledWith('0xRequest1');
    });
  });

  describe('Depends On section', () => {
    it('correctly renders "Depends On" section with job names', async () => {
      const mockDependencyInfo = [
        {
          id: 'job-def-1',
          jobName: 'Build Frontend',
          delivered: true,
          status: 'completed',
        },
        {
          id: 'job-def-2',
          jobName: 'Run Tests',
          delivered: false,
          status: 'in_progress',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(<DependenciesSection requestId="0xRequest1" dependencies={['job-def-1', 'job-def-2']} />);

      await waitFor(() => {
        expect(screen.getByText('Depends On')).toBeInTheDocument();
      });

      expect(screen.getByText('Build Frontend')).toBeInTheDocument();
      expect(screen.getByText('Run Tests')).toBeInTheDocument();
      expect(screen.getByText('(2 jobs)')).toBeInTheDocument();
    });

    it('displays correct status icons for different states', async () => {
      const mockDependencyInfo = [
        {
          id: 'job-def-1',
          jobName: 'Completed Job',
          delivered: true,
          status: 'completed',
        },
        {
          id: 'job-def-2',
          jobName: 'In Progress Job',
          delivered: false,
          status: 'in_progress',
        },
        {
          id: 'job-def-3',
          jobName: 'Pending Job',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(
        <DependenciesSection
          requestId="0xRequest1"
          dependencies={['job-def-1', 'job-def-2', 'job-def-3']}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Depends On')).toBeInTheDocument();
      });

      // Check status labels
      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText('In Progress')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();

      // Check status icons
      expect(screen.getByText('✓')).toBeInTheDocument(); // Completed
      expect(screen.getByText('⏳')).toBeInTheDocument(); // In Progress
      expect(screen.getByText('○')).toBeInTheDocument(); // Pending
    });

    it('links to job definition pages correctly', async () => {
      const mockDependencyInfo = [
        {
          id: 'job-def-123',
          jobName: 'Test Job',
          delivered: true,
          status: 'completed',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(<DependenciesSection requestId="0xRequest1" dependencies={['job-def-123']} />);

      await waitFor(() => {
        expect(screen.getByText('Test Job')).toBeInTheDocument();
      });

      const link = screen.getByText('Test Job').closest('a');
      expect(link).toHaveAttribute('href', '/job-definitions/job-def-123');
    });

    it('shows explanatory note about job definition completion', async () => {
      const mockDependencyInfo = [
        {
          id: 'job-def-1',
          jobName: 'Test Job',
          delivered: true,
          status: 'completed',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(<DependenciesSection requestId="0xRequest1" dependencies={['job-def-1']} />);

      await waitFor(() => {
        expect(
          screen.getByText((content) =>
            content.includes('Job will execute only when all requests and child jobs')
          )
        ).toBeInTheDocument();
      });
    });

    it('uses singular form for single dependency', async () => {
      const mockDependencyInfo = [
        {
          id: 'job-def-1',
          jobName: 'Single Job',
          delivered: true,
          status: 'completed',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(<DependenciesSection requestId="0xRequest1" dependencies={['job-def-1']} />);

      await waitFor(() => {
        expect(screen.getByText('(1 job)')).toBeInTheDocument();
      });
    });
  });

  describe('Required By (Depended On By) section', () => {
    it('correctly renders "Required By" section with dependent jobs', async () => {
      const mockDependents = [
        {
          id: '0xRequest2',
          jobName: 'Deploy App',
          delivered: false,
          status: 'pending',
        },
        {
          id: '0xRequest3',
          jobName: 'Run Integration Tests',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependents);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.getByText('Required By')).toBeInTheDocument();
      });

      expect(screen.getByText('Deploy App')).toBeInTheDocument();
      expect(screen.getByText('Run Integration Tests')).toBeInTheDocument();
      expect(screen.getByText('(2 jobs)')).toBeInTheDocument();
    });

    it('displays request IDs for dependents', async () => {
      const mockDependents = [
        {
          id: '0xRequest123abc',
          jobName: 'Dependent Job',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependents);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.getByText('0xRequest123abc')).toBeInTheDocument();
      });
    });

    it('shows delivery status badges for dependents', async () => {
      const mockDependents = [
        {
          id: '0xRequest2',
          jobName: 'Delivered Job',
          delivered: true,
          status: 'completed',
        },
        {
          id: '0xRequest3',
          jobName: 'Pending Job',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependents);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.getByText('Required By')).toBeInTheDocument();
      });

      expect(screen.getByText('✓ Delivered')).toBeInTheDocument();
      expect(screen.getByText('⏳ Pending')).toBeInTheDocument();
    });

    it('links to request pages for dependents', async () => {
      const mockDependents = [
        {
          id: '0xRequestABC',
          jobName: 'Dependent Job',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependents);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.getByText('Dependent Job')).toBeInTheDocument();
      });

      const link = screen.getByText('Dependent Job').closest('a');
      expect(link).toHaveAttribute('href', '/requests/0xRequestABC');
    });

    it('uses singular form for single dependent', async () => {
      const mockDependents = [
        {
          id: '0xRequest2',
          jobName: 'Single Dependent',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependents);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.getByText('(1 job)')).toBeInTheDocument();
      });
    });

    it('shows fallback text when dependent has no job name', async () => {
      const mockDependents = [
        {
          id: '0xRequest123456789abc',
          jobName: null,
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependents);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.getByText('Request 0xRequest123456...')).toBeInTheDocument();
      });
    });
  });

  describe('Both sections together', () => {
    it('displays both "Depends On" and "Required By" sections simultaneously', async () => {
      const mockDependencyInfo = [
        {
          id: 'job-def-1',
          jobName: 'Parent Job',
          delivered: true,
          status: 'completed',
        },
      ];

      const mockDependents = [
        {
          id: '0xRequest2',
          jobName: 'Child Job',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependents);

      render(<DependenciesSection requestId="0xRequest1" dependencies={['job-def-1']} />);

      await waitFor(() => {
        expect(screen.getByText('Depends On')).toBeInTheDocument();
        expect(screen.getByText('Required By')).toBeInTheDocument();
      });

      expect(screen.getByText('Parent Job')).toBeInTheDocument();
      expect(screen.getByText('Child Job')).toBeInTheDocument();
    });
  });

  describe('Error handling', () => {
    it('handles API errors gracefully', async () => {
      (getDependencyInfo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
      (getDependents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<DependenciesSection requestId="0xRequest1" dependencies={['dep-1']} />);

      await waitFor(() => {
        expect(screen.getByText('No dependencies for this job.')).toBeInTheDocument();
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('API call behavior', () => {
    it('calls getDependencyInfo only when dependencies exist', async () => {
      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // No dependencies
      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(screen.queryByText('Loading')).not.toBeInTheDocument();
      });

      expect(getDependencyInfo).not.toHaveBeenCalled();

      vi.clearAllMocks();

      // With dependencies
      render(<DependenciesSection requestId="0xRequest2" dependencies={['dep-1']} />);

      await waitFor(() => {
        expect(getDependencyInfo).toHaveBeenCalledWith(['dep-1']);
      });
    });

    it('always calls getDependents', async () => {
      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getDependents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      render(<DependenciesSection requestId="0xRequest1" dependencies={[]} />);

      await waitFor(() => {
        expect(getDependents).toHaveBeenCalledWith('0xRequest1');
      });
    });

    it('calls both APIs in parallel', async () => {
      const startTimes: number[] = [];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      });

      (getDependents as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      });

      render(<DependenciesSection requestId="0xRequest1" dependencies={['dep-1']} />);

      await waitFor(() => {
        expect(screen.queryByText('Loading')).not.toBeInTheDocument();
      });

      // Both should start around the same time (parallel)
      expect(startTimes.length).toBe(2);
      const timeDiff = Math.abs(startTimes[1] - startTimes[0]);
      expect(timeDiff).toBeLessThan(50); // Should start within 50ms
    });
  });
});


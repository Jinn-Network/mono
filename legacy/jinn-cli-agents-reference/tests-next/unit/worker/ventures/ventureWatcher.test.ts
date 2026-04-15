import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

const mockListVentures = vi.fn();
const mockGraphQLRequest = vi.fn();
const mockDispatchFromTemplate = vi.fn();
const mockClaimVentureDispatch = vi.fn();

// Mock cron-parser (not resolvable in vitest environment)
const mockLastTickForCron = vi.fn();
vi.mock('cron-parser', () => ({
    CronExpressionParser: {
        parse: vi.fn((cron: string, _opts: any) => ({
            prev: () => ({
                toDate: () => mockLastTickForCron(cron),
            }),
        })),
    },
}));

vi.mock('jinn-node/data/ventures.js', () => ({
    listVentures: (...args: any[]) => mockListVentures(...args),
}));

vi.mock('jinn-node/http/client.js', () => ({
    graphQLRequest: (...args: any[]) => mockGraphQLRequest(...args),
}));

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
    getPonderGraphqlUrl: vi.fn(() => 'http://example.com/graphql'),
}));

vi.mock('jinn-node/worker/ventures/ventureDispatch.js', () => ({
    dispatchFromTemplate: (...args: any[]) => mockDispatchFromTemplate(...args),
}));

vi.mock('jinn-node/worker/control_api_client.js', () => ({
    claimVentureDispatch: (...args: any[]) => mockClaimVentureDispatch(...args),
}));

vi.mock('jinn-node/logging/index.js', () => ({
    workerLogger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// --- Fixtures ---

const NOW = new Date('2026-02-16T12:05:00Z');

function makeVenture(overrides: Partial<any> = {}) {
    return {
        id: 'venture-1',
        name: 'Test Venture',
        status: 'active',
        blueprint: { invariants: [] },
        dispatch_schedule: [
            {
                id: 'entry-1',
                templateId: 'template-1',
                cron: '0 * * * *', // every hour on the hour
                enabled: true,
                input: {},
                label: 'Hourly check',
            },
        ],
        ...overrides,
    };
}

// --- Tests ---

describe('ventureWatcher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(NOW);

        // Default: cron-parser prev() returns 12:00 (5 mins before NOW)
        mockLastTickForCron.mockImplementation(() => new Date('2026-02-16T12:00:00Z'));

        // Default: no existing dispatches in Ponder
        mockGraphQLRequest.mockResolvedValue({
            requests: { items: [] },
        });

        // Default: claim is allowed
        mockClaimVentureDispatch.mockResolvedValue({ allowed: true, claimed_by: 'worker-1' });

        // Default: dispatch succeeds
        mockDispatchFromTemplate.mockResolvedValue({ requestIds: ['0x123'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('claim gate integration', () => {
        it('dispatches when claim is allowed and no recent dispatches', async () => {
            const venture = makeVenture();
            mockListVentures.mockResolvedValue([venture]);

            const { checkAndDispatchScheduledVentures } = await import(
                'jinn-node/worker/ventures/ventureWatcher.js'
            );
            await checkAndDispatchScheduledVentures();

            // Should have called the claim gate
            expect(mockClaimVentureDispatch).toHaveBeenCalledTimes(1);
            expect(mockClaimVentureDispatch).toHaveBeenCalledWith(
                'venture-1',
                'template-1',
                expect.stringContaining('entry-1') // schedule tick includes entry ID
            );

            // Should have dispatched
            expect(mockDispatchFromTemplate).toHaveBeenCalledTimes(1);
        });

        it('skips dispatch when claim is NOT allowed (another worker claimed it)', async () => {
            const venture = makeVenture();
            mockListVentures.mockResolvedValue([venture]);
            mockClaimVentureDispatch.mockResolvedValue({ allowed: false, claimed_by: 'other-worker' });

            const { checkAndDispatchScheduledVentures } = await import(
                'jinn-node/worker/ventures/ventureWatcher.js'
            );
            await checkAndDispatchScheduledVentures();

            // Should have tried the claim
            expect(mockClaimVentureDispatch).toHaveBeenCalledTimes(1);

            // Should NOT have dispatched
            expect(mockDispatchFromTemplate).not.toHaveBeenCalled();
        });

        it('skips both claim and dispatch when Ponder shows existing dispatches', async () => {
            const venture = makeVenture();
            mockListVentures.mockResolvedValue([venture]);

            // Ponder shows 1 dispatch already exists (covers the 1 due entry)
            mockGraphQLRequest.mockResolvedValue({
                requests: { items: [{ id: '0xabc' }] },
            });

            const { checkAndDispatchScheduledVentures } = await import(
                'jinn-node/worker/ventures/ventureWatcher.js'
            );
            await checkAndDispatchScheduledVentures();

            // Should NOT have called the claim gate (fast-path)
            expect(mockClaimVentureDispatch).not.toHaveBeenCalled();

            // Should NOT have dispatched
            expect(mockDispatchFromTemplate).not.toHaveBeenCalled();
        });

        it('falls through to dispatch when claim gate throws (Control API unavailable)', async () => {
            const venture = makeVenture();
            mockListVentures.mockResolvedValue([venture]);
            mockClaimVentureDispatch.mockRejectedValue(new Error('Connection refused'));

            const { checkAndDispatchScheduledVentures } = await import(
                'jinn-node/worker/ventures/ventureWatcher.js'
            );
            await checkAndDispatchScheduledVentures();

            // Claim was attempted but failed
            expect(mockClaimVentureDispatch).toHaveBeenCalledTimes(1);

            // Should still dispatch (graceful degradation)
            expect(mockDispatchFromTemplate).toHaveBeenCalledTimes(1);
        });

        it('does not suppress mixed-cadence entries sharing templateId', async () => {
            const venture = makeVenture({
                dispatch_schedule: [
                    {
                        id: 'entry-hourly',
                        templateId: 'template-1',
                        cron: '0 * * * *',
                        enabled: true,
                        input: {},
                        label: 'Hourly check',
                    },
                    {
                        id: 'entry-daily',
                        templateId: 'template-1',
                        cron: '0 0 * * *',
                        enabled: true,
                        input: {},
                        label: 'Daily check',
                    },
                ],
            });
            mockListVentures.mockResolvedValue([venture]);

            mockLastTickForCron.mockImplementation((cron: string) => {
                if (cron === '0 * * * *') return new Date('2026-02-16T12:00:00Z');
                if (cron === '0 0 * * *') return new Date('2026-02-16T00:00:00Z');
                return new Date('2026-02-16T12:00:00Z');
            });

            const {
                checkAndDispatchScheduledVentures,
                buildScheduledJobDefinitionId,
            } = await import('jinn-node/worker/ventures/ventureWatcher.js');

            const hourlyJobDefId = buildScheduledJobDefinitionId(
                'venture-1',
                'entry-hourly',
                new Date('2026-02-16T12:00:00Z')
            );
            const dailyJobDefId = buildScheduledJobDefinitionId(
                'venture-1',
                'entry-daily',
                new Date('2026-02-16T00:00:00Z')
            );

            mockGraphQLRequest.mockImplementation(async ({ variables }: any) => {
                // New logic: query is per deterministic jobDefinitionId
                if (variables?.jobDefinitionId === hourlyJobDefId) {
                    return { requests: { items: [{ id: '0xhourly-existing' }] } };
                }
                if (variables?.jobDefinitionId === dailyJobDefId) {
                    return { requests: { items: [] } };
                }

                // Old grouped logic (no jobDefinitionId) would aggregate hourly requests
                // since midnight and could incorrectly suppress the daily entry.
                return { requests: { items: [{ id: '0x1' }, { id: '0x2' }] } };
            });

            await checkAndDispatchScheduledVentures();

            expect(mockClaimVentureDispatch).toHaveBeenCalledTimes(1);
            expect(mockClaimVentureDispatch).toHaveBeenCalledWith(
                'venture-1',
                'template-1',
                '2026-02-16T00:00:00.000Z:entry-daily'
            );

            expect(mockDispatchFromTemplate).toHaveBeenCalledTimes(1);
            expect(mockDispatchFromTemplate).toHaveBeenCalledWith(
                expect.any(Object),
                expect.objectContaining({ id: 'entry-daily' }),
                expect.objectContaining({ jobDefinitionId: dailyJobDefId })
            );
        });

        it('handles disabled entries', async () => {
            const venture = makeVenture({
                dispatch_schedule: [
                    {
                        id: 'entry-disabled',
                        templateId: 'template-1',
                        cron: '0 * * * *',
                        enabled: false,
                        input: {},
                    },
                ],
            });
            mockListVentures.mockResolvedValue([venture]);

            const { checkAndDispatchScheduledVentures } = await import(
                'jinn-node/worker/ventures/ventureWatcher.js'
            );
            await checkAndDispatchScheduledVentures();

            expect(mockClaimVentureDispatch).not.toHaveBeenCalled();
            expect(mockDispatchFromTemplate).not.toHaveBeenCalled();
        });
    });

    describe('isDue', () => {
        it('returns due=true and correct lastTick for hourly cron at :05 past', async () => {
            // Mock prev() to return 12:00 (5 mins before NOW at 12:05)
            mockLastTickForCron.mockImplementation(() => new Date('2026-02-16T12:00:00Z'));

            const { isDue } = await import('jinn-node/worker/ventures/ventureWatcher.js');
            const result = isDue('0 * * * *', NOW);

            expect(result.due).toBe(true);
            expect(result.lastTick.getUTCHours()).toBe(12);
            expect(result.lastTick.getUTCMinutes()).toBe(0);
        });

        it('returns due=false for lastTick > 24h ago', async () => {
            // Mock prev() to return a date more than 24h ago
            mockLastTickForCron.mockImplementation(() => new Date('2026-01-01T00:00:00Z'));

            const { isDue } = await import('jinn-node/worker/ventures/ventureWatcher.js');
            const result = isDue('0 0 1 1 *', NOW);

            expect(result.due).toBe(false);
        });

        it('returns due=false for invalid cron', async () => {
            // For invalid cron, CronExpressionParser.parse throws
            const { CronExpressionParser } = await import('cron-parser');
            (CronExpressionParser.parse as any).mockImplementationOnce(() => {
                throw new Error('Invalid cron expression');
            });

            const { isDue } = await import('jinn-node/worker/ventures/ventureWatcher.js');
            const result = isDue('not a cron', NOW);

            expect(result.due).toBe(false);
        });
    });
});

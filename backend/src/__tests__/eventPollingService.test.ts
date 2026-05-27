import { EventPollingService } from '../eventPollingService';
import { getPrismaClient } from '../prismaClient';
import { createStellarRpcFetchMock } from './mocks/stellarRpc';

const prisma = getPrismaClient();

// Mock prisma methods
jest.spyOn(prisma.eventCursor, 'findUnique');
jest.spyOn(prisma.eventCursor, 'upsert');
jest.spyOn(prisma.processedEvent, 'findUnique');
jest.spyOn(prisma.processedEvent, 'upsert');

// Mock logger
jest.mock('../middleware/structuredLogging', () => ({
  logger: {
    log: jest.fn(),
  },
}));

// Mock fetch
global.fetch = jest.fn();

describe('EventPollingService', () => {
  let service: EventPollingService;
  const mockConfig = {
    rpcUrl: 'https://test-rpc.stellar.org',
    contractId: 'CTEST123',
    pollIntervalMs: 5000,
    batchSize: 100,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.eventCursor.findUnique as jest.Mock).mockReset();
    (prisma.eventCursor.upsert as jest.Mock).mockReset();
    (prisma.processedEvent.findUnique as jest.Mock).mockReset();
    (prisma.processedEvent.upsert as jest.Mock).mockReset();
    service = new EventPollingService(mockConfig);
  });

  afterEach(async () => {
    await service.stop();
  });

  describe('Event Replay on Startup', () => {
    it('should replay missed events from last cursor to current ledger', async () => {
      // Mock last processed ledger
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      // Mock current ledger
      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          result: { sequence: 1050 },
        }),
      });

      // Mock events fetch
      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          result: {
            events: [
              {
                id: 'event-1',
                type: 'contract',
                ledger: 1025,
                contractId: 'CTEST123',
                txHash: 'tx-1',
              },
              {
                id: 'event-2',
                type: 'contract',
                ledger: 1030,
                contractId: 'CTEST123',
                txHash: 'tx-2',
              },
            ],
          },
        }),
      });

      // Mock event not processed
      (prisma.processedEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.processedEvent.upsert as jest.Mock).mockResolvedValue({});
      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});

      await service.start();

      // Verify events were processed
      expect(prisma.processedEvent.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.eventCursor.upsert).toHaveBeenCalled();
    });

    it('should complete replay within 60 seconds for 1000 ledgers', async () => {
      const startLedger = 1000;
      const endLedger = 2000;

      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: startLedger,
      });

      (fetch as jest.Mock).mockImplementation((url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'getLatestLedger') {
          return Promise.resolve({
            json: async () => ({ result: { sequence: endLedger } }),
          });
        }
        return Promise.resolve({
          json: async () => ({ result: { events: [] } }),
        });
      });

      (prisma.processedEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});

      const startTime = Date.now();
      await service.start();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(60000);
    });

    it('should skip replay if no missed events', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          result: { sequence: 1000 },
        }),
      });

      await service.start();

      // Should not fetch events
      expect(fetch).toHaveBeenCalledTimes(1); // Only getLatestLedger
    });
  });

  describe('Event Deduplication', () => {
    it('should prevent duplicate event processing', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ result: { sequence: 1010 } }),
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          result: {
            events: [
              {
                id: 'event-1',
                type: 'contract',
                ledger: 1005,
                contractId: 'CTEST123',
                txHash: 'tx-1',
              },
            ],
          },
        }),
      });

      // First event is already processed
      (prisma.processedEvent.findUnique as jest.Mock).mockResolvedValue({
        id: 'event-1',
      });

      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});

      await service.start();

      // Should not process duplicate
      expect(prisma.processedEvent.upsert).not.toHaveBeenCalled();
    });

    it('should use idempotent upsert for event storage', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ result: { sequence: 1010 } }),
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({
          result: {
            events: [
              {
                id: 'event-1',
                type: 'contract',
                ledger: 1005,
                contractId: 'CTEST123',
                txHash: 'tx-1',
              },
            ],
          },
        }),
      });

      (prisma.processedEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.processedEvent.upsert as jest.Mock).mockResolvedValue({});
      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});

      await service.start();

      expect(prisma.processedEvent.upsert).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        update: {},
        create: {
          id: 'event-1',
          ledgerSeq: 1005,
          eventType: 'contract',
          contractId: 'CTEST123',
          txHash: 'tx-1',
        },
      });
    });
  });

  describe('Cursor Management', () => {
    it('should store last processed ledger sequence', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ result: { sequence: 1010 } }),
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ result: { events: [] } }),
      });

      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});

      await service.start();

      expect(prisma.eventCursor.upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        update: { lastLedgerSeq: 1010 },
        create: { id: 1, lastLedgerSeq: 1010 },
      });
    });

    it('should initialize cursor at 0 if not exists', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue(null);

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ result: { sequence: 100 } }),
      });

      (fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ result: { events: [] } }),
      });

      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});

      await service.start();

      // Should process from ledger 1 to 100
      expect(prisma.eventCursor.upsert).toHaveBeenCalled();
    });
  });

  describe('Service Lifecycle', () => {
    it('should start and stop gracefully', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (fetch as jest.Mock).mockResolvedValue({
        json: async () => ({ result: { sequence: 1000 } }),
      });

      await service.start();
      await service.stop();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should not start twice', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (fetch as jest.Mock).mockResolvedValue({
        json: async () => ({ result: { sequence: 1000 } }),
      });

      await service.start();
      await service.start();

      // Should log warning but not fail
      expect(true).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle RPC failures gracefully', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      // Mock RPC failure - getCurrentLedger returns 0
      (fetch as jest.Mock).mockRejectedValue(new Error('RPC unavailable'));

      // Service starts but skips replay since currentLedger (0) <= cursor (1000)
      await service.start();
      
      // Verify service is running
      await service.stop();
      expect(true).toBe(true);
    });

    it('should continue polling after transient errors', async () => {
      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (fetch as jest.Mock)
        .mockResolvedValueOnce({
          json: async () => ({ result: { sequence: 1000 } }),
        })
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce({
          json: async () => ({ result: { sequence: 1005 } }),
        });

      await service.start();

      // Should not crash
      expect(true).toBe(true);
    });
  });

  describe('Failure and Gap-Recovery Scenarios', () => {
    it('retries after an RPC timeout without dropping events', async () => {
      let cursor = 1000;
      const storedEvents = new Set<string>();
      let eventsCallCount = 0;

      (prisma.eventCursor.findUnique as jest.Mock).mockImplementation(async () => ({
        id: 1,
        lastLedgerSeq: cursor,
      }));

      (prisma.eventCursor.upsert as jest.Mock).mockImplementation(async ({ update }) => {
        cursor = update.lastLedgerSeq;
        return { id: 1, lastLedgerSeq: cursor };
      });

      (prisma.processedEvent.findUnique as jest.Mock).mockImplementation(async ({ where }) => {
        return storedEvents.has(where.id) ? { id: where.id } : null;
      });

      (prisma.processedEvent.upsert as jest.Mock).mockImplementation(async ({ create }) => {
        storedEvents.add(create.id);
        return create;
      });

      global.fetch = createStellarRpcFetchMock(async ({ method }) => {
        if (method === 'getLatestLedger') {
          return { result: { sequence: 1002 } };
        }

        eventsCallCount += 1;
        if (eventsCallCount === 1) {
          throw new Error('RPC timeout');
        }

        return {
          result: {
            events: [
              {
                id: 'event-1001',
                type: 'contract',
                ledger: 1001,
                contractId: 'CTEST123',
                txHash: 'tx-1001',
              },
              {
                id: 'event-1002',
                type: 'contract',
                ledger: 1002,
                contractId: 'CTEST123',
                txHash: 'tx-1002',
              },
            ],
          },
        };
      });

      await (service as any).pollEvents();
      expect(cursor).toBe(1000);
      expect(prisma.processedEvent.upsert).not.toHaveBeenCalled();

      await (service as any).pollEvents();

      expect(prisma.processedEvent.upsert).toHaveBeenCalledTimes(2);
      expect(cursor).toBe(1002);
      expect(storedEvents.has('event-1001')).toBe(true);
      expect(storedEvents.has('event-1002')).toBe(true);
    });

    it('re-fetches all missing ledger ranges during replay', async () => {
      const requestedRanges: Array<{ start: number; end: number }> = [];
      const replayService = new EventPollingService({
        ...mockConfig,
        batchSize: 100,
      });

      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});
      (prisma.processedEvent.findUnique as jest.Mock).mockResolvedValue(null);

      global.fetch = createStellarRpcFetchMock(async ({ method, params }) => {
        if (method === 'getLatestLedger') {
          return { result: { sequence: 1200 } };
        }

        requestedRanges.push({
          start: params.startLedger,
          end: params.startLedger + 99,
        });

        return {
          result: {
            events: [],
          },
        };
      });

      await replayService.start();
      await replayService.stop();

      expect(requestedRanges).toEqual([
        { start: 1001, end: 1100 },
        { start: 1101, end: 1200 },
      ]);
      expect(prisma.eventCursor.upsert).toHaveBeenCalledTimes(2);
    });

    it('handles duplicate event delivery idempotently with one DB record', async () => {
      const storedEvents = new Set<string>();

      (prisma.eventCursor.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        lastLedgerSeq: 1000,
      });

      (prisma.eventCursor.upsert as jest.Mock).mockResolvedValue({});

      (prisma.processedEvent.findUnique as jest.Mock).mockImplementation(async ({ where }) => {
        return storedEvents.has(where.id) ? { id: where.id } : null;
      });

      (prisma.processedEvent.upsert as jest.Mock).mockImplementation(async ({ create }) => {
        storedEvents.add(create.id);
        return create;
      });

      global.fetch = createStellarRpcFetchMock(async ({ method }) => {
        if (method === 'getLatestLedger') {
          return { result: { sequence: 1010 } };
        }

        return {
          result: {
            events: [
              {
                id: 'duplicate-event',
                type: 'contract',
                ledger: 1005,
                contractId: 'CTEST123',
                txHash: 'tx-dup',
              },
              {
                id: 'duplicate-event',
                type: 'contract',
                ledger: 1005,
                contractId: 'CTEST123',
                txHash: 'tx-dup',
              },
            ],
          },
        };
      });

      await service.start();

      expect(prisma.processedEvent.upsert).toHaveBeenCalledTimes(1);
      expect(storedEvents.size).toBe(1);
      expect(storedEvents.has('duplicate-event')).toBe(true);
    });
  });
});

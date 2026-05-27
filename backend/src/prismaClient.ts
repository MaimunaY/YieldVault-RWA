/**
 * Centralized Prisma Client configuration.
 * Ensures a single client instance across the application and prevents
 * multiple instrumentation patches during test runs.
 *
 * The @prisma/instrumentation package may patch the PrismaClient constructor,
 * so we need to provide the options it expects to avoid panics.
 */

import { PrismaClient } from '@prisma/client';
import { logger } from './middleware/structuredLogging';
import { dbQueryDurationSeconds } from './metrics';

let prismaClientInstance: PrismaClient | null = null;
const SLOW_QUERY_THRESHOLD_MS = parsePositiveInt(process.env.SLOW_QUERY_THRESHOLD_MS, 500);

interface QueryLabels {
  model: string;
  action: string;
}

/**
 * Get or create the shared Prisma Client instance.
 * This ensures only one client exists and prevents instrumentation conflicts.
 */
export function getPrismaClient(): PrismaClient {
  if (!prismaClientInstance) {
    const isTestEnv = process.env.NODE_ENV === 'test';

    if (isTestEnv) {
      logger.log('info', 'Initializing Prisma Client for test environment', {});
    }

    // Build the client options
    const clientOptions: any = {
      log: [
        {
          emit: 'event',
          level: 'error',
        },
        {
          emit: 'event',
          level: 'query',
        },
      ],
    };

    // Create the Prisma Client instance with explicit options
    try {
      const prismaClient = new PrismaClient(clientOptions) as PrismaClient;
      prismaClientInstance = prismaClient;

      (prismaClient as any).$on('query', (event: any) => {
        const labels = parseQueryLabels(String(event.query || ''));
        const durationMs = Number(event.duration || 0);

        dbQueryDurationSeconds.observe(labels, durationMs / 1000);

        if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
          logger.log('warn', 'Slow Prisma query detected', {
            model: labels.model,
            action: labels.action,
            durationMs,
          });
        }
      });
    } catch (error) {
      logger.log('error', 'Failed to create Prisma Client', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return prismaClientInstance as PrismaClient;
}

/**
 * Disconnect the Prisma Client instance.
 * Call this during graceful shutdown.
 */
export async function disconnectPrismaClient(): Promise<void> {
  if (prismaClientInstance) {
    try {
      await prismaClientInstance.$disconnect();
    } catch (error) {
      logger.log('warn', 'Error disconnecting Prisma Client', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    prismaClientInstance = null;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw || '', 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseQueryLabels(query: string): QueryLabels {
  const normalized = query.trim();
  const action = parseActionLabel(normalized);
  const model = parseModelLabel(normalized, action);

  return {
    model,
    action,
  };
}

function parseActionLabel(query: string): string {
  const firstWord = query.split(/\s+/, 1)[0]?.toUpperCase() || '';
  switch (firstWord) {
    case 'SELECT':
      return 'select';
    case 'INSERT':
      return 'insert';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'other';
  }
}

function parseModelLabel(query: string, action: string): string {
  const upperAction = action.toUpperCase();

  if (upperAction === 'SELECT') {
    const match = query.match(/\bFROM\s+"?([A-Za-z0-9_$.]+)"?/i);
    return (match?.[1] || 'unknown').toLowerCase();
  }

  if (upperAction === 'INSERT') {
    const match = query.match(/\bINTO\s+"?([A-Za-z0-9_$.]+)"?/i);
    return (match?.[1] || 'unknown').toLowerCase();
  }

  if (upperAction === 'UPDATE') {
    const match = query.match(/\bUPDATE\s+"?([A-Za-z0-9_$.]+)"?/i);
    return (match?.[1] || 'unknown').toLowerCase();
  }

  if (upperAction === 'DELETE') {
    const match = query.match(/\bFROM\s+"?([A-Za-z0-9_$.]+)"?/i);
    return (match?.[1] || 'unknown').toLowerCase();
  }

  return 'unknown';
}

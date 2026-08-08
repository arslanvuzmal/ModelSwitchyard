import Redis from 'ioredis';

/**
 * Redis client for distributed coordination.
 * Used by circuit breakers, rate limiters, and distributed locks.
 */

const globalForRedis = globalThis as unknown as {
  omnirouterRedis: Redis | undefined;
};

export const redis: Redis =
  globalForRedis.omnirouterRedis ??
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null; // Stop retrying
      return Math.min(times * 100, 3000);
    },
    lazyConnect: true,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.omnirouterRedis = redis;
}

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});

redis.on('connect', () => {
  console.warn('[Redis] Connected');
});

/**
 * Ensures Redis connection is established.
 * Call during application startup.
 */
export async function connectRedis(): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect();
  }
}

/**
 * Gracefully close Redis connection.
 */
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

/**
 * Health check for Redis.
 */
export async function redisHealthCheck(): Promise<{
  healthy: boolean;
  latencyMs: number;
  detail: string;
}> {
  const start = Date.now();
  try {
    await redis.ping();
    return {
      healthy: true,
      latencyMs: Date.now() - start,
      detail: 'Redis responded to PING',
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      detail: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

import { redis } from '@/lib/redis/client';

/**
 * Distributed rate limiter using Redis.
 *
 * Supports per-second, per-minute, per-hour limits
 * scoped by workspace, application, environment, or API key.
 */

export type RateLimitWindow = 'second' | 'minute' | 'hour';
export type RateLimitScope = 'workspace' | 'application' | 'environment' | 'apikey';

export interface RateLimitConfig {
  window: RateLimitWindow;
  maxRequests: number;
  scope: RateLimitScope;
}

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs?: number;
}

const WINDOW_MS: Record<RateLimitWindow, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
};

const WINDOW_SECONDS: Record<RateLimitWindow, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
};

function rateLimitKey(
  scope: RateLimitScope,
  identifier: string,
  window: RateLimitWindow,
): string {
  const now = Date.now();
  const windowMs = WINDOW_MS[window];
  const windowStart = now - (now % windowMs);
  return `ratelimit:${scope}:${identifier}:${window}:${windowStart}`;
}

/**
 * Checks and increments a rate limit counter atomically.
 * Uses Redis INCR with TTL for sliding window approximation.
 */
export async function checkRateLimit(
  config: RateLimitConfig,
  identifier: string,
): Promise<RateLimitResult> {
  const key = rateLimitKey(config.scope, identifier, config.window);
  const windowSeconds = WINDOW_SECONDS[config.window];

  const multi = redis.multi();
  multi.incr(key);
  multi.ttl(key);
  const results = await multi.exec();

  if (!results) {
    throw new Error('Redis multi exec returned null');
  }

  const [[, current], [, ttl]] = results as [
    [Error | null, number],
    [Error | null, number],
  ];
  const count = current ?? 1;
  const ttlSeconds = ttl > 0 ? ttl : windowSeconds;

  const allowed = count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - count);
  const resetAt = Date.now() + ttlSeconds * 1000;

  // Set expiry on first request
  if (count === 1) {
    await redis.expire(key, windowSeconds + 1);
  }

  return {
    allowed,
    current: count,
    limit: config.maxRequests,
    remaining,
    resetAt,
    retryAfterMs: allowed ? undefined : ttlSeconds * 1000,
  };
}

/**
 * Checks multiple rate limits (e.g., per-second AND per-minute).
 * All must pass for the request to be allowed.
 */
export async function checkRateLimits(
  configs: RateLimitConfig[],
  identifiers: Record<RateLimitScope, string>,
): Promise<{
  allowed: boolean;
  results: RateLimitResult[];
  worstResult?: RateLimitResult;
}> {
  const results: RateLimitResult[] = [];

  for (const config of configs) {
    const identifier = identifiers[config.scope];
    if (!identifier) continue;

    const result = await checkRateLimit(config, identifier);
    results.push(result);

    if (!result.allowed) {
      return {
        allowed: false,
        results,
        worstResult: result,
      };
    }
  }

  return { allowed: true, results };
}

/**
 * Gets current rate limit status without incrementing.
 */
export async function getRateLimitStatus(
  config: RateLimitConfig,
  identifier: string,
): Promise<RateLimitResult> {
  const key = rateLimitKey(config.scope, identifier, config.window);
  const windowSeconds = WINDOW_SECONDS[config.window];

  const current = (await redis.get(key)) ? Number(await redis.get(key)) : 0;
  const ttl = await redis.ttl(key);
  const ttlSeconds = ttl > 0 ? ttl : windowSeconds;

  return {
    allowed: current < config.maxRequests,
    current,
    limit: config.maxRequests,
    remaining: Math.max(0, config.maxRequests - current),
    resetAt: Date.now() + ttlSeconds * 1000,
  };
}

/**
 * Resets a rate limit (admin action).
 */
export async function resetRateLimit(
  scope: RateLimitScope,
  identifier: string,
  window?: RateLimitWindow,
): Promise<void> {
  const pattern = window
    ? `ratelimit:${scope}:${identifier}:${window}:*`
    : `ratelimit:${scope}:${identifier}:*`;

  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/**
 * Standard rate limit configurations for different tiers.
 */
export const RATE_LIMIT_PRESETS = {
  strict: [
    { window: 'second' as const, maxRequests: 10, scope: 'apikey' as const },
    { window: 'minute' as const, maxRequests: 60, scope: 'apikey' as const },
    { window: 'hour' as const, maxRequests: 1000, scope: 'apikey' as const },
  ],
  standard: [
    { window: 'second' as const, maxRequests: 30, scope: 'apikey' as const },
    { window: 'minute' as const, maxRequests: 300, scope: 'apikey' as const },
    { window: 'hour' as const, maxRequests: 10000, scope: 'apikey' as const },
  ],
  generous: [
    { window: 'second' as const, maxRequests: 100, scope: 'apikey' as const },
    { window: 'minute' as const, maxRequests: 1000, scope: 'apikey' as const },
    { window: 'hour' as const, maxRequests: 50000, scope: 'apikey' as const },
  ],
} as const satisfies Record<string, RateLimitConfig[]>;

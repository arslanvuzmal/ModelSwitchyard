import { redis } from '@/lib/redis/client';
import type { ProviderKind } from '@/lib/database/generated/enums';

/**
 * Distributed circuit breaker for provider connections and model deployments.
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failing fast, no requests sent (except probes)
 * - HALF_OPEN: Testing recovery with limited probe requests
 *
 * Scoped by: providerKind + modelId (deployment-level granularity)
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Minimum requests in window before evaluating failure rate */
  minimumRequests: number;
  /** Failure rate threshold (0-1) to trip the circuit */
  failureThreshold: number;
  /** Consecutive failures to trip immediately */
  consecutiveFailureThreshold: number;
  /** Time in ms before attempting recovery */
  cooldownMs: number;
  /** Max probe requests allowed in HALF_OPEN */
  halfOpenProbeLimit: number;
  /** Rolling window size in ms */
  windowMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  minimumRequests: 10,
  failureThreshold: 0.5,
  consecutiveFailureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenProbeLimit: 3,
  windowMs: 60_000,
};

export interface CircuitStatus {
  state: CircuitState;
  failureRate: number;
  consecutiveFailures: number;
  totalRequests: number;
  failedRequests: number;
  openedAt: number | null;
  cooldownUntil: number | null;
  lastProbeAt: number | null;
  probesInHalfOpen: number;
}

const CIRCUIT_KEY_PREFIX = 'circuit:';
const CIRCUIT_TTL_SECONDS = 300; // 5 minutes

function circuitKey(providerKind: ProviderKind, modelId: string): string {
  return `${CIRCUIT_KEY_PREFIX}${providerKind}:${modelId}`;
}

/**
 * Records a request outcome and updates circuit state.
 * Returns the new circuit status.
 */
export async function recordCircuitResult(
  providerKind: ProviderKind,
  modelId: string,
  success: boolean,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
): Promise<CircuitStatus> {
  const key = circuitKey(providerKind, modelId);
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Use a sorted set for rolling window: score = timestamp, member = "success"/"failure":uuid
  const member = `${success ? 's' : 'f'}:${now}:${Math.random().toString(36).slice(2)}`;

  const multi = redis.multi();
  multi.zadd(key, now, member);
  multi.zremrangebyscore(key, 0, windowStart);
  multi.expire(key, CIRCUIT_TTL_SECONDS);
  await multi.exec();

  return evaluateCircuit(providerKind, modelId, config);
}

/**
 * Evaluates current circuit state without recording a new result.
 */
export async function evaluateCircuit(
  providerKind: ProviderKind,
  modelId: string,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
): Promise<CircuitStatus> {
  const key = circuitKey(providerKind, modelId);
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Get all entries in window
  const entries: string[] = await redis.zrangebyscore(key, windowStart, '+inf');

  const totalRequests = entries.length;
  const failedRequests = entries.filter((e) => e.startsWith('f:')).length;
  const failureRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

  // Count consecutive failures from most recent
  let consecutiveFailures = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith('f:')) consecutiveFailures++;
    else break;
  }

  // Load persisted state
  const stateKey = `${key}:state`;
  const persisted: Record<string, string> = await redis.hgetall(stateKey);

  if (!persisted || Object.keys(persisted).length === 0) {
    return {
      state: 'CLOSED' as CircuitState,
      failureRate,
      consecutiveFailures,
      totalRequests,
      failedRequests,
      openedAt: null,
      cooldownUntil: null,
      lastProbeAt: null,
      probesInHalfOpen: 0,
    };
  }

  const persistedRecord: Record<string, string> = persisted as Record<string, string>;
  const state = (persistedRecord.state as CircuitState) ?? 'CLOSED';
  const openedAt = persistedRecord.openedAt ? Number(persistedRecord.openedAt) : null;
  const cooldownUntil = persistedRecord.cooldownUntil
    ? Number(persistedRecord.cooldownUntil)
    : null;
  const lastProbeAt = persistedRecord.lastProbeAt
    ? Number(persistedRecord.lastProbeAt)
    : null;
  const probesInHalfOpen = persistedRecord.probesInHalfOpen
    ? Number(persistedRecord.probesInHalfOpen)
    : 0;

  let newState = state;
  let newOpenedAt = openedAt;
  let newCooldownUntil = cooldownUntil;
  const newLastProbeAt = lastProbeAt;
  let newProbesInHalfOpen = probesInHalfOpen;

  switch (state) {
    case 'CLOSED': {
      const shouldTrip =
        totalRequests >= config.minimumRequests &&
        (failureRate >= config.failureThreshold ||
          consecutiveFailures >= config.consecutiveFailureThreshold);

      if (shouldTrip) {
        newState = 'OPEN';
        newOpenedAt = now;
        newCooldownUntil = now + config.cooldownMs;
      }
      break;
    }

    case 'OPEN': {
      if (now >= (cooldownUntil ?? 0)) {
        newState = 'HALF_OPEN';
        newProbesInHalfOpen = 0;
      }
      break;
    }

    case 'HALF_OPEN': {
      // State transitions handled by recordProbeResult
      break;
    }
  }

  // Persist state
  await redis.hset(stateKey, {
    state: newState,
    openedAt: newOpenedAt?.toString() ?? '',
    cooldownUntil: newCooldownUntil?.toString() ?? '',
    lastProbeAt: newLastProbeAt?.toString() ?? '',
    probesInHalfOpen: newProbesInHalfOpen.toString(),
  });
  await redis.expire(stateKey, CIRCUIT_TTL_SECONDS);

  return {
    state: newState,
    failureRate,
    consecutiveFailures,
    totalRequests,
    failedRequests,
    openedAt: newOpenedAt,
    cooldownUntil: newCooldownUntil,
    lastProbeAt: newLastProbeAt,
    probesInHalfOpen: newProbesInHalfOpen,
  };
}

/**
 * Records a probe result in HALF_OPEN state.
 * Called when a test request is allowed through during HALF_OPEN.
 */
export async function recordProbeResult(
  providerKind: ProviderKind,
  modelId: string,
  success: boolean,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
): Promise<CircuitStatus> {
  const key = circuitKey(providerKind, modelId);
  const stateKey = `${key}:state`;
  const now = Date.now();

  const persisted = await redis.hgetall(stateKey);
  const state = (persisted.state as CircuitState) ?? 'CLOSED';
  const probesInHalfOpen = persisted.probesInHalfOpen
    ? Number(persisted.probesInHalfOpen)
    : 0;

  if (state !== 'HALF_OPEN') {
    return evaluateCircuit(providerKind, modelId, config);
  }

  const newProbesInHalfOpen = probesInHalfOpen + 1;
  let newState: CircuitState = 'HALF_OPEN';
  let newCooldownUntil: number | null = null;

  if (success) {
    // Successful probe - close the circuit
    newState = 'CLOSED';
    newCooldownUntil = null;
  } else if (newProbesInHalfOpen >= config.halfOpenProbeLimit) {
    // Too many failed probes - reopen
    newState = 'OPEN';
    newCooldownUntil = now + config.cooldownMs;
  }

  await redis.hset(stateKey, {
    state: newState,
    cooldownUntil: newCooldownUntil?.toString() ?? '',
    lastProbeAt: now.toString(),
    probesInHalfOpen: newProbesInHalfOpen.toString(),
  });
  await redis.expire(stateKey, CIRCUIT_TTL_SECONDS);

  // Also record the result in the rolling window
  await recordCircuitResult(providerKind, modelId, success, config);

  return evaluateCircuit(providerKind, modelId, config);
}

/**
 * Checks if a request should be allowed through the circuit.
 * Returns { allowed: true } if closed or half-open with probe budget,
 * { allowed: false, reason, retryAfterMs } if open.
 */
export async function checkCircuit(
  providerKind: ProviderKind,
  modelId: string,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
): Promise<{
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
  state: CircuitState;
}> {
  const status = await evaluateCircuit(providerKind, modelId, config);

  switch (status.state) {
    case 'CLOSED':
      return { allowed: true, state: 'CLOSED' };

    case 'OPEN': {
      const retryAfterMs = Math.max(0, (status.cooldownUntil ?? 0) - Date.now());
      return {
        allowed: false,
        reason: `Circuit OPEN for ${providerKind}/${modelId}. Cooldown until ${new Date(status.cooldownUntil!).toISOString()}`,
        retryAfterMs,
        state: 'OPEN',
      };
    }

    case 'HALF_OPEN': {
      if (status.probesInHalfOpen < config.halfOpenProbeLimit) {
        return { allowed: true, state: 'HALF_OPEN' };
      }
      const retryAfterMs = Math.max(0, (status.cooldownUntil ?? 0) - Date.now());
      return {
        allowed: false,
        reason: `Circuit HALF_OPEN probe limit reached for ${providerKind}/${modelId}`,
        retryAfterMs,
        state: 'HALF_OPEN',
      };
    }
  }
}

/**
 * Manually reset a circuit (admin action).
 */
export async function resetCircuit(
  providerKind: ProviderKind,
  modelId: string,
): Promise<void> {
  const key = circuitKey(providerKind, modelId);
  await redis.del(key, `${key}:state`);
}

/**
 * Get all circuit statuses for a workspace (for dashboard).
 */
export async function getAllCircuitStatuses(
  providerModels: Array<{ providerKind: ProviderKind; modelId: string }>,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
): Promise<Map<string, CircuitStatus>> {
  const results = new Map<string, CircuitStatus>();

  for (const { providerKind, modelId } of providerModels) {
    const status = await evaluateCircuit(providerKind, modelId, config);
    results.set(`${providerKind}:${modelId}`, status);
  }

  return results;
}

/**
 * Force a circuit open (admin action for maintenance).
 */
export async function forceOpenCircuit(
  providerKind: ProviderKind,
  modelId: string,
): Promise<void> {
  const key = circuitKey(providerKind, modelId);
  const stateKey = `${key}:state`;
  const now = Date.now();

  await redis.hset(stateKey, {
    state: 'OPEN',
    openedAt: now.toString(),
    cooldownUntil: (now + 24 * 60 * 60 * 1000).toString(), // 24 hours
    lastProbeAt: '',
    probesInHalfOpen: '0',
  });
  await redis.expire(stateKey, CIRCUIT_TTL_SECONDS);
}

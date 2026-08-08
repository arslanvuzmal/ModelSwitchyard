import { prisma } from '@/lib/database/client';
import type { ProviderKind } from '@/lib/database/generated/enums';

/**
 * Percentile latency metrics and quality signals.
 *
 * Computes P50, P75, P90, P95, P99, and other metrics
 * over rolling windows for routing decisions.
 */

export type LatencyMetric =
  'TTFT_P50' | 'TTFT_P95' | 'TOTAL_LATENCY_P50' | 'TOTAL_LATENCY_P95' | 'THROUGHPUT_P50';

export interface PercentileMetrics {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  count: number;
  windowMs: number;
  windowStart: Date;
}

export interface ModelMetrics {
  modelId: string;
  modelLabel: string;
  providerKind: ProviderKind;
  ttft: PercentileMetrics;
  totalLatency: PercentileMetrics;
  throughput: PercentileMetrics;
  successRate: number;
  errorRate: number;
  errorBreakdown: Record<string, number>;
  lastUpdated: Date;
}

/**
 * Computes percentiles from a sorted array of values.
 */
function computePercentiles(sortedValues: number[]): {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
} {
  if (sortedValues.length === 0) {
    return { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0 };
  }

  const getPercentile = (p: number): number => {
    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)] ?? 0;
  };

  return {
    p50: getPercentile(50),
    p75: getPercentile(75),
    p90: getPercentile(90),
    p95: getPercentile(95),
    p99: getPercentile(99),
  };
}

/**
 * Fetches recent attempts for a model and computes percentile metrics.
 */
export async function computeModelMetrics(
  modelId: string,
  windowMs: number = 60 * 60 * 1000, // 1 hour default
): Promise<ModelMetrics | null> {
  const windowStart = new Date(Date.now() - windowMs);

  const attempts = await prisma.requestAttempt.findMany({
    where: {
      modelId,
      startedAt: { gte: windowStart },
      status: { in: ['SUCCEEDED', 'FAILED', 'TIMED_OUT'] },
    },
    select: {
      latencyMs: true,
      status: true,
      errorCategory: true,
      inputTokens: true,
      outputTokens: true,
      metadata: true,
    },
  });

  if (attempts.length === 0) {
    return null;
  }

  const successful = attempts.filter((a) => a.status === 'SUCCEEDED');
  const failed = attempts.filter((a) => a.status !== 'SUCCEEDED');

  // Total latency percentiles (all attempts)
  const allLatencies = attempts.map((a) => a.latencyMs).sort((a, b) => a - b);
  const totalLatencyPercentiles = computePercentiles(allLatencies);

  // TTFT percentiles (successful only, from metadata if available)
  const ttftValues = successful
    .map((a) => {
      const meta = a.metadata as Record<string, unknown> | null;
      if (meta?.ttftMs && typeof meta.ttftMs === 'number') return meta.ttftMs;
      return a.latencyMs; // Fallback to total latency
    })
    .sort((a, b) => a - b);
  const ttftPercentiles = computePercentiles(ttftValues);

  // Throughput (tokens/second) for successful attempts
  const throughputValues = successful
    .map((a) => {
      if (a.latencyMs > 0 && a.outputTokens > 0) {
        return (a.outputTokens / a.latencyMs) * 1000;
      }
      return 0;
    })
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const throughputPercentiles = computePercentiles(throughputValues);

  // Error breakdown
  const errorBreakdown: Record<string, number> = {};
  for (const attempt of failed) {
    const cat = attempt.errorCategory ?? 'UNKNOWN';
    errorBreakdown[cat] = (errorBreakdown[cat] ?? 0) + 1;
  }

  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
    select: { modelId: true, connection: { select: { kind: true } } },
  });

  return {
    modelId,
    modelLabel: model?.modelId ?? 'unknown',
    providerKind: model?.connection.kind ?? 'DEMO',
    ttft: {
      p50: ttftPercentiles.p50,
      p75: ttftPercentiles.p75,
      p90: ttftPercentiles.p90,
      p95: ttftPercentiles.p95,
      p99: ttftPercentiles.p99,
      count: ttftValues.length,
      windowMs,
      windowStart,
    },
    totalLatency: {
      p50: totalLatencyPercentiles.p50,
      p75: totalLatencyPercentiles.p75,
      p90: totalLatencyPercentiles.p90,
      p95: totalLatencyPercentiles.p95,
      p99: totalLatencyPercentiles.p99,
      count: allLatencies.length,
      windowMs,
      windowStart,
    },
    throughput: {
      p50: throughputPercentiles.p50,
      p75: throughputPercentiles.p75,
      p90: throughputPercentiles.p90,
      p95: throughputPercentiles.p95,
      p99: throughputPercentiles.p99,
      count: throughputValues.length,
      windowMs,
      windowStart,
    },
    successRate: successful.length / attempts.length,
    errorRate: failed.length / attempts.length,
    errorBreakdown,
    lastUpdated: new Date(),
  };
}

/**
 * Computes metrics for all models in a workspace.
 */
export async function computeWorkspaceMetrics(
  workspaceId: string,
  windowMs: number = 60 * 60 * 1000,
): Promise<ModelMetrics[]> {
  const models = await prisma.modelDefinition.findMany({
    where: { workspaceId, isAvailable: true },
    select: { id: true },
  });

  const results: ModelMetrics[] = [];

  for (const model of models) {
    const metrics = await computeModelMetrics(model.id, windowMs);
    if (metrics) results.push(metrics);
  }

  return results;
}

/**
 * Gets a specific latency metric for routing decisions.
 */
export function getLatencyMetric(metrics: ModelMetrics, metric: LatencyMetric): number {
  switch (metric) {
    case 'TTFT_P50':
      return metrics.ttft.p50;
    case 'TTFT_P95':
      return metrics.ttft.p95;
    case 'TOTAL_LATENCY_P50':
      return metrics.totalLatency.p50;
    case 'TOTAL_LATENCY_P95':
      return metrics.totalLatency.p95;
    case 'THROUGHPUT_P50':
      return metrics.throughput.p50;
    default:
      return metrics.totalLatency.p95;
  }
}

/**
 * Checks if metrics have sufficient sample size for confidence.
 */
export function hasSufficientSamples(
  metrics: ModelMetrics,
  minimumSamples: number = 10,
): boolean {
  return metrics.totalLatency.count >= minimumSamples;
}

/**
 * Computes a confidence score based on sample size.
 * Returns 0-1 where 1 = high confidence.
 */
export function computeConfidence(
  metrics: ModelMetrics,
  targetSamples: number = 100,
): number {
  const count = metrics.totalLatency.count;
  if (count === 0) return 0;
  return Math.min(1, count / targetSamples);
}

/**
 * Adjusts a metric value based on confidence.
 * Low confidence metrics are adjusted toward a neutral/default value.
 */
export function adjustForConfidence(
  value: number,
  confidence: number,
  defaultValue: number,
): number {
  // Linear interpolation: at confidence=1, use value; at confidence=0, use default
  return value * confidence + defaultValue * (1 - confidence);
}

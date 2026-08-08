import type { AttemptStatus, ErrorCategory } from '@/lib/database/generated/enums';

import { backoffDelayMs, retryPolicyFor, safeMessageFor } from '../errors';
import { estimateCost } from '../pricing';
import type { RouteCandidate } from '../routing/types';
import type {
  CompletionRequest,
  CompletionResponse,
  NormalisedError,
  ProviderContext,
} from '../types';

/**
 * Fallback executor.
 *
 * Walks the ranked chain from the routing engine, applying the retry policy for
 * whichever category each failure classified as. Guarantees:
 *
 *  - Bounded work: capped by both maxAttempts and totalTimeoutMs.
 *  - No infinite loops: every path consumes an attempt or exits.
 *  - One usage record: only the succeeding attempt contributes billable usage.
 *  - One client response: the first success returns immediately.
 *  - Non-retryable failures stop the chain rather than walking it pointlessly.
 *  - Cancellation: respects AbortSignal to stop spending on client disconnect.
 */

export interface AttemptRecord {
  sequence: number;
  modelId: string;
  modelLabel: string;
  providerKind: RouteCandidate['providerKind'];
  status: AttemptStatus;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
  providerRequestId: string | null;
  /** Why this attempt was made: initial selection, retry, or fallback. */
  reason: string;
  startedAt: Date;
  completedAt: Date;
}

export interface ExecuteOptions {
  request: CompletionRequest;
  /** Selected target first, then the fallback chain in rank order. */
  chain: RouteCandidate[];
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  correlationId: string;
  /** Performs one provider call. Injected so the executor stays testable. */
  invoke: (
    candidate: RouteCandidate,
    request: CompletionRequest,
    context: ProviderContext,
  ) => Promise<CompletionResponse>;
  /** Classifies a thrown value into the normalised error shape. */
  classify: (candidate: RouteCandidate, error: unknown) => NormalisedError;
  /** Resolves per-candidate call context (credential, base URL, demo faults). */
  buildContext: (candidate: RouteCandidate, timeoutMs: number) => ProviderContext;
  /** Optional AbortSignal for cancellation (e.g., client disconnect). */
  abortSignal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface ExecuteResult {
  response: CompletionResponse | null;
  attempts: AttemptRecord[];
  finalError: NormalisedError | null;
  fallbackUsed: boolean;
  totalLatencyMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function executeWithFallback(
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const abortSignal = options.abortSignal;

  const startedAt = now();
  const attempts: AttemptRecord[] = [];

  let sequence = 0;
  let finalError: NormalisedError | null = null;
  let candidateIndex = 0;

  const deadline = startedAt + options.totalTimeoutMs;

  // Check for immediate abort
  if (abortSignal?.aborted) {
    return {
      response: null,
      attempts: [],
      finalError: {
        category: 'CLIENT_CANCELLED',
        message: 'Request was cancelled by the client.',
        retryable: false,
      },
      fallbackUsed: false,
      totalLatencyMs: 0,
    };
  }

  // Set up abort listener
  let abortHandler: (() => void) | null = null;
  if (abortSignal) {
    abortHandler = () => {};
    abortSignal.addEventListener('abort', abortHandler);
  }

  try {
    while (candidateIndex < options.chain.length) {
      // Check for abort before each attempt
      if (abortSignal?.aborted) {
        finalError = {
          category: 'CLIENT_CANCELLED',
          message: 'Request was cancelled by the client.',
          retryable: false,
        };
        break;
      }

      const candidate = options.chain[candidateIndex];
      if (!candidate) break;

      const isFirstCandidate = candidateIndex === 0;
      const policyForPrevious = finalError ? retryPolicyFor(finalError.category) : null;

      // A non-retryable, non-fallbackable failure ends the chain immediately.
      if (policyForPrevious && !policyForPrevious.allowFallback) {
        break;
      }

      let retriesUsed = 0;

      // Inner loop: the same candidate may be retried when its policy allows it.
      for (;;) {
        if (attempts.length >= options.maxAttempts) {
          finalError = finalError ?? {
            category: 'UNKNOWN',
            message: `The attempt limit of ${options.maxAttempts} was reached.`,
            retryable: false,
          };
          return finish();
        }

        const remaining = deadline - now();
        if (remaining <= 0) {
          finalError = {
            category: 'TIMEOUT',
            message: `The overall timeout of ${options.totalTimeoutMs} ms was reached before a provider responded.`,
            retryable: false,
          };
          return finish();
        }

        sequence += 1;
        const attemptStartedAt = new Date(now());
        const timeoutMs = Math.min(options.attemptTimeoutMs, remaining);
        const context = options.buildContext(candidate, timeoutMs);

        const reason = describeReason(isFirstCandidate, retriesUsed, sequence);

        try {
          const response = await options.invoke(candidate, options.request, context);

          const cost = estimateCost(response.usage, {
            inputPricePerMillion: candidate.inputPricePerMillion,
            outputPricePerMillion: candidate.outputPricePerMillion,
          });

          attempts.push({
            sequence,
            modelId: candidate.modelId,
            modelLabel: candidate.modelLabel,
            providerKind: candidate.providerKind,
            status: 'SUCCEEDED',
            errorCategory: null,
            errorMessage: null,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            estimatedCost: cost,
            latencyMs: response.latencyMs,
            providerRequestId: response.providerRequestId,
            reason,
            startedAt: attemptStartedAt,
            completedAt: new Date(now()),
          });

          return {
            response: { ...response, estimatedCost: cost },
            attempts,
            finalError: null,
            fallbackUsed: candidateIndex > 0,
            totalLatencyMs: now() - startedAt,
          };
        } catch (error) {
          const normalised = options.classify(candidate, error);
          finalError = normalised;

          attempts.push({
            sequence,
            modelId: candidate.modelId,
            modelLabel: candidate.modelLabel,
            providerKind: candidate.providerKind,
            status:
              normalised.category === 'TIMEOUT'
                ? ('TIMED_OUT' as AttemptStatus)
                : ('FAILED' as AttemptStatus),
            errorCategory: normalised.category,
            errorMessage: normalised.message,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCost: 0,
            latencyMs: now() - attemptStartedAt.getTime(),
            providerRequestId: null,
            reason,
            startedAt: attemptStartedAt,
            completedAt: new Date(now()),
          });

          const policy = retryPolicyFor(normalised.category);

          // Retry the same target only while its policy permits it.
          if (policy.retrySameTarget && retriesUsed < policy.maxRetries) {
            retriesUsed += 1;

            const delay =
              normalised.retryAfterMs ??
              backoffDelayMs(normalised.category, retriesUsed, random);

            if (delay > 0) await sleep(Math.min(delay, Math.max(0, deadline - now())));
            continue;
          }

          if (!policy.allowFallback) {
            return finish();
          }

          break; // Move to the next candidate.
        }
      }

      candidateIndex += 1;
    }

    return finish();
  } finally {
    // Clean up abort listener
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  }

  function finish(): ExecuteResult {
    return {
      response: null,
      attempts,
      finalError: finalError ?? {
        category: 'PROVIDER_UNAVAILABLE',
        message: safeMessageFor('PROVIDER_UNAVAILABLE'),
        retryable: false,
      },
      fallbackUsed: attempts.length > 1,
      totalLatencyMs: now() - startedAt,
    };
  }
}

function describeReason(
  isFirstCandidate: boolean,
  retriesUsed: number,
  sequence: number,
): string {
  if (retriesUsed > 0) {
    return `Retry ${retriesUsed} against the same target after a retryable failure.`;
  }
  if (isFirstCandidate && sequence === 1) {
    return 'Primary target selected by the routing policy.';
  }
  return 'Fallback target, used after the previous target failed.';
}

/** Marks candidates never reached, so the trace shows the full considered set. */
export function buildSkippedAttempts(
  chain: RouteCandidate[],
  attempts: AttemptRecord[],
  startSequence: number,
): AttemptRecord[] {
  const tried = new Set(attempts.map((attempt) => attempt.modelId));
  const now = new Date();

  return chain
    .filter((candidate) => !tried.has(candidate.modelId))
    .map((candidate, index) => ({
      sequence: startSequence + index,
      modelId: candidate.modelId,
      modelLabel: candidate.modelLabel,
      providerKind: candidate.providerKind,
      status: 'SKIPPED' as AttemptStatus,
      errorCategory: null,
      errorMessage: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      latencyMs: 0,
      providerRequestId: null,
      reason: 'Not reached: an earlier target succeeded or the chain terminated.',
      startedAt: now,
      completedAt: now,
    }));
}

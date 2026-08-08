import type { ErrorCategory } from '@/lib/database/generated/enums';

import type { NormalisedError } from './types';
export type { NormalisedError } from './types';

/**
 * Failure taxonomy and retry policy.
 *
 * Classifying a failure before reacting to it is what separates a gateway from
 * a retry loop. Retrying an authentication failure wastes quota and can lock an
 * account; retrying a validation error can never succeed; retrying a safety
 * refusal against a different provider is a deliberate policy decision, not a
 * default.
 */

export interface RetryPolicy {
  /** May the same target be tried again? */
  retrySameTarget: boolean;
  /** May a different target be tried? */
  allowFallback: boolean;
  /** Additional attempts against the same target, beyond the first. */
  maxRetries: number;
  /** Base delay for exponential backoff, in milliseconds. */
  backoffBaseMs: number;
  /** Operator-facing justification, surfaced in the trace. */
  rationale: string;
}

export const RETRY_POLICIES: Record<ErrorCategory, RetryPolicy> = {
  AUTHENTICATION: {
    retrySameTarget: false,
    allowFallback: true,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale:
      'Credentials will not become valid by repetition. The connection is flagged for an administrator and the next eligible target is used.',
  },
  PERMISSION: {
    retrySameTarget: false,
    allowFallback: true,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale: 'The credential lacks access to this model. Retrying cannot grant it.',
  },
  RATE_LIMIT: {
    retrySameTarget: true,
    allowFallback: true,
    maxRetries: 1,
    backoffBaseMs: 500,
    rationale:
      'Rate limits are transient. One backed-off retry is attempted before moving to the next target.',
  },
  TIMEOUT: {
    retrySameTarget: true,
    allowFallback: true,
    maxRetries: 1,
    backoffBaseMs: 250,
    rationale:
      'A single retry covers transient slowness; a second would risk duplicating a request that may already be executing.',
  },
  PROVIDER_UNAVAILABLE: {
    retrySameTarget: false,
    allowFallback: true,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale:
      'The provider reported itself unavailable. Fallback is immediate rather than delayed.',
  },
  INVALID_REQUEST: {
    retrySameTarget: false,
    allowFallback: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale:
      'The request is malformed. It will fail identically everywhere, so no fallback is attempted.',
  },
  CONTEXT_LIMIT: {
    retrySameTarget: false,
    allowFallback: true,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale:
      'Fallback is permitted only to a target with a larger context window. Content is never silently truncated.',
  },
  SAFETY_REFUSAL: {
    retrySameTarget: false,
    allowFallback: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale:
      'A safety refusal is returned to the caller. Shopping the same prompt to another provider to obtain a different answer is not a default behaviour.',
  },
  MALFORMED_RESPONSE: {
    retrySameTarget: true,
    allowFallback: true,
    maxRetries: 1,
    backoffBaseMs: 100,
    rationale:
      'A response that failed schema validation may succeed on retry; otherwise the next target is used.',
  },
  NETWORK: {
    retrySameTarget: true,
    allowFallback: true,
    maxRetries: 1,
    backoffBaseMs: 250,
    rationale: 'Transient network faults are retried once, then fall back.',
  },
  QUOTA_EXCEEDED: {
    retrySameTarget: false,
    allowFallback: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale:
      'A workspace quota was exceeded. This is a deliberate rejection, not a provider failure.',
  },
  UNKNOWN: {
    retrySameTarget: false,
    allowFallback: true,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale:
      'An unclassified failure falls back once without retrying, so an unrecognised condition cannot cause repeated calls.',
  },
  CLIENT_CANCELLED: {
    retrySameTarget: false,
    allowFallback: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    rationale: 'The client cancelled the request. No retry or fallback is attempted.',
  },
};

export function retryPolicyFor(category: ErrorCategory): RetryPolicy {
  return RETRY_POLICIES[category];
}

/** Full jitter backoff: prevents synchronised retry storms across requests. */
export function backoffDelayMs(
  category: ErrorCategory,
  attempt: number,
  random: () => number = Math.random,
): number {
  const policy = RETRY_POLICIES[category];
  if (policy.backoffBaseMs === 0) return 0;

  const ceiling = policy.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  return Math.round(random() * ceiling);
}

/**
 * Maps an HTTP status code to a category. Used by every HTTP-based adapter so
 * classification stays consistent across providers.
 */
export function categoriseHttpStatus(status: number): ErrorCategory {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'PERMISSION';
  if (status === 408) return 'TIMEOUT';
  if (status === 413) return 'CONTEXT_LIMIT';
  if (status === 422) return 'INVALID_REQUEST';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status >= 400) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}

/**
 * Classifies a thrown value that is not an HTTP response — abort signals,
 * socket failures, and similar.
 */
export function categoriseThrown(error: unknown): ErrorCategory {
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();

    if (name === 'aborterror' || message.includes('timeout')) return 'TIMEOUT';
    if (
      name === 'aborterror' ||
      message.includes('aborted') ||
      message.includes('cancelled')
    )
      return 'CLIENT_CANCELLED';
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('socket') ||
      message.includes('network') ||
      message.includes('fetch failed')
    ) {
      return 'NETWORK';
    }
  }
  return 'UNKNOWN';
}

/**
 * Client-safe wording for each category.
 *
 * Provider-supplied text is deliberately not forwarded: it can echo prompt
 * content, internal endpoints or account identifiers.
 */
export const SAFE_ERROR_MESSAGES: Record<ErrorCategory, string> = {
  AUTHENTICATION:
    'The provider connection could not be authenticated. An administrator should re-check its credentials.',
  PERMISSION: 'The provider connection is not permitted to use this model.',
  RATE_LIMIT: 'The provider is rate limiting requests. Please retry shortly.',
  TIMEOUT: 'The provider did not respond within the configured timeout.',
  PROVIDER_UNAVAILABLE: 'The provider is currently unavailable.',
  INVALID_REQUEST: 'The request was rejected as invalid.',
  CONTEXT_LIMIT: 'The request exceeds the context window of every eligible model.',
  SAFETY_REFUSAL: 'The provider declined to answer this request.',
  MALFORMED_RESPONSE: 'The provider returned a response that could not be parsed.',
  NETWORK: 'A network fault prevented the request from completing.',
  QUOTA_EXCEEDED: 'A configured workspace quota has been exceeded.',
  UNKNOWN: 'The request failed for an unexpected reason.',
  CLIENT_CANCELLED: 'The request was cancelled by the client.',
};

export function safeMessageFor(category: ErrorCategory): string {
  return SAFE_ERROR_MESSAGES[category];
}

/** Maps a category to the HTTP status the unified API returns. */
export function httpStatusFor(category: ErrorCategory): number {
  switch (category) {
    case 'AUTHENTICATION':
      return 401;
    case 'PERMISSION':
      return 403;
    case 'INVALID_REQUEST':
    case 'CONTEXT_LIMIT':
      return 400;
    case 'RATE_LIMIT':
    case 'QUOTA_EXCEEDED':
      return 429;
    case 'TIMEOUT':
      return 504;
    case 'PROVIDER_UNAVAILABLE':
      return 502;
    case 'SAFETY_REFUSAL':
      return 200;
    case 'CLIENT_CANCELLED':
      return 499;
    default:
      return 500;
  }
}

export function buildNormalisedError(
  category: ErrorCategory,
  overrides: Partial<NormalisedError> = {},
): NormalisedError {
  const policy = RETRY_POLICIES[category];

  return {
    category,
    message: overrides.message ?? SAFE_ERROR_MESSAGES[category],
    retryable: overrides.retryable ?? policy.retrySameTarget,
    statusCode: overrides.statusCode,
    retryAfterMs: overrides.retryAfterMs,
  };
}

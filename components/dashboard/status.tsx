import { Badge, type BadgeTone } from '@/components/ui/primitives';
import type {
  AttemptStatus,
  ErrorCategory,
  HealthState,
  RequestStatus,
} from '@/lib/database/generated/enums';

/**
 * Status vocabulary.
 *
 * Colour carries meaning consistently across every screen: green succeeded,
 * amber recovered-with-warning, coral failed, neutral not-applicable.
 */

const REQUEST_TONE: Record<RequestStatus, BadgeTone> = {
  SUCCEEDED: 'success',
  FAILED: 'danger',
  REJECTED: 'warning',
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={REQUEST_TONE[status]}>{status.toLowerCase()}</Badge>;
}

const ATTEMPT_TONE: Record<AttemptStatus, BadgeTone> = {
  SUCCEEDED: 'success',
  FAILED: 'danger',
  TIMED_OUT: 'warning',
  SKIPPED: 'neutral',
};

export function AttemptStatusBadge({ status }: { status: AttemptStatus }) {
  return (
    <Badge tone={ATTEMPT_TONE[status]}>{status.toLowerCase().replace('_', ' ')}</Badge>
  );
}

const HEALTH_TONE: Record<HealthState, BadgeTone> = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  UNAVAILABLE: 'danger',
  UNKNOWN: 'neutral',
};

export function HealthBadge({ state }: { state: HealthState }) {
  return <Badge tone={HEALTH_TONE[state]}>{state.toLowerCase()}</Badge>;
}

/** Human-readable label for each failure category. */
export const ERROR_LABELS: Record<ErrorCategory, string> = {
  AUTHENTICATION: 'Authentication',
  PERMISSION: 'Permission',
  RATE_LIMIT: 'Rate limit',
  TIMEOUT: 'Timeout',
  PROVIDER_UNAVAILABLE: 'Provider unavailable',
  INVALID_REQUEST: 'Invalid request',
  CONTEXT_LIMIT: 'Context limit',
  SAFETY_REFUSAL: 'Safety refusal',
  MALFORMED_RESPONSE: 'Malformed response',
  NETWORK: 'Network',
  QUOTA_EXCEEDED: 'Quota exceeded',
  UNKNOWN: 'Unknown',
  CLIENT_CANCELLED: 'Client cancelled',
};

export function ErrorBadge({ category }: { category: ErrorCategory }) {
  // Quota rejections are a deliberate policy outcome, not a provider fault.
  const tone: BadgeTone =
    category === 'QUOTA_EXCEEDED' || category === 'SAFETY_REFUSAL' ? 'warning' : 'danger';

  return <Badge tone={tone}>{ERROR_LABELS[category]}</Badge>;
}

export function EnvironmentBadge({ type }: { type: string }) {
  return (
    <Badge tone={type === 'PRODUCTION' ? 'primary' : 'neutral'}>
      {type === 'PRODUCTION' ? 'production' : 'development'}
    </Badge>
  );
}

export function FallbackBadge({ used }: { used: boolean }) {
  if (!used) return null;
  return <Badge tone="warning">fallback</Badge>;
}

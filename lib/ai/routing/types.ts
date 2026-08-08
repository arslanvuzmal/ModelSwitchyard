import type {
  HealthState,
  ProviderKind,
  RoutingStrategy,
} from '@/lib/database/generated/enums';

import type { Capability } from '../types';

/**
 * Routing types.
 *
 * The design commitment here: a routing decision is a *stored artefact*, not a
 * log line. Every selection produces a RouteExplanation that names the rejected
 * candidates and why, so a decision stays readable after the policy that made it
 * has been edited.
 */

/** A model eligible for selection, with the live signals routing scores on. */
export interface RouteCandidate {
  modelId: string;
  modelLabel: string;
  displayName: string;
  providerKind: ProviderKind;
  connectionId: string;

  priority: number;
  weight: number;

  contextWindow: number;
  capabilities: Capability[];

  inputPricePerMillion: number;
  outputPricePerMillion: number;
  /** Projected cost for this specific request. */
  projectedCost: number;

  healthState: HealthState;
  /** Rolling mean latency over recent successful requests, in ms. */
  recentLatencyMs: number | null;
  /** Rolling success rate in [0,1] over the recent window. */
  recentSuccessRate: number | null;
  recentSampleSize: number;

  isAvailable: boolean;
  isDemoModel: boolean;
}

export type RejectionReason =
  | 'disabled'
  | 'unavailable'
  | 'unhealthy'
  | 'missing_capability'
  | 'context_too_small'
  | 'exceeds_cost_ceiling'
  | 'not_selected'
  | 'provider_excluded';

export interface RejectedCandidate {
  modelId: string;
  modelLabel: string;
  reason: RejectionReason;
  /** Operator-facing sentence explaining the rejection. */
  detail: string;
}

/** Per-factor contribution to a BALANCED score. Values are normalised to [0,1]. */
export interface ScoreComponent {
  factor: string;
  raw: number;
  normalised: number;
  weight: number;
  contribution: number;
}

export interface ScoredCandidate {
  modelId: string;
  modelLabel: string;
  score: number;
  components: ScoreComponent[];
}

/**
 * The persisted record of one routing decision.
 *
 * Stored on Request.routeExplanation as JSONB.
 */
export interface RouteExplanation {
  policyId: string | null;
  policyName: string;
  strategy: RoutingStrategy;

  candidates: Array<{
    modelId: string;
    modelLabel: string;
    providerKind: ProviderKind;
    priority: number;
    weight: number;
    projectedCost: number;
    recentLatencyMs: number | null;
    recentSuccessRate: number | null;
    healthState: HealthState;
  }>;

  rejectedCandidates: RejectedCandidate[];

  selectedCandidate: {
    modelId: string;
    modelLabel: string;
    providerKind: ProviderKind;
  } | null;

  /** Plain-language justification shown directly in the interface. */
  reason: string;

  scoreBreakdown: ScoredCandidate[];

  /** Ordered model ids to try if the selection fails. */
  fallbackOrder: string[];

  evaluatedAt: string;

  // Index signature for JSONB compatibility
  [key: string]: unknown;
}

/** Requirements a candidate must satisfy to remain eligible. */
export interface RouteRequirements {
  capabilities: Capability[];
  minContextWindow: number;
  maxEstimatedCost: number | null;
  /** Restricts selection to one provider; set by MANUAL routing. */
  pinnedModelId?: string;
  excludeProviderKinds?: ProviderKind[];
}

/** Relative importance of each factor in the BALANCED score. */
export interface ScoringWeights {
  health: number;
  successRate: number;
  latency: number;
  cost: number;
  preference: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  health: 0.25,
  successRate: 0.25,
  latency: 0.2,
  cost: 0.2,
  preference: 0.1,
};

export interface RouteInput {
  policyId: string | null;
  policyName: string;
  strategy: RoutingStrategy;
  candidates: RouteCandidate[];
  requirements: RouteRequirements;
  weights: ScoringWeights;
  /** Injected for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

export interface RouteResult {
  selected: RouteCandidate | null;
  /** Ordered remaining candidates to try on failure. */
  fallbackChain: RouteCandidate[];
  explanation: RouteExplanation;
}

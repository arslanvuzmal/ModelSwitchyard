import { prisma } from '@/lib/database/client';
import type { HealthState, ProviderKind } from '@/lib/database/generated/enums';
import type { ModelDefinition } from '@/lib/database/generated/client';

/**
 * Model lifecycle management.
 *
 * Handles provider errors indicating model deprecation/EOL and manages
 * model state transitions automatically.
 */

export type ModelLifecycleState =
  | 'DISCOVERED'
  | 'AVAILABLE'
  | 'VERIFIED'
  | 'DEGRADED'
  | 'DEPRECATED'
  | 'END_OF_LIFE'
  | 'DISABLED';

export interface ModelLifecycleEvent {
  modelId: string;
  previousState: ModelLifecycleState;
  newState: ModelLifecycleState;
  reason: string;
  providerError?: string;
  timestamp: Date;
}

/**
 * Error patterns that indicate model lifecycle events.
 */
const LIFECYCLE_ERROR_PATTERNS: Array<{
  pattern: RegExp;
  targetState: ModelLifecycleState;
  reason: string;
}> = [
  {
    pattern: /model\s+not\s+found|model\s+does\s+not\s+exist|no\s+such\s+model/i,
    targetState: 'END_OF_LIFE',
    reason: 'Provider returned model_not_found',
  },
  {
    pattern: /model\s+has\s+been\s+retired|model\s+is\s+deprecated|deprecated\s+model/i,
    targetState: 'DEPRECATED',
    reason: 'Provider indicated model is deprecated',
  },
  {
    pattern: /model\s+no\s+longer\s+available|model\s+unavailable|model\s+removed/i,
    targetState: 'END_OF_LIFE',
    reason: 'Provider indicated model is no longer available',
  },
  {
    pattern: /410\s+gone/i,
    targetState: 'END_OF_LIFE',
    reason: 'HTTP 410 Gone for model',
  },
  {
    pattern: /quota\s+exceeded|rate\s+limit\s+exceeded|insufficient\s+quota/i,
    targetState: 'DEGRADED',
    reason: 'Provider quota/rate limit exceeded',
  },
];

/**
 * Analyzes a provider error and determines if it indicates a lifecycle transition.
 */
export function analyzeProviderErrorForLifecycle(
  error: unknown,
  modelId: string,
): ModelLifecycleEvent | null {
  const errorMessage = error instanceof Error ? error.message : String(error);

  for (const { pattern, targetState, reason } of LIFECYCLE_ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return {
        modelId,
        previousState: 'AVAILABLE', // Will be resolved from DB
        newState: targetState,
        reason,
        providerError: errorMessage,
        timestamp: new Date(),
      };
    }
  }

  return null;
}

/**
 * Transitions a model to a new lifecycle state.
 * Returns the updated model definition.
 */
export async function transitionModelLifecycle(
  modelId: string,
  newState: ModelLifecycleState,
  reason: string,
): Promise<{
  success: boolean;
  previousState: ModelLifecycleState;
  model?: ModelDefinition;
}> {
  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
  });

  if (!model) {
    return { success: false, previousState: 'AVAILABLE' };
  }

  const previousState = mapHealthStateToLifecycle(model.healthState);

  if (previousState === newState) {
    return { success: true, previousState, model };
  }

  const newHealthState = mapLifecycleToHealthState(newState);
  const newAvailable = newState !== 'END_OF_LIFE' && newState !== 'DISABLED';

  const updated = await prisma.modelDefinition.update({
    where: { id: modelId },
    data: {
      healthState: newHealthState,
      isAvailable: newAvailable,
    },
  });

  // Log audit event
  await prisma.auditLog.create({
    data: {
      workspaceId: model.workspaceId,
      actorLabel: 'system',
      action: 'model.lifecycle.transition',
      resourceType: 'model',
      resourceId: modelId,
      previousState: { healthState: model.healthState, isAvailable: model.isAvailable },
      newState: { healthState: newHealthState, isAvailable: newAvailable, reason },
    },
  });

  return { success: true, previousState, model: updated };
}

/**
 * Handles a provider error that may indicate model EOL.
 * Called from the fallback executor when a model-related error occurs.
 */
export async function handlePotentialModelEOL(
  providerKind: ProviderKind,
  modelLabel: string,
  error: unknown,
): Promise<void> {
  // Find the model definition by provider model ID
  const model = await prisma.modelDefinition.findFirst({
    where: {
      modelId: modelLabel,
      connection: { kind: providerKind },
    },
  });

  if (!model) return;

  const event = analyzeProviderErrorForLifecycle(error, model.id);
  if (!event) return;

  await transitionModelLifecycle(model.id, event.newState, event.reason);
}

/**
 * Maps HealthState enum to ModelLifecycleState.
 */
function mapHealthStateToLifecycle(healthState: HealthState): ModelLifecycleState {
  switch (healthState) {
    case 'HEALTHY':
      return 'AVAILABLE';
    case 'DEGRADED':
      return 'DEGRADED';
    case 'UNAVAILABLE':
      return 'END_OF_LIFE';
    case 'UNKNOWN':
    default:
      return 'DISCOVERED';
  }
}

/**
 * Maps ModelLifecycleState to HealthState enum.
 */
function mapLifecycleToHealthState(lifecycle: ModelLifecycleState): HealthState {
  switch (lifecycle) {
    case 'AVAILABLE':
    case 'VERIFIED':
      return 'HEALTHY';
    case 'DEGRADED':
      return 'DEGRADED';
    case 'DEPRECATED':
    case 'END_OF_LIFE':
    case 'DISABLED':
      return 'UNAVAILABLE';
    case 'DISCOVERED':
    default:
      return 'UNKNOWN';
  }
}

/**
 * Gets all models in a workspace that need attention (EOL, deprecated, etc.).
 */
export async function getModelsNeedingAttention(workspaceId: string): Promise<
  Array<{
    modelId: string;
    modelLabel: string;
    state: ModelLifecycleState;
    reason: string;
  }>
> {
  const models = await prisma.modelDefinition.findMany({
    where: {
      workspaceId,
      OR: [
        { healthState: 'UNAVAILABLE' },
        { healthState: 'DEGRADED', isAvailable: false },
      ],
    },
    include: { connection: true },
  });

  return models.map((model) => ({
    modelId: model.id,
    modelLabel: model.modelId,
    state: mapHealthStateToLifecycle(model.healthState),
    reason: model.isAvailable ? 'Degraded' : 'Marked unavailable',
  }));
}

/**
 * Marks a model as deprecated with a replacement recommendation.
 */
export async function deprecateModel(
  modelId: string,
  replacementModelId?: string,
  reason: string = 'Model deprecated by provider',
): Promise<void> {
  await transitionModelLifecycle(modelId, 'DEPRECATED', reason);

  if (replacementModelId) {
    await prisma.auditLog.create({
      data: {
        workspaceId: (
          await prisma.modelDefinition.findUniqueOrThrow({ where: { id: modelId } })
        ).workspaceId,
        actorLabel: 'system',
        action: 'model.deprecation.replacement',
        resourceType: 'model',
        resourceId: modelId,
        newState: { replacementModelId, reason },
      },
    });
  }
}

/**
 * Schedules a model for end-of-life (graceful shutdown).
 */
export async function scheduleModelEOL(
  modelId: string,
  eolDate: Date,
  reason: string = 'Model end-of-life scheduled',
): Promise<void> {
  await transitionModelLifecycle(modelId, 'END_OF_LIFE', reason);

  // Could schedule a job to notify admins before EOL date
  await prisma.auditLog.create({
    data: {
      workspaceId: (
        await prisma.modelDefinition.findUniqueOrThrow({ where: { id: modelId } })
      ).workspaceId,
      actorLabel: 'system',
      action: 'model.eol.scheduled',
      resourceType: 'model',
      resourceId: modelId,
      newState: { eolDate: eolDate.toISOString(), reason },
    },
  });
}

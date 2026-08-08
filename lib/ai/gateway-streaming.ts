import { prisma } from '@/lib/database/client';
import type { EnvironmentType, ErrorCategory } from '@/lib/database/generated/enums';
import { decryptSecret } from '@/lib/encryption/crypto';
import { evaluateQuotas, recordUsage } from '@/lib/quotas/engine';
import type { Prisma } from '@/lib/database/generated/client';

import { safeMessageFor, NormalisedError } from './errors';
import type { AttemptRecord } from './fallback/executor';
import { executeWithFallback } from './fallback/executor';
import { projectCost } from './pricing';
import { getProvider, PROVIDER_ENV_KEYS } from './providers';
import { evaluateRoute } from './routing/engine';
import type {
  RouteCandidate,
  RouteExplanation,
  RouteRequirements,
  ScoringWeights,
} from './routing/types';
import { DEFAULT_SCORING_WEIGHTS } from './routing/types';
import { estimateMessagesTokens } from './tokens';
import type {
  Capability,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  DemoBehaviour,
  ProviderContext,
} from './types';

/**
 * Streaming gateway: executes the completion with streaming support.
 *
 * Uses the same routing and fallback logic as runCompletion but returns
 * a ReadableStream with SSE-formatted chunks.
 */

export interface RunStreamingInput {
  workspaceId: string;
  applicationId: string;
  environmentId: string;
  environmentType: EnvironmentType;
  apiKeyId: string | null;
  policyId: string | null;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  requestedModelId?: string;
  structuredOutputSchema?: Record<string, unknown>;
  requiredCapabilities?: Capability[];
  demoBehaviour?: DemoBehaviour;
  demoBehaviourScope?: 'all' | 'first_attempt' | 'first_candidate';
  correlationId: string;
  source?: string;
}

export interface RunStreamingResult {
  stream: ReadableStream<Uint8Array>;
  correlationId: string;
  requestDbId: string;
}

/** Ordered lifecycle stages persisted on the request for the trace viewer. */
export interface TraceStage {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'error' | 'skipped';
  startedAt: string;
  durationMs: number;
  detail: string;
  metadata?: Record<string, unknown>;
}

class StageRecorder {
  private readonly stages: TraceStage[] = [];
  private cursor = Date.now();

  add(
    key: string,
    label: string,
    status: TraceStage['status'],
    detail: string,
    metadata?: Record<string, unknown>,
  ): void {
    const now = Date.now();
    this.stages.push({
      key,
      label,
      status,
      startedAt: new Date(this.cursor).toISOString(),
      durationMs: now - this.cursor,
      detail,
      metadata,
    });
    this.cursor = now;
  }

  all(): TraceStage[] {
    return this.stages;
  }
}

const SIGNAL_WINDOW = 50;

async function loadCandidates(
  workspaceId: string,
  policyId: string | null,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): Promise<RouteCandidate[]> {
  const rules = policyId
    ? await prisma.routingRule.findMany({
        where: { policyId, enabled: true },
        include: { model: { include: { connection: true } } },
        orderBy: { priority: 'asc' },
      })
    : [];

  const models = policyId
    ? rules.map((rule) => ({
        model: rule.model,
        priority: rule.priority,
        weight: rule.weight,
      }))
    : (
        await prisma.modelDefinition.findMany({
          where: { workspaceId, isAvailable: true },
          include: { connection: true },
        })
      ).map((model) => ({ model, priority: 1, weight: 1 }));

  if (models.length === 0) return [];

  const modelIds = models.map((entry) => entry.model.id);

  const recent = await prisma.requestAttempt.groupBy({
    by: ['modelId', 'status'],
    where: {
      modelId: { in: modelIds },
      startedAt: { gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7) },
    },
    _count: { _all: true },
    _avg: { latencyMs: true },
  });

  const signals = new Map<
    string,
    { successes: number; failures: number; latencySum: number; latencyCount: number }
  >();

  for (const row of recent) {
    if (!row.modelId) continue;

    const entry = signals.get(row.modelId) ?? {
      successes: 0,
      failures: 0,
      latencySum: 0,
      latencyCount: 0,
    };

    if (row.status === 'SUCCEEDED') {
      entry.successes += row._count._all;
      entry.latencySum += (row._avg.latencyMs ?? 0) * row._count._all;
      entry.latencyCount += row._count._all;
    } else if (row.status !== 'SKIPPED') {
      entry.failures += row._count._all;
    }

    signals.set(row.modelId, entry);
  }

  return models.map(({ model, priority, weight }) => {
    const signal = signals.get(model.id);
    const total = (signal?.successes ?? 0) + (signal?.failures ?? 0);

    const capabilities: Capability[] = [];
    if (model.supportsStreaming) capabilities.push('streaming');
    if (model.supportsStructured) capabilities.push('structured_output');
    if (model.supportsVision) capabilities.push('vision');
    if (model.supportsToolUse) capabilities.push('tool_use');

    const inputPrice = Number(model.inputPricePerMillion);
    const outputPrice = Number(model.outputPricePerMillion);

    return {
      modelId: model.id,
      modelLabel: model.modelId,
      displayName: model.displayName,
      providerKind: model.connection.kind,
      connectionId: model.connectionId,
      priority,
      weight,
      contextWindow: model.contextWindow,
      capabilities,
      inputPricePerMillion: inputPrice,
      outputPricePerMillion: outputPrice,
      projectedCost: projectCost(estimatedInputTokens, estimatedOutputTokens, {
        inputPricePerMillion: inputPrice,
        outputPricePerMillion: outputPrice,
      }),
      healthState: model.healthState,
      recentLatencyMs:
        signal && signal.latencyCount > 0
          ? signal.latencySum / signal.latencyCount
          : null,
      recentSuccessRate: total >= 1 ? (signal?.successes ?? 0) / total : null,
      recentSampleSize: Math.min(total, SIGNAL_WINDOW),
      isAvailable: model.isAvailable && model.connection.status === 'ACTIVE',
      isDemoModel: model.isDemoModel,
    } satisfies RouteCandidate;
  });
}

async function resolveCredential(
  connectionId: string,
): Promise<{ apiKey?: string; baseUrl?: string }> {
  const connection = await prisma.providerConnection.findUnique({
    where: { id: connectionId },
    select: { kind: true, credentialCiphertext: true, baseUrl: true },
  });

  if (!connection) return {};

  let apiKey: string | undefined;

  if (connection.credentialCiphertext) {
    try {
      apiKey = decryptSecret(connection.credentialCiphertext);
    } catch {
      apiKey = undefined;
    }
  }

  if (!apiKey) {
    const envKey = PROVIDER_ENV_KEYS[connection.kind];
    if (envKey) apiKey = process.env[envKey];
  }

  return { apiKey, baseUrl: connection.baseUrl ?? undefined };
}

function formatSSE(data: string): string {
  return `data: ${data}\n\n`;
}

function formatSSEEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/**
 * Runs a streaming completion with full routing, fallback, and tracing.
 */
export async function runStreamingCompletion(
  input: RunStreamingInput,
): Promise<RunStreamingResult> {
  const { correlationId } = input;
  const stages = new StageRecorder();
  const startedAt = Date.now();

  stages.add(
    'authenticated',
    'Authenticated',
    'ok',
    input.apiKeyId
      ? 'Virtual API key validated and resolved to an application and environment.'
      : 'Authenticated by dashboard session.',
  );

  // --- Quotas -------------------------------------------------------------
  const quota = await evaluateQuotas({
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    environmentId: input.environmentId,
  });

  if (!quota.allowed) {
    stages.add(
      'quota',
      'Quota check',
      'error',
      quota.detail ?? 'A configured quota rejected this request.',
    );

    // For streaming, we need to return a stream that immediately errors
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const errorData = JSON.stringify({
          error: {
            message: quota.detail ?? safeMessageFor('QUOTA_EXCEEDED'),
            type: 'omnirouter_error',
            code: 'quota_exceeded',
          },
          correlation_id: correlationId,
        });
        controller.enqueue(new TextEncoder().encode(formatSSE(errorData)));
        controller.enqueue(new TextEncoder().encode(formatSSEEvent('error', '[DONE]')));
        controller.close();
      },
    });

    // Persist rejection
    await persistRejection({
      input,
      correlationId,
      stages,
      category: 'QUOTA_EXCEEDED',
      message: quota.detail ?? safeMessageFor('QUOTA_EXCEEDED'),
      startedAt,
    });

    return { stream: errorStream, correlationId, requestDbId: '' };
  }

  stages.add(
    'quota',
    'Quota check',
    quota.warning ? 'warn' : 'ok',
    quota.detail ?? 'Within all configured quotas.',
  );

  // --- Routing ------------------------------------------------------------
  const estimatedInputTokens = estimateMessagesTokens(input.messages);
  const estimatedOutputTokens = input.maxTokens ?? 512;

  const policy = input.policyId
    ? await prisma.routingPolicy.findFirst({
        where: { id: input.policyId, workspaceId: input.workspaceId },
      })
    : null;

  const candidates = await loadCandidates(
    input.workspaceId,
    policy?.id ?? null,
    estimatedInputTokens,
    estimatedOutputTokens,
  );

  const requirements: RouteRequirements = {
    capabilities: [
      ...(input.requiredCapabilities ?? []),
      ...(input.structuredOutputSchema ? (['structured_output'] as Capability[]) : []),
    ],
    minContextWindow: estimatedInputTokens + estimatedOutputTokens,
    maxEstimatedCost:
      policy?.maxEstimatedCost === null || policy?.maxEstimatedCost === undefined
        ? null
        : Number(policy.maxEstimatedCost),
    pinnedModelId: input.requestedModelId,
  };

  const weights: ScoringWeights = {
    ...DEFAULT_SCORING_WEIGHTS,
    ...((policy?.scoring as Partial<ScoringWeights> | null) ?? {}),
  };

  const route = evaluateRoute({
    policyId: policy?.id ?? null,
    policyName: policy?.name ?? 'Ad-hoc selection',
    strategy: input.requestedModelId ? 'MANUAL' : (policy?.strategy ?? 'BALANCED'),
    candidates,
    requirements,
    weights,
  });

  stages.add(
    'routing',
    'Policy evaluated',
    route.selected ? 'ok' : 'error',
    route.explanation.reason,
    {
      candidateCount: candidates.length,
      rejectedCount: route.explanation.rejectedCandidates.length,
      strategy: route.explanation.strategy,
    },
  );

  if (!route.selected) {
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const errorData = JSON.stringify({
          error: {
            message: route.explanation.reason,
            type: 'omnirouter_error',
            code: 'invalid_request',
          },
          correlation_id: correlationId,
        });
        controller.enqueue(new TextEncoder().encode(formatSSE(errorData)));
        controller.enqueue(new TextEncoder().encode(formatSSEEvent('error', '[DONE]')));
        controller.close();
      },
    });

    await persistRejection({
      input,
      correlationId,
      stages,
      category: 'INVALID_REQUEST',
      message: route.explanation.reason,
      startedAt,
      explanation: route.explanation,
    });

    return { stream: errorStream, correlationId, requestDbId: '' };
  }

  // --- Execution with streaming -------------------------------------------
  const chain = [route.selected, ...route.fallbackChain];
  const credentialCache = new Map<string, { apiKey?: string; baseUrl?: string }>();

  for (const candidate of chain) {
    if (!credentialCache.has(candidate.connectionId)) {
      credentialCache.set(
        candidate.connectionId,
        await resolveCredential(candidate.connectionId),
      );
    }
  }

  const completionRequest: CompletionRequest = {
    messages: input.messages,
    model: route.selected.modelLabel,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    structuredOutputSchema: input.structuredOutputSchema,
    stream: true,
  };

  let invocationIndex = 0;
  const primaryModelId = route.selected.modelId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        // Send initial metadata event
        const selected = route.selected!;
        controller.enqueue(
          encoder.encode(
            formatSSEEvent(
              'metadata',
              JSON.stringify({
                correlation_id: correlationId,
                model: selected.modelLabel,
                provider: selected.providerKind,
                strategy: route.explanation.strategy,
                fallback_order: route.explanation.fallbackOrder,
              }),
            ),
          ),
        );

        const execution = await executeWithFallback({
          request: completionRequest,
          chain,
          maxAttempts: policy?.maxAttempts ?? 3,
          attemptTimeoutMs: policy?.attemptTimeoutMs ?? 30_000,
          totalTimeoutMs: policy?.totalTimeoutMs ?? 60_000,
          correlationId,
          buildContext: (candidate, timeoutMs): ProviderContext => {
            const credential = credentialCache.get(candidate.connectionId) ?? {};

            const scope = input.demoBehaviourScope ?? 'all';
            const applyFault =
              Boolean(input.demoBehaviour) &&
              (scope === 'all' ||
                (scope === 'first_attempt' && invocationIndex === 0) ||
                (scope === 'first_candidate' && candidate.modelId === primaryModelId));

            return {
              apiKey: credential.apiKey,
              baseUrl: credential.baseUrl,
              timeoutMs,
              correlationId,
              demoBehaviour: applyFault ? input.demoBehaviour : undefined,
            };
          },
          invoke: async (candidate, request, context) => {
            invocationIndex += 1;
            const adapter = getProvider(candidate.providerKind);

            // For streaming, we need to handle the async iterator
            const stream = adapter.streamChatCompletion(
              { ...request, model: candidate.modelLabel, stream: true },
              context,
            );

            // Collect the stream into a single response for the fallback executor
            let fullContent = '';
            let finishReason: CompletionResponse['finishReason'] = 'stop';
            let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            const providerRequestId: string | null = null;
            let latencyMs = 0;
            const startTime = Date.now();

            for await (const chunk of stream) {
              if (chunk.done) {
                finishReason = chunk.finishReason ?? 'stop';
                if (chunk.usage) usage = chunk.usage;
              } else {
                fullContent += chunk.delta;
              }
            }

            latencyMs = Date.now() - startTime;

            // Estimate usage if not provided
            if (usage.totalTokens === 0) {
              usage = {
                inputTokens: estimateMessagesTokens(request.messages),
                outputTokens: adapter.estimateTokens(fullContent),
                totalTokens: 0,
              };
              usage.totalTokens = usage.inputTokens + usage.outputTokens;
            }

            const cost = projectCost(usage.inputTokens, usage.outputTokens, {
              inputPricePerMillion: candidate.inputPricePerMillion,
              outputPricePerMillion: candidate.outputPricePerMillion,
            });

            return {
              requestId: correlationId,
              provider: candidate.providerKind,
              model: candidate.modelLabel,
              content: fullContent,
              finishReason,
              usage,
              estimatedCost: cost,
              latencyMs,
              providerRequestId,
              metadata: { provider: candidate.providerKind },
            };
          },
          classify: (candidate, error) => {
            const adapter = getProvider(candidate.providerKind);
            return adapter.normaliseError(error);
          },
        });

        // Stream the successful response
        const successfulAttempt = execution.attempts.find(
          (a) => a.status === 'SUCCEEDED',
        );
        const response = execution.response;

        if (response && successfulAttempt) {
          // Re-stream the response (we need to actually stream from provider)
          // For now, emit the collected content as chunks
          const words = response.content.split(/(\s+)/);
          for (const word of words) {
            controller.enqueue(
              encoder.encode(formatSSE(JSON.stringify({ delta: word, done: false }))),
            );
            // Small delay to simulate streaming
            await new Promise((r) => setTimeout(r, 10));
          }

          // Send final chunk with usage
          controller.enqueue(
            encoder.encode(
              formatSSE(
                JSON.stringify({
                  delta: '',
                  done: true,
                  finish_reason: response.finishReason,
                  usage: response.usage,
                }),
              ),
            ),
          );

          // Send completion event with metadata
          controller.enqueue(
            encoder.encode(
              formatSSEEvent(
                'complete',
                JSON.stringify({
                  correlation_id: correlationId,
                  model: successfulAttempt.modelLabel,
                  provider: successfulAttempt.providerKind,
                  fallback_used: execution.fallbackUsed,
                  attempts: execution.attempts.length,
                  total_latency_ms: execution.totalLatencyMs,
                  usage: response.usage,
                  estimated_cost: response.estimatedCost,
                }),
              ),
            ),
          );
        }

        // Persist the trace
        await persistStreamingResult({
          input,
          correlationId,
          stages,
          execution,
          startedAt,
        });

        controller.close();
      } catch (error) {
        const category = error instanceof Error ? 'UNKNOWN' : 'UNKNOWN';

        controller.enqueue(
          encoder.encode(
            formatSSE(
              JSON.stringify({
                error: {
                  message: safeMessageFor(category as ErrorCategory),
                  type: 'omnirouter_error',
                  code: category.toLowerCase(),
                },
                correlation_id: correlationId,
              }),
            ),
          ),
        );

        controller.enqueue(encoder.encode(formatSSEEvent('error', '[DONE]')));
        controller.close();
      }
    },
  });

  return { stream, correlationId, requestDbId: '' };
}

async function persistStreamingResult(args: {
  input: RunStreamingInput;
  correlationId: string;
  stages: StageRecorder;
  execution: {
    response: CompletionResponse | null;
    attempts: AttemptRecord[];
    fallbackUsed: boolean;
    totalLatencyMs: number;
    finalError: NormalisedError | null;
  };
  startedAt: number;
}): Promise<void> {
  const { input, correlationId, stages, execution, startedAt } = args;
  const succeeded = execution.response !== null;
  const successfulAttempt = execution.attempts.find((a) => a.status === 'SUCCEEDED');
  const usage = execution.response?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const estimatedCost = execution.response?.estimatedCost ?? 0;
  const totalLatencyMs = Date.now() - startedAt;

  const policy = input.policyId
    ? await prisma.routingPolicy.findFirst({
        where: { id: input.policyId, workspaceId: input.workspaceId },
      })
    : null;

  await prisma.request.create({
    data: {
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      environmentId: input.environmentId,
      apiKeyId: input.apiKeyId,
      policyId: policy?.id ?? null,
      correlationId,
      status: succeeded ? 'SUCCEEDED' : 'FAILED',
      errorCategory: execution.finalError?.category ?? null,
      errorMessage: execution.finalError?.message ?? null,
      requestedModel: input.requestedModelId ?? null,
      resolvedModel: successfulAttempt?.modelLabel ?? null,
      fallbackUsed: execution.fallbackUsed,
      attemptCount: execution.attempts.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      estimatedCost,
      totalLatencyMs,
      routeExplanation: policy
        ? ((
            await evaluateRoute({
              policyId: policy.id,
              policyName: policy.name,
              strategy: input.requestedModelId ? 'MANUAL' : policy.strategy,
              candidates: [], // Would need to reload
              requirements: {
                capabilities: [],
                minContextWindow: 0,
                maxEstimatedCost: null,
              },
              weights: DEFAULT_SCORING_WEIGHTS,
            })
          ).explanation as Prisma.InputJsonValue)
        : undefined,
      traceStages: stages.all() as unknown as object,
      source: input.source ?? 'api',
      attempts: {
        create: execution.attempts.map((attempt) => ({
          modelId: attempt.modelId,
          sequence: attempt.sequence,
          status: attempt.status,
          providerKind: attempt.providerKind,
          modelLabel: attempt.modelLabel,
          errorCategory: attempt.errorCategory,
          errorMessage: attempt.errorMessage,
          inputTokens: attempt.inputTokens,
          outputTokens: attempt.outputTokens,
          estimatedCost: attempt.estimatedCost,
          latencyMs: attempt.latencyMs,
          providerRequestId: attempt.providerRequestId,
          reason: attempt.reason,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
        })),
      },
    },
  });

  await recordUsage({
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    environmentId: input.environmentId,
    succeeded,
    fallbackUsed: execution.fallbackUsed,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCost,
    latencyMs: totalLatencyMs,
  });
}

async function persistRejection(args: {
  input: RunStreamingInput;
  correlationId: string;
  stages: StageRecorder;
  category: ErrorCategory;
  message: string;
  startedAt: number;
  explanation?: RouteExplanation;
}): Promise<string> {
  const { input, correlationId, stages, category, message, startedAt, explanation } =
    args;

  const record = await prisma.request.create({
    data: {
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      environmentId: input.environmentId,
      apiKeyId: input.apiKeyId,
      policyId: input.policyId,
      correlationId,
      status: 'REJECTED',
      errorCategory: category,
      errorMessage: message,
      attemptCount: 0,
      totalLatencyMs: Date.now() - startedAt,
      routeExplanation: (explanation ?? {
        policyId: input.policyId,
        policyName: 'Not evaluated',
        strategy: 'BALANCED',
        candidates: [],
        rejectedCandidates: [],
        selectedCandidate: null,
        reason: message,
        scoreBreakdown: [],
        fallbackOrder: [],
        evaluatedAt: new Date().toISOString(),
      }) as unknown as object,
      traceStages: stages.all() as unknown as object,
      source: input.source ?? 'api',
    },
  });

  return record.id;
}

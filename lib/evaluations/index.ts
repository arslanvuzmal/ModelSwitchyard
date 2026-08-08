import { prisma } from '@/lib/database/client';
import type { Capability } from '@/lib/ai/types';
import type { Prisma } from '@/lib/database/generated/client';

/**
 * Evaluation system for quality-aware routing.
 *
 * Stores evaluation suite results and provides quality scores
 * for routing decisions.
 */

export interface EvaluationSuite {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  capability: Capability;
  testCases: EvaluationCase[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluationCase {
  id: string;
  input: string;
  expectedCriteria: string; // JSON schema or text description
  capabilities: Capability[];
  metadata: Record<string, unknown>;
}

export interface EvaluationRun {
  id: string;
  suiteId: string;
  modelDefinitionId: string;
  providerKind: string;
  promptVersionId?: string;
  policyId?: string;
  score: number; // 0-1
  latencyMs: number;
  tokens: number;
  cost: number;
  status: 'PASSED' | 'FAILED' | 'ERROR';
  errorMessage?: string;
  completedAt: Date;
}

export interface ModelQualityScore {
  modelDefinitionId: string;
  evaluationSuiteId: string;
  capability: Capability;
  score: number; // 0-1
  sampleSize: number;
  evaluatedAt: Date;
  evaluationVersion: string;
}

/**
 * Creates an evaluation suite.
 */
export async function createEvaluationSuite(input: {
  workspaceId: string;
  name: string;
  description: string;
  capability: Capability;
  testCases: EvaluationCase[];
}): Promise<EvaluationSuite> {
  const created = await prisma.evaluationSuite.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      capability: input.capability,
      testCases: input.testCases as unknown as Prisma.InputJsonValue,
    },
  });

  const result: EvaluationSuite = {
    ...created,
    capability: created.capability as Capability,
    testCases: (created.testCases ?? []) as unknown as EvaluationCase[],
  };
  return result;
}

/**
 * Runs an evaluation suite against a model.
 * This would typically be a background job.
 */
export async function runEvaluation(input: {
  suiteId: string;
  modelDefinitionId: string;
  providerKind: string;
  promptVersionId?: string;
  policyId?: string;
}): Promise<EvaluationRun> {
  // This is a placeholder - actual implementation would:
  // 1. Load the suite and test cases
  // 2. Run each test case through the model
  // 3. Score responses against expected criteria
  // 4. Aggregate scores
  // 5. Store results

  const suite = await prisma.evaluationSuite.findUniqueOrThrow({
    where: { id: input.suiteId },
  });

  // Placeholder: simulate evaluation
  const score = 0.75 + Math.random() * 0.2; // Random score for demo
  const latencyMs = 500 + Math.random() * 1000;
  const tokens = 100 + Math.floor(Math.random() * 500);
  const cost = tokens * 0.00001;

  const run = await prisma.evaluationRun.create({
    data: {
      suiteId: input.suiteId,
      modelDefinitionId: input.modelDefinitionId,
      providerKind: input.providerKind,
      promptVersionId: input.promptVersionId ?? undefined,
      policyId: input.policyId ?? undefined,
      score,
      latencyMs,
      tokens,
      cost,
      status: score > 0.5 ? 'PASSED' : 'FAILED',
      completedAt: new Date(),
    },
  });

  // Update model quality score
  await updateModelQualityScore({
    modelDefinitionId: input.modelDefinitionId,
    evaluationSuiteId: input.suiteId,
    capability: suite.capability as Capability,
    score,
    evaluationVersion: '1.0',
  });

  return {
    ...run,
    promptVersionId: run.promptVersionId ?? undefined,
    policyId: run.policyId ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
  };
}

async function updateModelQualityScore(input: {
  modelDefinitionId: string;
  evaluationSuiteId: string;
  capability: Capability;
  score: number;
  evaluationVersion: string;
}): Promise<void> {
  // Aggregate scores across runs
  const runs = await prisma.evaluationRun.findMany({
    where: {
      modelDefinitionId: input.modelDefinitionId,
      suiteId: input.evaluationSuiteId,
      status: 'PASSED',
    },
  });

  const avgScore = runs.reduce((sum, r) => sum + r.score, 0) / runs.length;

  await prisma.modelQualityScore.upsert({
    where: {
      modelDefinitionId_evaluationSuiteId: {
        modelDefinitionId: input.modelDefinitionId,
        evaluationSuiteId: input.evaluationSuiteId,
      },
    },
    create: {
      modelDefinitionId: input.modelDefinitionId,
      evaluationSuiteId: input.evaluationSuiteId,
      capability: input.capability,
      score: avgScore,
      sampleSize: runs.length,
      evaluatedAt: new Date(),
      evaluationVersion: input.evaluationVersion,
    },
    update: {
      score: avgScore,
      sampleSize: runs.length,
      evaluatedAt: new Date(),
      evaluationVersion: input.evaluationVersion,
    },
  });
}

/**
 * Gets the quality score for a model for a specific capability.
 */
export async function getModelQualityScore(
  modelDefinitionId: string,
  capability: Capability,
): Promise<ModelQualityScore | null> {
  const score = await prisma.modelQualityScore.findFirst({
    where: {
      modelDefinitionId,
      capability: capability as string,
    },
    orderBy: { evaluatedAt: 'desc' },
  });

  if (!score) return null;

  return {
    ...score,
    capability: score.capability as Capability,
  };
}

/**
 * Gets quality scores for multiple models.
 */
export async function getModelsQualityScores(
  modelIds: string[],
  capability?: Capability,
): Promise<Map<string, ModelQualityScore>> {
  const scores = await prisma.modelQualityScore.findMany({
    where: {
      modelDefinitionId: { in: modelIds },
      ...(capability ? { capability: capability as string } : {}),
    },
    orderBy: { evaluatedAt: 'desc' },
  });

  const result = new Map<string, ModelQualityScore>();
  for (const score of scores) {
    if (!result.has(score.modelDefinitionId)) {
      result.set(score.modelDefinitionId, {
        ...score,
        capability: score.capability as Capability,
      });
    }
  }

  return result;
}

/**
 * Checks if a model meets a quality floor for a capability.
 */
export async function meetsQualityFloor(
  modelId: string,
  capability: Capability,
  floor: number,
): Promise<boolean> {
  const score = await getModelQualityScore(modelId, capability);
  if (!score) return false; // No evaluation data = doesn't meet floor
  return score.score >= floor && score.sampleSize >= 10; // Require minimum samples
}

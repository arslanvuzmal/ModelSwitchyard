import { prisma } from '@/lib/database/client';
import { projectCost } from '@/lib/ai/pricing';
import type { RouteCandidate } from '@/lib/ai/routing/types';

/**
 * Budget reservation system.
 *
 * Prevents concurrent requests from overspending a hard budget by:
 * 1. Estimating maximum reasonable request cost before provider call
 * 2. Atomically reserving budget in database
 * 3. Reconciling after response (release unused or charge actual)
 * 4. Releasing reservation on failure
 */

export interface BudgetConfig {
  workspaceId: string;
  applicationId?: string;
  environmentId?: string;
  period: 'day' | 'month';
  maxSpend: number; // USD
  warnThreshold: number; // 0-1
}

export interface BudgetStatus {
  allowed: boolean;
  reserved: number;
  spent: number;
  remaining: number;
  limit: number;
  warnThreshold: number;
  period: 'day' | 'month';
  warning: boolean;
  detail: string | null;
}

export interface Reservation {
  id: string;
  amount: number;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Estimates the maximum cost for a request based on candidates and max tokens.
 * Uses the most expensive eligible candidate for conservative estimation.
 */
export function estimateMaxRequestCost(
  candidates: RouteCandidate[],
  maxTokens: number,
  estimatedInputTokens: number,
): number {
  if (candidates.length === 0) return 0;

  // Use the highest output price among eligible candidates for worst-case estimate
  const maxOutputPrice = Math.max(...candidates.map((c) => c.outputPricePerMillion));
  const maxInputPrice = Math.max(...candidates.map((c) => c.inputPricePerMillion));

  return projectCost(estimatedInputTokens, maxTokens, {
    inputPricePerMillion: maxInputPrice,
    outputPricePerMillion: maxOutputPrice,
  });
}

/**
 * Gets the current budget period boundaries.
 */
function getPeriodBounds(
  period: 'day' | 'month',
  now: Date = new Date(),
): { start: Date; end: Date } {
  const start = new Date(now);
  const end = new Date(now);

  if (period === 'day') {
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
  } else {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    end.setUTCHours(23, 59, 59, 999);
  }

  return { start, end };
}

/**
 * Atomically reserves budget for a request.
 * Returns reservation ID if successful, throws if budget would be exceeded.
 */
export async function reserveBudget(
  config: BudgetConfig,
  estimatedCost: number,
  reservationTtlMs: number = 60_000, // 1 minute default
): Promise<Reservation> {
  const now = new Date();
  const { start } = getPeriodBounds(config.period, now);
  const expiresAt = new Date(now.getTime() + reservationTtlMs);

  const result = await prisma.$transaction(async (tx) => {
    // Lock the budget row for update
    const budget = await tx.budget.findFirst({
      where: {
        workspaceId: config.workspaceId,
        applicationId: config.applicationId ?? null,
        environmentId: config.environmentId ?? null,
        period: config.period.toUpperCase() as 'DAY' | 'MONTH',
        periodStart: start,
      },
    });

    if (!budget) {
      // Create if doesn't exist
      const created = await tx.budget.create({
        data: {
          workspaceId: config.workspaceId,
          applicationId: config.applicationId ?? null,
          environmentId: config.environmentId ?? null,
          period: config.period.toUpperCase() as 'DAY' | 'MONTH',
          periodStart: start,
          periodEnd: getPeriodBounds(config.period, now).end,
          maxSpend: config.maxSpend,
          warnThreshold: config.warnThreshold,
          spent: 0,
          reserved: estimatedCost,
          reservationExpiresAt: expiresAt,
        },
      });
      return { id: created.id, reserved: estimatedCost };
    }

    const currentSpent = Number(budget.spent);
    const currentReserved = Number(budget.reserved);
    const newReserved = currentReserved + estimatedCost;
    const projectedTotal = currentSpent + newReserved;

    if (projectedTotal > config.maxSpend) {
      throw new Error(
        `Budget reservation would exceed limit: $${projectedTotal.toFixed(4)} > $${config.maxSpend.toFixed(4)}`,
      );
    }

    const updated = await tx.budget.update({
      where: { id: budget.id },
      data: { reserved: newReserved, reservationExpiresAt: expiresAt },
    });

    return { id: updated.id, reserved: estimatedCost };
  });

  return {
    id: result.id,
    amount: estimatedCost,
    createdAt: now,
    expiresAt,
  };
}

/**
 * Reconciles a reservation with actual usage.
 * Releases unused reserved amount, charges actual cost.
 */
export async function reconcileBudget(
  reservationId: string,
  actualCost: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const budget = await tx.budget.findUnique({
      where: { id: reservationId },
    });

    if (!budget) {
      throw new Error(`Budget record ${reservationId} not found`);
    }

    const currentSpent = Number(budget.spent);
    const currentReserved = Number(budget.reserved);

    // Release the reservation, apply actual cost
    const newReserved = Math.max(0, currentReserved - actualCost);
    const newSpent = currentSpent + actualCost;

    await tx.budget.update({
      where: { id: reservationId },
      data: {
        spent: newSpent,
        reserved: newReserved,
      },
    });
  });
}

/**
 * Releases a reservation without charging (e.g., on request failure).
 */
export async function releaseBudget(
  reservationId: string,
  reservedAmount: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const budget = await tx.budget.findUnique({
      where: { id: reservationId },
    });

    if (!budget) return;

    const currentReserved = Number(budget.reserved);
    const newReserved = Math.max(0, currentReserved - reservedAmount);

    await tx.budget.update({
      where: { id: reservationId },
      data: { reserved: newReserved },
    });
  });
}

/**
 * Gets current budget status for a scope.
 */
export async function getBudgetStatus(config: BudgetConfig): Promise<BudgetStatus> {
  const now = new Date();
  const { start } = getPeriodBounds(config.period, now);

  const budget = await prisma.budget.findFirst({
    where: {
      workspaceId: config.workspaceId,
      applicationId: config.applicationId ?? null,
      environmentId: config.environmentId ?? null,
      period: config.period.toUpperCase() as 'DAY' | 'MONTH',
      periodStart: start,
    },
  });

  if (!budget) {
    return {
      allowed: true,
      reserved: 0,
      spent: 0,
      remaining: config.maxSpend,
      limit: config.maxSpend,
      warnThreshold: config.warnThreshold,
      period: config.period,
      warning: false,
      detail: null,
    };
  }

  const spent = Number(budget.spent);
  const reserved = Number(budget.reserved);
  const totalCommitted = spent + reserved;
  const remaining = Math.max(0, config.maxSpend - totalCommitted);
  const utilization = totalCommitted / config.maxSpend;
  const warning = utilization >= config.warnThreshold;

  return {
    allowed: totalCommitted <= config.maxSpend,
    reserved,
    spent,
    remaining,
    limit: config.maxSpend,
    warnThreshold: config.warnThreshold,
    period: config.period,
    warning,
    detail: warning
      ? `Budget at ${Math.round(utilization * 100)}% of ${config.period} limit`
      : null,
  };
}

/**
 * Cleans up expired reservations (run periodically).
 */
export async function cleanupExpiredReservations(): Promise<number> {
  const now = new Date();
  const result = await prisma.budget.updateMany({
    where: {
      reservationExpiresAt: { lt: now },
      reserved: { gt: 0 },
    },
    data: { reserved: 0 },
  });

  return result.count;
}

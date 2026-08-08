import { NextRequest, NextResponse } from 'next/server';

import { runStreamingCompletion } from '@/lib/ai/gateway-streaming';
import { authenticateApiKey, extractKey } from '@/lib/api-keys/authenticate';
import { prisma } from '@/lib/database/client';
import { chatCompletionSchema } from '@/lib/validation/schemas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 1_000_000;

interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
  };
  correlation_id?: string;
}

function errorResponse(
  status: number,
  message: string,
  code: string,
  correlationId?: string,
): NextResponse<ErrorBody> {
  const body: ErrorBody = {
    error: { message, type: 'omnirouter_error', code },
    ...(correlationId ? { correlation_id: correlationId } : {}),
  };

  return NextResponse.json(body, {
    status,
    headers: correlationId ? { 'x-omnirouter-correlation-id': correlationId } : {},
  });
}

/**
 * POST /api/v1/chat/completions (streaming)
 *
 * Streaming version using Server-Sent Events (SSE).
 * Returns a ReadableStream with SSE-formatted chunks.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- 1. Size guard -------------------------------------------------------
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return errorResponse(413, 'Request body is too large.', 'payload_too_large');
  }

  // --- 2. Parse ------------------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'Request body is not valid JSON.', 'invalid_json');
  }

  const parsed = chatCompletionSchema.safeParse(raw);

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return errorResponse(
      400,
      first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request body.',
      'invalid_request',
    );
  }

  // Streaming must be explicitly requested
  if (!parsed.data.stream) {
    return errorResponse(
      400,
      'Streaming not requested. Set "stream": true.',
      'stream_required',
    );
  }

  // --- 3. Authenticate -----------------------------------------------------
  const auth = await authenticateApiKey(extractKey(request.headers), {
    requiredScope: 'chat.completions',
  });

  if (!auth.ok) {
    return errorResponse(401, auth.message, 'invalid_api_key');
  }

  const { key } = auth;

  // --- 4. Resolve the routing policy --------------------------------------
  let policyId = key.defaultPolicyId;

  if (parsed.data.policy) {
    const named = await prisma.routingPolicy.findFirst({
      where: {
        workspaceId: key.workspaceId,
        name: parsed.data.policy,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    if (!named) {
      return errorResponse(
        400,
        `No active routing policy named "${parsed.data.policy}" exists in this workspace.`,
        'unknown_policy',
      );
    }

    policyId = named.id;
  }

  // --- 5. Idempotency (not supported for streaming) ------------------------
  const idempotencyKey = request.headers.get('idempotency-key');
  if (idempotencyKey) {
    return errorResponse(
      400,
      'Idempotency-Key is not supported for streaming requests.',
      'idempotency_not_supported',
    );
  }

  // --- 6. Execute streaming ------------------------------------------------
  const correlationId = crypto.randomUUID();
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
    'x-omnirouter-correlation-id': correlationId,
  };

  const result = await runStreamingCompletion({
    workspaceId: key.workspaceId,
    applicationId: key.applicationId,
    environmentId: key.environmentId,
    environmentType: key.environmentType,
    apiKeyId: key.apiKeyId,
    policyId,
    messages: parsed.data.messages,
    temperature: parsed.data.temperature,
    maxTokens: parsed.data.max_tokens,
    requestedModelId: parsed.data.model,
    structuredOutputSchema: parsed.data.response_format?.json_schema.schema as
      Record<string, unknown> | undefined,
    correlationId,
    source: 'api',
  });

  return new NextResponse(result.stream, { status: 200, headers });
}

export async function GET(): Promise<NextResponse> {
  return errorResponse(405, 'Use POST for chat completions.', 'method_not_allowed');
}

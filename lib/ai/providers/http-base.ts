import { buildNormalisedError, categoriseHttpStatus, categoriseThrown } from '../errors';
import { estimateTokens } from '../tokens';
import type { Capability, NormalisedError, ProviderContext } from '../types';
import { ProviderError } from '../types';
import { validateBaseUrl, safeResolveHostname } from '@/lib/security/ssrf';

/**
 * Shared HTTP plumbing for credential-backed providers.
 *
 * Centralising the fetch, the timeout and the error classification means every
 * adapter fails in the same vocabulary, which is what allows the fallback engine
 * to reason about failures without knowing which provider produced them.
 */

export interface HttpCallOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  context: ProviderContext;
}

export interface HttpCallResult {
  json: unknown;
  latencyMs: number;
  providerRequestId: string | null;
}

/** Parses Retry-After, which may be seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return undefined;
}

/**
 * Validates and resolves a custom base URL with SSRF protection.
 * Called once per provider connection before making requests.
 */
export async function validateAndResolveBaseUrl(baseUrl: string): Promise<string> {
  const validation = validateBaseUrl(baseUrl);
  await safeResolveHostname(validation.hostname);
  return baseUrl;
}

/**
 * Creates a safe fetch wrapper for a validated base URL.
 * Handles timeouts, redirects, and response size limits.
 */
export function createProviderFetch(baseUrl: string, context: ProviderContext) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);

  return {
    async postJson(path: string, headers: Record<string, string>, body: unknown) {
      const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
      const startedAt = Date.now();

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'manual',
        });

        const latencyMs = Date.now() - startedAt;

        if (!response.ok) {
          throw new ProviderError(
            buildNormalisedError(categoriseHttpStatus(response.status), {
              statusCode: response.status,
              retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
            }),
          );
        }

        let json: unknown;
        try {
          json = await response.json();
        } catch {
          throw new ProviderError(
            buildNormalisedError('MALFORMED_RESPONSE', {
              message: 'The provider returned a body that was not valid JSON.',
            }),
          );
        }

        return {
          json,
          latencyMs,
          providerRequestId:
            response.headers.get('x-request-id') ?? response.headers.get('request-id'),
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;

        throw new ProviderError(
          buildNormalisedError(categoriseThrown(error), {
            message:
              categoriseThrown(error) === 'TIMEOUT'
                ? `The provider did not respond within ${context.timeoutMs} ms.`
                : 'A network fault prevented the request from completing.',
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function postJson(options: HttpCallOptions): Promise<HttpCallResult> {
  const { url, headers, body, context } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      // The provider's own error text is deliberately not forwarded: it can
      // echo prompt content or internal identifiers back to the caller.
      throw new ProviderError(
        buildNormalisedError(categoriseHttpStatus(response.status), {
          statusCode: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        }),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderError(
        buildNormalisedError('MALFORMED_RESPONSE', {
          message: 'The provider returned a body that was not valid JSON.',
        }),
      );
    }

    return {
      json,
      latencyMs,
      providerRequestId:
        response.headers.get('x-request-id') ?? response.headers.get('request-id'),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;

    throw new ProviderError(
      buildNormalisedError(categoriseThrown(error), {
        message:
          categoriseThrown(error) === 'TIMEOUT'
            ? `The provider did not respond within ${context.timeoutMs} ms.`
            : 'A network fault prevented the request from completing.',
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  context: ProviderContext,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });

    if (!response.ok) {
      throw new ProviderError(
        buildNormalisedError(categoriseHttpStatus(response.status), {
          statusCode: response.status,
        }),
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(buildNormalisedError(categoriseThrown(error)));
  } finally {
    clearTimeout(timer);
  }
}

export function requireApiKey(context: ProviderContext, provider: string): string {
  if (!context.apiKey) {
    throw new ProviderError(
      buildNormalisedError('AUTHENTICATION', {
        message: `No credential is configured for the ${provider} connection.`,
      }),
    );
  }
  return context.apiKey;
}

export function defaultNormaliseError(error: unknown): NormalisedError {
  if (error instanceof ProviderError) return error.toNormalised();
  return buildNormalisedError(categoriseThrown(error));
}

export function defaultEstimateTokens(text: string): number {
  return estimateTokens(text);
}

/**
 * Capability lookup for credential-backed providers.
 *
 * Capabilities are declared per model in the workspace catalogue rather than
 * hardcoded here, because provider model line-ups change faster than this code
 * would. The map below is a conservative default used when a model has not been
 * catalogued yet.
 */
export function capabilityFromPatterns(
  modelId: string,
  capability: Capability,
  patterns: Partial<Record<Capability, RegExp>>,
): boolean {
  const pattern = patterns[capability];
  if (!pattern) return false;
  return pattern.test(modelId);
}

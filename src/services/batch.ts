import type {
  Env,
  BatchTokenRequest,
  BatchItemResult,
  BatchResponse,
} from "../types/index.js";
import { fetchTokenSecurity } from "./goplus.js";

export const ALLOWED_CHAINS = ["1", "8453"];
export const MAX_TOKENS = 10;
const MAX_CONCURRENCY = 3;
const TIMEOUT_MS = 8000;

export const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/** Validation error for a batch request; null when the request is valid. */
export interface BatchValidationError {
  error: string;
  message: string;
}

/**
 * Validate a batch token list. Returns null when valid, or an error object
 * matching the REST API's 400 body shape.
 */
export function validateBatchTokens(
  tokens: unknown,
): BatchValidationError | null {
  if (!tokens || !Array.isArray(tokens)) {
    return { error: "invalid_body", message: '"tokens" array is required.' };
  }
  if (tokens.length === 0) {
    return {
      error: "invalid_body",
      message: '"tokens" array must not be empty.',
    };
  }
  if (tokens.length > MAX_TOKENS) {
    return {
      error: "too_many_tokens",
      message: `Maximum ${MAX_TOKENS} tokens per request. Got ${tokens.length}.`,
    };
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Partial<BatchTokenRequest>;
    if (!t.chainId) {
      return {
        error: "invalid_token",
        message: `tokens[${i}]: chainId is required.`,
      };
    }
    if (!ALLOWED_CHAINS.includes(t.chainId)) {
      return {
        error: "invalid_chain",
        message: `tokens[${i}]: Unsupported chain "${t.chainId}". Allowed: ${ALLOWED_CHAINS.join(", ")}`,
      };
    }
    if (!t.address || !ADDRESS_PATTERN.test(t.address)) {
      return {
        error: "invalid_address",
        message: `tokens[${i}]: Invalid contract address format.`,
      };
    }
  }
  return null;
}

/**
 * Execute a validated batch analysis: chunked concurrency (3 at a time)
 * under a global 8s deadline. Shared by REST POST /api/v1/tokens and the
 * MCP analyze_tokens_batch tool.
 */
export async function runBatch(
  tokens: BatchTokenRequest[],
  env: Env,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<BatchResponse> {
  const t0 = Date.now();
  const results: BatchItemResult[] = new Array(tokens.length);
  let timedOut = false;
  const deadline = t0 + TIMEOUT_MS;

  let idx = 0;
  while (idx < tokens.length && !timedOut) {
    const chunk = tokens.slice(idx, idx + MAX_CONCURRENCY);
    const chunkStartIdx = idx;

    const promises = chunk.map(async (token, i) => {
      const pos = chunkStartIdx + i;
      const chainId = token.chainId;
      const address = token.address.toLowerCase();

      if (Date.now() >= deadline) {
        timedOut = true;
        results[pos] = { chainId, address, status: "error", error: "timeout" };
        return;
      }

      try {
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          fetchTokenSecurity(
            chainId,
            address,
            env.GOPLUS_API_KEY,
            env.TOKEN_CACHE,
            waitUntil,
          ),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), remaining),
          ),
        ]);

        if (result === null) {
          timedOut = true;
          results[pos] = {
            chainId,
            address,
            status: "error",
            error: "timeout",
          };
          return;
        }

        switch (result.status) {
          case "success":
            results[pos] = {
              chainId,
              address,
              status: "success",
              data: result.data,
            };
            break;
          case "not_found":
            results[pos] = {
              chainId,
              address,
              status: "not_found",
              error: "No security data available for this token.",
            };
            break;
          case "rate_limited":
            results[pos] = {
              chainId,
              address,
              status: "error",
              error: "upstream_throttled",
            };
            break;
          case "error":
            results[pos] = {
              chainId,
              address,
              status: "error",
              error: result.message,
            };
            break;
        }
      } catch (err) {
        results[pos] = {
          chainId,
          address,
          status: "error",
          error: err instanceof Error ? err.message : "unknown_error",
        };
      }
    });

    await Promise.all(promises);
    idx += MAX_CONCURRENCY;
  }

  // Fill remaining items if timed out before their chunk started
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      const token = tokens[i];
      results[i] = {
        chainId: token.chainId,
        address: token.address.toLowerCase(),
        status: "error",
        error: "timeout",
      };
    }
  }

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.length - succeeded;
  const partial = failed > 0 && succeeded > 0;

  return { results, total: results.length, succeeded, failed, partial };
}

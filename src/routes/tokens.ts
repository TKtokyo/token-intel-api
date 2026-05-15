import { Hono } from "hono";
import type {
  Env,
  BatchRequestBody,
  BatchItemResult,
  BatchResponse,
} from "../types/index.js";
import { fetchTokenSecurity } from "../services/goplus.js";

const ALLOWED_CHAINS = ["1", "8453"];
const MAX_TOKENS = 10;
const MAX_CONCURRENCY = 3;
const TIMEOUT_MS = 8000;

const tokensRoutes = new Hono<{ Bindings: Env }>();

tokensRoutes.post("/", async (c) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();

  // --- Parse & validate request body ---
  let body: BatchRequestBody;
  try {
    body = await c.req.json<BatchRequestBody>();
  } catch {
    return c.json(
      { error: "invalid_body", message: "Request body must be valid JSON." },
      400,
    );
  }

  if (!body.tokens || !Array.isArray(body.tokens)) {
    return c.json(
      { error: "invalid_body", message: "\"tokens\" array is required." },
      400,
    );
  }

  if (body.tokens.length === 0) {
    return c.json(
      { error: "invalid_body", message: "\"tokens\" array must not be empty." },
      400,
    );
  }

  if (body.tokens.length > MAX_TOKENS) {
    return c.json(
      {
        error: "too_many_tokens",
        message: `Maximum ${MAX_TOKENS} tokens per request. Got ${body.tokens.length}.`,
      },
      400,
    );
  }

  // Validate each token entry
  for (let i = 0; i < body.tokens.length; i++) {
    const t = body.tokens[i];
    if (!t.chainId) {
      return c.json(
        { error: "invalid_token", message: `tokens[${i}]: chainId is required.` },
        400,
      );
    }
    if (!ALLOWED_CHAINS.includes(t.chainId)) {
      return c.json(
        {
          error: "invalid_chain",
          message: `tokens[${i}]: Unsupported chain "${t.chainId}". Allowed: ${ALLOWED_CHAINS.join(", ")}`,
        },
        400,
      );
    }
    if (!t.address || !/^0x[a-fA-F0-9]{40}$/.test(t.address)) {
      return c.json(
        { error: "invalid_address", message: `tokens[${i}]: Invalid contract address format.` },
        400,
      );
    }
  }

  // --- Execute with concurrency control + global timeout ---
  const results: BatchItemResult[] = new Array(body.tokens.length);
  let timedOut = false;

  // AbortController-like timeout flag
  const deadline = t0 + TIMEOUT_MS;

  // Process tokens in chunks of MAX_CONCURRENCY
  let idx = 0;
  while (idx < body.tokens.length && !timedOut) {
    const chunk = body.tokens.slice(idx, idx + MAX_CONCURRENCY);
    const chunkStartIdx = idx;

    const promises = chunk.map(async (token, i) => {
      const pos = chunkStartIdx + i;
      const chainId = token.chainId;
      const address = token.address.toLowerCase();

      // Check if we've already timed out before starting
      if (Date.now() >= deadline) {
        timedOut = true;
        results[pos] = {
          chainId,
          address,
          status: "error",
          error: "timeout",
        };
        return;
      }

      try {
        // Race against remaining time
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          fetchTokenSecurity(
            chainId,
            address,
            c.env.GOPLUS_API_KEY,
            c.env.TOKEN_CACHE,
            (p) => c.executionCtx.waitUntil(p),
          ),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
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
      const token = body.tokens[i];
      results[i] = {
        chainId: token.chainId,
        address: token.address.toLowerCase(),
        status: "error",
        error: "timeout",
      };
    }
  }

  // --- Build batch response ---
  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.length - succeeded;
  const partial = failed > 0 && succeeded > 0;

  const response: BatchResponse = {
    results,
    total: results.length,
    succeeded,
    failed,
    partial,
  };

  const tTotal = Date.now() - t0;
  console.log(
    `[${requestId}] batch total=${results.length} ok=${succeeded} fail=${failed} partial=${partial} timedOut=${timedOut} t=${tTotal}ms`,
  );

  // 200 for full/partial success, 200 even when all fail (status per item)
  return c.json(response);
});

export { tokensRoutes };

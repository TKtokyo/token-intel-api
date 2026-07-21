import { Hono } from "hono";
import type { Env, BatchRequestBody } from "../types/index.js";
import { validateBatchTokens, runBatch } from "../services/batch.js";

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

  const validationError = validateBatchTokens(body.tokens);
  if (validationError) {
    return c.json(validationError, 400);
  }

  // --- Execute with concurrency control + global timeout ---
  const response = await runBatch(body.tokens, c.env, (p) =>
    c.executionCtx.waitUntil(p),
  );

  const tTotal = Date.now() - t0;
  console.log(
    `[${requestId}] batch total=${response.total} ok=${response.succeeded} fail=${response.failed} partial=${response.partial} t=${tTotal}ms`,
  );

  // 200 for full/partial success, 200 even when all fail (status per item)
  return c.json(response);
});

export { tokensRoutes };

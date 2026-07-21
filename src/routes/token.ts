import { Hono } from "hono";
import type { Env } from "../types/index.js";
import { fetchTokenSecurity } from "../services/goplus.js";
import { ALLOWED_CHAINS, ADDRESS_PATTERN } from "../services/batch.js";

const tokenRoutes = new Hono<{ Bindings: Env }>();

tokenRoutes.get("/:chainId/:address", async (c) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const chainId = c.req.param("chainId");
  const rawAddress = c.req.param("address");

  // Input validation: chainId allowlist (MVP: Ethereum + Base only)
  if (!ALLOWED_CHAINS.includes(chainId)) {
    return c.json(
      {
        error: "invalid_chain",
        message: `Unsupported chain. Allowed: ${ALLOWED_CHAINS.join(", ")}`,
      },
      400,
    );
  }

  // Input validation: address format
  if (!ADDRESS_PATTERN.test(rawAddress)) {
    return c.json(
      { error: "invalid_address", message: "Invalid contract address format." },
      400,
    );
  }

  const address = rawAddress.toLowerCase();
  const t0 = Date.now();

  const result = await fetchTokenSecurity(
    chainId,
    address,
    c.env.GOPLUS_API_KEY,
    c.env.TOKEN_CACHE,
    (p) => c.executionCtx.waitUntil(p),
  );

  const tTotal = Date.now() - t0;

  if (result.status === "rate_limited") {
    console.log(`[${requestId}] ${chainId}:${address} rate_limited t=${tTotal}ms`);
    return c.json(
      {
        error: "upstream_throttled",
        message: "Data source rate limited. Please retry in 30 seconds.",
      },
      429,
    );
  }

  if (result.status === "error") {
    console.error(`[${requestId}] ${chainId}:${address} error msg=${result.message} t=${tTotal}ms`);
    return c.json(
      {
        error: "upstream_unavailable",
        message: "Security data source temporarily unavailable.",
      },
      503,
    );
  }

  if (result.status === "not_found") {
    console.log(`[${requestId}] ${chainId}:${address} not_found t=${tTotal}ms`);
    return c.json(
      {
        error: "token_not_found",
        message: "No security data available for this token.",
      },
      404,
    );
  }

  console.log(
    `[${requestId}] ${chainId}:${address} score=${result.data.risk_score} level=${result.data.risk_level} cached=${result.data.cached} t=${tTotal}ms`,
  );

  return c.json(result.data);
});

export { tokenRoutes };

import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import {
  declareDiscoveryExtension,
  bazaarResourceServerExtension,
} from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { RoutesConfig } from "@x402/core/server";
import type { FacilitatorConfig } from "@x402/core/http";
import type { Env } from "./types/index.js";
import { tokenRoutes } from "./routes/token.js";
import { tokensRoutes } from "./routes/tokens.js";
import { handleMcpRequest } from "./mcp/server.js";
import { OPENAPI_SPEC } from "./openapi.js";

const app = new Hono<{ Bindings: Env }>();

// Security headers middleware (audit P0 #2)
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
});

// Error handler — generic message only (audit P0 #1)
app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack);
  return c.json(
    { error: "internal_error", message: "An unexpected error occurred." },
    500,
  );
});

// Health check (unprotected)
app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

// API info
app.get("/", (c) =>
  c.json({
    name: "Token Intelligence API",
    version: "0.1.0",
    description: "EVM token security analysis via x402 micropayments",
    endpoints: {
      single: "GET /api/v1/token/{chainId}/{address}",
      batch: "POST /api/v1/tokens",
    },
    price: { single: "$0.005", batch: "$0.020" },
    example: "/api/v1/token/1/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    x402: true,
    mcp: {
      endpoint: "/mcp",
      transport: "streamable-http",
      tools: ["analyze_token"],
    },
  }),
);

// OpenAPI spec (unprotected)
app.get("/openapi.json", (c) => {
  return c.json(OPENAPI_SPEC, 200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
});

// llms.txt (unprotected)
app.get("/llms.txt", (c) => {
  const body = `# Token Intel API
> EVM token security analysis with deterministic risk scoring and natural language summaries via x402 micropayments.

## Endpoint
- POST /api/v1/token/{chainId}/{address} — Analyze any EVM token (requires x402 payment)

## Pricing
- $0.005 USDC per request on Base mainnet

## Machine-readable API spec
- OpenAPI 3.0: https://token-intel-api.tatsu77.workers.dev/openapi.json

## MCP
- Streamable HTTP: https://token-intel-api.tatsu77.workers.dev/mcp
`;
  return c.text(body, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
});

// x402 discovery (unprotected)
app.get("/.well-known/x402", (c) => {
  return c.json(
    {
      x402Version: 1,
      resourceServer: "https://token-intel-api.tatsu77.workers.dev",
      facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
      network: "eip155:8453",
      openapi: "https://token-intel-api.tatsu77.workers.dev/openapi.json",
      endpoints: [
        {
          path: "/api/v1/token/{chainId}/{address}",
          method: "GET",
          price: "$0.005",
          asset: "USDC",
        },
        {
          path: "/api/v1/tokens",
          method: "POST",
          price: "$0.020",
          asset: "USDC",
        },
      ],
    },
    200,
    { "Access-Control-Allow-Origin": "*" },
  );
});

// MCP server endpoint (discovery-only — no data, no upstream calls)
app.all("/mcp", async (c) => {
  return handleMcpRequest(c.req.raw);
});

// x402 payment middleware — wraps protected routes
app.use("/api/v1/*", async (c, next) => {
  // Skip paywall in local dev when DISABLE_PAYWALL is set
  if (c.env.DISABLE_PAYWALL === "true") {
    return next();
  }
  // Use CDP facilitator config when keys are available (mainnet),
  // otherwise use simple URL config (testnet)
  let facilitatorConfig: FacilitatorConfig;
  if (c.env.CDP_API_KEY_ID && c.env.CDP_API_KEY_SECRET) {
    facilitatorConfig = createFacilitatorConfig(
      c.env.CDP_API_KEY_ID,
      c.env.CDP_API_KEY_SECRET,
    );
  } else {
    facilitatorConfig = { url: c.env.FACILITATOR_URL };
  }
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

  const server = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(server);
  server.registerExtension(bazaarResourceServerExtension);

  const routes: RoutesConfig = {
    "GET /api/v1/token/*/*": {
      accepts: {
        scheme: "exact",
        network: c.env.X402_NETWORK as `eip155:${string}`,
        price: "$0.005",
        payTo: c.env.PAY_TO_ADDRESS as `0x${string}`,
      },
      resource: "Token Intelligence Report",
      description:
        "Security analysis + risk score + summary for any EVM token",
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          input: { chainId: "1", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
          inputSchema: {
            properties: {
              chainId: {
                type: "string",
                enum: ["1", "8453"],
                description: "Chain ID (1 = Ethereum, 8453 = Base)",
              },
              address: {
                type: "string",
                pattern: "^0x[a-fA-F0-9]{40}$",
                description: "ERC-20 token contract address",
              },
            },
            required: ["chainId", "address"],
          },
          output: {
            example: {
              token: {
                name: "USD Coin",
                symbol: "USDC",
                chain_id: "1",
                address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                total_supply: "25000000000000000",
              },
              security: {
                is_honeypot: false,
                is_open_source: true,
                is_proxy: true,
                is_mintable: false,
              },
              risk_score: 80,
              risk_level: "LOW",
              summary:
                "LOW risk. Contract is open source, verified. No honeypot detected.",
              cached: false,
              data_age_seconds: 0,
            },
            schema: {
              type: "object",
              properties: {
                token: { type: "object" },
                security: { type: "object" },
                holders: { type: "object" },
                liquidity: { type: "object" },
                risk_score: {
                  type: "number",
                  minimum: 0,
                  maximum: 100,
                  description: "Risk score (0 = critical, 100 = safest)",
                },
                risk_level: {
                  type: "string",
                  enum: ["CRITICAL", "HIGH", "MODERATE", "LOW"],
                },
                summary: { type: "string" },
                cached: { type: "boolean" },
                data_age_seconds: { type: "number" },
              },
              required: [
                "token",
                "security",
                "holders",
                "liquidity",
                "risk_score",
                "risk_level",
                "summary",
              ],
            },
          },
        }),
      },
    },
    "POST /api/v1/tokens": {
      accepts: {
        scheme: "exact",
        network: c.env.X402_NETWORK as `eip155:${string}`,
        price: "$0.020",
        payTo: c.env.PAY_TO_ADDRESS as `0x${string}`,
      },
      resource: "Batch Token Intelligence Report",
      description:
        "Batch security analysis for up to 10 EVM tokens in one request",
      mimeType: "application/json",
    },
  };

  const middleware = paymentMiddleware(routes, server);
  return middleware(c, next);
});

// Protected routes
app.route("/api/v1/token", tokenRoutes);
app.route("/api/v1/tokens", tokensRoutes);

export default app;

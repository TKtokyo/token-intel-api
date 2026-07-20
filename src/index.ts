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
import { VERSION } from "./version.js";

// ─── Token route definitions (single source of truth) ──────────────────────
//
// TOKEN_ROUTES drives both the payment middleware and the .well-known/x402
// manifest, so the route URLs, prices, and discovery metadata cannot drift.
// `buildAccepts` produces the same PaymentRequirements that the @x402/hono
// middleware emits in the PAYMENT-REQUIRED header, ensuring x402scan and any
// other consumer sees identical accepts[] from both sources.

interface TokenRouteDef {
  method: "GET" | "POST";
  middlewarePattern: string; // pattern consumed by paymentMiddleware
  resourcePath: string;       // concrete path embedded in manifest resource URL
  price: string;              // USD form consumed by paymentMiddleware (e.g. "$0.005")
  resourceName: string;
  description: string;
  bodyType?: "json" | "form-data" | "text"; // required for POST/PUT/PATCH
  inputExample: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputExample: unknown;
  outputSchema: Record<string, unknown>;
}

// PEPE on Ethereum mainnet — used as the concrete sample in the manifest
// URL so x402scan validation hits a real path that returns 402.
const PEPE_ADDRESS = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
// USDC on Base mainnet — second sample for the batch endpoint example.
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TOKEN_ROUTES: Record<string, TokenRouteDef> = {
  "/api/v1/token/{chainId}/{address}": {
    method: "GET",
    // Named params (not wildcards) so bazaar discovery emits
    // routeTemplate /api/v1/token/:chainId/:address with real param names.
    middlewarePattern: "GET /api/v1/token/:chainId/:address",
    resourcePath: `/api/v1/token/1/${PEPE_ADDRESS}`,
    price: "$0.005",
    resourceName: "EVM Token Intelligence Report",
    description:
      "Security analysis, deterministic risk score, and natural language summary for any EVM token",
    inputExample: { chainId: "1", address: PEPE_ADDRESS },
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
    outputExample: {
      token: {
        name: "Pepe",
        symbol: "PEPE",
        chain_id: "1",
        address: PEPE_ADDRESS.toLowerCase(),
        total_supply: "420690000000000000000000000000000",
      },
      security: {
        is_honeypot: false,
        is_open_source: true,
        is_proxy: false,
        is_mintable: false,
      },
      risk_score: 85,
      risk_level: "LOW",
      summary:
        "LOW risk. Contract is open source, verified. No honeypot detected.",
      cached: false,
      data_age_seconds: 0,
    },
    outputSchema: {
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
  "/api/v1/tokens": {
    method: "POST",
    middlewarePattern: "POST /api/v1/tokens",
    resourcePath: "/api/v1/tokens",
    price: "$0.020",
    bodyType: "json",
    resourceName: "Batch EVM Token Intelligence Report",
    description:
      "Batch security analysis for up to 10 EVM tokens in a single request",
    inputExample: {
      tokens: [
        { chainId: "1", address: PEPE_ADDRESS },
        { chainId: "8453", address: BASE_USDC_ADDRESS },
      ],
    },
    inputSchema: {
      properties: {
        tokens: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          description: "Array of tokens to analyse (max 10 per request)",
          items: {
            type: "object",
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
        },
      },
      required: ["tokens"],
    },
    outputExample: {
      results: [
        {
          chainId: "1",
          address: PEPE_ADDRESS.toLowerCase(),
          status: "success",
          data: {
            token: { name: "Pepe", symbol: "PEPE", chain_id: "1" },
            risk_score: 85,
            risk_level: "LOW",
          },
        },
        {
          chainId: "8453",
          address: BASE_USDC_ADDRESS.toLowerCase(),
          status: "success",
          data: {
            token: { name: "USD Coin", symbol: "USDC", chain_id: "8453" },
            risk_score: 95,
            risk_level: "LOW",
          },
        },
      ],
      total: 2,
      succeeded: 2,
      failed: 0,
      partial: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              chainId: { type: "string" },
              address: { type: "string" },
              status: {
                type: "string",
                enum: ["success", "not_found", "error"],
              },
              data: { type: "object" },
              error: { type: "string" },
            },
            required: ["chainId", "address", "status"],
          },
        },
        total: { type: "number" },
        succeeded: { type: "number" },
        failed: { type: "number" },
        partial: { type: "boolean" },
      },
      required: ["results", "total", "succeeded", "failed", "partial"],
    },
  },
};

interface UsdcInfo {
  address: string;
  name: string;
  version: string;
}

// USDC contract metadata per supported network. Values must match what
// @x402/hono resolves on-chain, so the manifest's accepts[] is byte-identical
// to the middleware-emitted PAYMENT-REQUIRED payload.
const USDC_BY_NETWORK: Record<string, UsdcInfo> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
  },
};

// "$0.020" -> "20000" (USDC has 6 decimals). BigInt-based so no float drift.
function usdToUsdcBaseUnits(price: string): string {
  const match = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(price);
  if (!match) throw new Error(`Invalid price format: ${price}`);
  const whole = BigInt(match[1]);
  const frac = (match[2] ?? "").padEnd(6, "0");
  return (whole * 1_000_000n + BigInt(frac || "0")).toString();
}

interface PaymentRequirement {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

function buildAccepts(price: string, env: Env): PaymentRequirement[] {
  const usdc = USDC_BY_NETWORK[env.X402_NETWORK];
  if (!usdc) {
    throw new Error(`Unsupported X402_NETWORK: ${env.X402_NETWORK}`);
  }
  return [
    {
      scheme: "exact",
      network: env.X402_NETWORK,
      amount: usdToUsdcBaseUnits(price),
      asset: usdc.address,
      payTo: env.PAY_TO_ADDRESS,
      maxTimeoutSeconds: 300,
      extra: { name: usdc.name, version: usdc.version },
    },
  ];
}

// Bumped when the route schema, pricing, or sample addresses change.
const RESOURCES_LAST_UPDATED = "2026-07-21T00:00:00Z";

// Bazaar discovery extension payload per route, shared verbatim between the
// payment middleware config and the .well-known/x402 manifest so both
// surfaces always describe the same schemas.
function buildDiscoveryExtension(route: TokenRouteDef) {
  return declareDiscoveryExtension(
    route.bodyType
      ? {
          input: route.inputExample,
          inputSchema: route.inputSchema,
          bodyType: route.bodyType,
          output: {
            example: route.outputExample,
            schema: route.outputSchema,
          },
        }
      : {
          input: route.inputExample,
          inputSchema: route.inputSchema,
          output: {
            example: route.outputExample,
            schema: route.outputSchema,
          },
        },
  );
}

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
app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));

// API info
app.get("/", (c) =>
  c.json({
    name: "Token Intelligence API",
    version: VERSION,
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

## Endpoints
- GET /api/v1/token/{chainId}/{address} — Analyze a single EVM token ($0.005 USDC, x402)
- POST /api/v1/tokens — Batch-analyze up to 10 EVM tokens in one request ($0.020 USDC, x402)

Both paid endpoints run on Base mainnet. chainId is "1" (Ethereum) or "8453" (Base); address is the ERC-20 contract.

## Machine-readable API spec
- OpenAPI 3.0: https://token-intel-api.tatsu77.workers.dev/openapi.json

## Discovery
- x402 manifest: https://token-intel-api.tatsu77.workers.dev/.well-known/x402

## MCP
- Streamable HTTP: https://token-intel-api.tatsu77.workers.dev/mcp
`;
  return c.text(body, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
});

// x402 discovery (unprotected). Emits the standard `resources` array used
// by x402scan and other bazaar consumers. Each entry's accepts[] is
// produced by the same `buildAccepts` helper used by `unpaidResponseBody`,
// so the manifest and the 402 response stay byte-identical.
app.get("/.well-known/x402", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  const resources = Object.values(TOKEN_ROUTES).map((route) => ({
    resource: `${baseUrl}${route.resourcePath}`,
    type: "http",
    x402Version: 2,
    accepts: buildAccepts(route.price, c.env),
    lastUpdated: RESOURCES_LAST_UPDATED,
    description: route.description,
    mimeType: "application/json",
    // Same bazaar payload the payment middleware declares, so indexers see
    // identical schemas whether they read the manifest or the 402 response.
    extensions: buildDiscoveryExtension(route),
    metadata: {
      method: route.method,
      name: route.resourceName,
      description: route.description,
      inputSchema: route.inputSchema,
      outputExample: route.outputExample,
    },
  }));

  return c.json(
    {
      x402Version: 2,
      resourceServer: baseUrl,
      facilitator: c.env.FACILITATOR_URL,
      network: c.env.X402_NETWORK,
      openapi: `${baseUrl}/openapi.json`,
      resources,
    },
    200,
    { "Access-Control-Allow-Origin": "*" },
  );
});

// MCP server endpoint (discovery-only — no data, no upstream calls)
app.all("/mcp", async (c) => {
  return handleMcpRequest(c.req.raw);
});

// x402 payment middleware — wraps protected routes.
//
// The facilitator client, resource server, and route config are pure
// functions of env vars, so the middleware is built once per isolate and
// reused across requests (rebuilt only if env values change, e.g. between
// wrangler dev sessions).
let cachedMiddleware: ReturnType<typeof paymentMiddleware> | null = null;
let cachedMiddlewareKey = "";

function getPaymentMiddleware(env: Env): ReturnType<typeof paymentMiddleware> {
  const key = [
    env.X402_NETWORK,
    env.PAY_TO_ADDRESS,
    env.FACILITATOR_URL,
    env.CDP_API_KEY_ID ?? "",
  ].join("|");
  if (cachedMiddleware && cachedMiddlewareKey === key) {
    return cachedMiddleware;
  }

  // Use CDP facilitator config when keys are available (mainnet),
  // otherwise use simple URL config (testnet)
  let facilitatorConfig: FacilitatorConfig;
  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    facilitatorConfig = createFacilitatorConfig(
      env.CDP_API_KEY_ID,
      env.CDP_API_KEY_SECRET,
    );
  } else {
    facilitatorConfig = { url: env.FACILITATOR_URL };
  }
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

  const server = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(server);
  server.registerExtension(bazaarResourceServerExtension);

  const network = env.X402_NETWORK as `eip155:${string}`;
  const payTo = env.PAY_TO_ADDRESS as `0x${string}`;

  const routes: RoutesConfig = {};
  for (const route of Object.values(TOKEN_ROUTES)) {
    const accepts = buildAccepts(route.price, env);
    routes[route.middlewarePattern] = {
      accepts: {
        scheme: "exact",
        network,
        price: route.price,
        payTo,
      },
      // `resource` is intentionally omitted: v2 treats it as the resource
      // URL and defaults to the request URL. The human-readable name lives
      // in `serviceName` (Bazaar service metadata).
      serviceName: "Token Intel API",
      description: route.description,
      mimeType: "application/json",
      extensions: buildDiscoveryExtension(route),
      // Mirror accepts[] into the 402 body so callers that only read JSON
      // (e.g. x402scan validators, naive curl checks) see the same payment
      // requirements they would otherwise pull from PAYMENT-REQUIRED header.
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          x402Version: 2,
          accepts,
          error:
            "Payment required: send an x402 payment via the PAYMENT-SIGNATURE header (requirements in the PAYMENT-REQUIRED header and accepts[] above).",
        },
      }),
    };
  }

  cachedMiddleware = paymentMiddleware(routes, server);
  cachedMiddlewareKey = key;
  return cachedMiddleware;
}

app.use("/api/v1/*", async (c, next) => {
  // Skip paywall in local dev when DISABLE_PAYWALL is set
  if (c.env.DISABLE_PAYWALL === "true") {
    return next();
  }
  return getPaymentMiddleware(c.env)(c, next);
});

// Protected routes
app.route("/api/v1/token", tokenRoutes);
app.route("/api/v1/tokens", tokensRoutes);

export default app;

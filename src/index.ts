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

// x402 payment middleware — wraps protected routes
app.use("/api/v1/*", async (c, next) => {
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
  };

  const middleware = paymentMiddleware(routes, server);
  return middleware(c, next);
});

// Protected route
app.route("/api/v1/token", tokenRoutes);

export default app;

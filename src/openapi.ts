export const OPENAPI_SPEC = {
  openapi: "3.0.0",
  info: {
    title: "Token Intel API",
    version: "1.0.0",
    description:
      "EVM token security analysis with deterministic risk scoring and natural language summaries via x402 micropayments. Aggregates GoPlus contract, holder, and liquidity data in one request.",
    contact: {
      url: "https://token-intel-api.tatsu77.workers.dev/llms.txt",
    },
  },
  servers: [
    {
      url: "https://token-intel-api.tatsu77.workers.dev",
      description: "Production (Base mainnet)",
    },
  ],
  paths: {
    "/api/v1/token/{chainId}/{address}": {
      get: {
        summary: "EVM Token Security Analysis",
        description:
          "Returns deterministic risk score (0-100) and natural language summary for any EVM token. Requires x402 payment of $0.005 USDC on Base mainnet.",
        parameters: [
          {
            name: "chainId",
            in: "path",
            required: true,
            description: "EVM chain ID (1 = Ethereum, 8453 = Base)",
            schema: { type: "string", enum: ["1", "8453"], example: "1" },
          },
          {
            name: "address",
            in: "path",
            required: true,
            description: "Token contract address (0x...)",
            schema: {
              type: "string",
              pattern: "^0x[a-fA-F0-9]{40}$",
              example: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            },
          },
        ],
        responses: {
          "200": {
            description: "Token security analysis result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TokenIntelResponse" },
              },
            },
          },
          "402": {
            description:
              "Payment required. Include X-Payment header with x402 USDC payment proof.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    x402Version: { type: "integer" },
                    accepts: { type: "array" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Token not found in GoPlus database.",
          },
        },
        "x-x402": {
          price: "$0.005 USDC",
          network: "base",
          facilitator: "Coinbase CDP",
        },
      },
    },
    "/api/v1/tokens": {
      post: {
        summary: "Batch EVM Token Security Analysis",
        description:
          "Analyze up to 10 EVM tokens in a single request. Returns partial results if the 8-second timeout is reached. Requires x402 payment of $0.020 USDC on Base mainnet.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tokens"],
                properties: {
                  tokens: {
                    type: "array",
                    minItems: 1,
                    maxItems: 10,
                    items: {
                      type: "object",
                      required: ["chainId", "address"],
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
                    },
                  },
                },
              },
              example: {
                tokens: [
                  { chainId: "1", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
                  { chainId: "1", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Batch analysis results. Each item has a status field indicating success, not_found, or error.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["results", "total", "succeeded", "failed", "partial"],
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["chainId", "address", "status"],
                        properties: {
                          chainId: { type: "string" },
                          address: { type: "string" },
                          status: {
                            type: "string",
                            enum: ["success", "not_found", "error"],
                          },
                          data: { $ref: "#/components/schemas/TokenIntelResponse" },
                          error: { type: "string" },
                        },
                      },
                    },
                    total: { type: "integer", description: "Total tokens requested" },
                    succeeded: { type: "integer", description: "Successfully analyzed count" },
                    failed: { type: "integer", description: "Failed count" },
                    partial: {
                      type: "boolean",
                      description: "True when some succeeded and some failed (e.g. timeout)",
                    },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid request (bad body, >10 tokens, invalid chain/address)",
          },
          "402": {
            description:
              "Payment required. Include X-Payment header with x402 USDC payment proof.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    x402Version: { type: "integer" },
                    accepts: { type: "array" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
        },
        "x-x402": {
          price: "$0.020 USDC",
          network: "base",
          facilitator: "Coinbase CDP",
        },
      },
    },
  },
  components: {
    schemas: {
      TokenIntelResponse: {
        type: "object",
        required: [
          "token", "security", "holders", "liquidity",
          "risk_score", "risk_level", "summary", "cached", "data_age_seconds",
        ],
        properties: {
          token: {
            type: "object",
            properties: {
              name: { type: "string" },
              symbol: { type: "string" },
              chain_id: { type: "string" },
              address: { type: "string" },
              total_supply: { type: "string" },
            },
          },
          security: { type: "object", description: "Security flags (is_honeypot, is_proxy, etc.)" },
          holders: { type: "object", description: "Holder distribution metrics" },
          liquidity: { type: "object", description: "DEX liquidity data" },
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
          summary: { type: "string", description: "Natural language risk summary" },
          cached: { type: "boolean" },
          data_age_seconds: { type: "number" },
        },
      },
    },
  },
} as const;

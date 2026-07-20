/**
 * Lightweight stateless MCP server implementation (discovery-only).
 *
 * Implements the MCP Streamable HTTP transport (JSON-RPC 2.0) directly,
 * without the heavy @modelcontextprotocol/sdk or agents package.
 *
 * Supported methods:
 *   - initialize              → server capabilities & info
 *   - notifications/initialized → acknowledge (no response)
 *   - tools/list              → available tool definitions (free)
 *   - tools/call              → returns payment-required redirect (no data)
 *
 * Actual data retrieval requires x402 payment via the REST API.
 */

// ─── JSON-RPC types ──────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── MCP protocol constants ──────────────────────────────────────

import { VERSION } from "../version.js";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = {
  name: "Token Intelligence API",
  version: VERSION,
};

// ─── Tool definitions ───────────────────────────────────────────

const TOOLS = [
  {
    name: "analyze_token",
    description:
      "EVM token security analysis with risk scoring. Returns security flags, holder info, liquidity data, risk score (0-100), and a human-readable summary. Requires x402 payment ($0.005 USDC) via REST API.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chainId: {
          type: "string",
          description: "Chain ID: '1' for Ethereum, '8453' for Base",
          enum: ["1", "8453"],
        },
        address: {
          type: "string",
          description:
            "ERC-20 token contract address (0x-prefixed, 40 hex chars)",
          pattern: "^0x[a-fA-F0-9]{40}$",
        },
      },
      required: ["chainId", "address"],
    },
  },
  {
    name: "analyze_tokens_batch",
    description:
      "Batch security analysis for up to 10 EVM tokens in one request. Returns per-token results with security flags, risk scores, and summaries. Requires x402 payment ($0.02 USDC) via REST API.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokens: {
          type: "array",
          description: "Array of tokens to analyze (max 10)",
          items: {
            type: "object",
            properties: {
              chainId: {
                type: "string",
                description: "Chain ID: '1' for Ethereum, '8453' for Base",
                enum: ["1", "8453"],
              },
              address: {
                type: "string",
                description:
                  "ERC-20 token contract address (0x-prefixed, 40 hex chars)",
                pattern: "^0x[a-fA-F0-9]{40}$",
              },
            },
            required: ["chainId", "address"],
          },
          minItems: 1,
          maxItems: 10,
        },
      },
      required: ["tokens"],
    },
  },
];

// ─── JSON-RPC method dispatcher ──────────────────────────────────

function handleJsonRpcRequest(
  req: JsonRpcRequest,
): JsonRpcResponse | null {
  const { method, id, params } = req;

  // Notifications have no id and expect no response
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const toolName = (params as { name?: string })?.name;

      if (toolName === "analyze_token") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Payment required. Please use the REST API endpoint with x402 payment: GET /api/v1/token/{chainId}/{address} — $0.005 USDC on Base.",
              },
            ],
            isError: false,
          },
        };
      }

      if (toolName === "analyze_tokens_batch") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Payment required. Please use the REST API endpoint with x402 payment: POST /api/v1/tokens — $0.02 USDC on Base. Send JSON body: { \"tokens\": [{ \"chainId\": \"1\", \"address\": \"0x...\" }, ...] } (max 10 tokens).",
              },
            ],
            isError: false,
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Unknown tool.",
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: "Method not supported.",
        },
      };
  }
}

// ─── CORS headers ────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

/** Add CORS headers to a Response */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── HTTP handler ────────────────────────────────────────────────

/**
 * Handle an MCP Streamable HTTP request.
 * Discovery-only: initialize + tools/list are free, tools/call returns payment redirect.
 */
export async function handleMcpRequest(
  request: Request,
): Promise<Response> {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only POST for stateless servers
  if (request.method === "GET") {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "SSE transport not supported. Use POST with JSON-RPC.",
          },
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            Allow: "POST, OPTIONS",
          },
        },
      ),
    );
  }

  if (request.method === "DELETE") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (request.method !== "POST") {
    return withCors(
      new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } }),
    );
  }

  // Validate content type
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Content-Type must be application/json",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }

  // Handle batch requests
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const req of body as JsonRpcRequest[]) {
      const resp = handleJsonRpcRequest(req);
      if (resp) responses.push(resp);
    }
    if (responses.length === 0) {
      return withCors(new Response(null, { status: 204 }));
    }
    return withCors(
      new Response(JSON.stringify(responses), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  // Single request
  const resp = handleJsonRpcRequest(body as JsonRpcRequest);
  if (!resp) {
    return withCors(new Response(null, { status: 204 }));
  }

  return withCors(
    new Response(JSON.stringify(resp), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

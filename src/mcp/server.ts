/**
 * Lightweight stateless MCP server with x402 paid tool execution.
 *
 * Implements the MCP Streamable HTTP transport (JSON-RPC 2.0) directly,
 * without the heavy @modelcontextprotocol/sdk or agents package.
 *
 * Supported methods:
 *   - initialize                → server capabilities & info
 *   - notifications/initialized → acknowledge (no response)
 *   - tools/list                → available tool definitions (free)
 *   - tools/call                → paid execution via @x402/mcp payment wrapper
 *
 * Payment flow (x402 MCP transport):
 *   1. Client calls a tool without payment → tool result carries a
 *      PaymentRequired object (isError: true, structuredContent + JSON text).
 *   2. Client signs payment and retries with the payload in
 *      params._meta["x402/payment"].
 *   3. Server verifies via facilitator, runs the tool, settles, and attaches
 *      the settlement receipt to result._meta["x402/payment-response"].
 *
 * x402-aware clients (@x402/mcp x402MCPClient) handle this automatically.
 */

import { createPaymentWrapper } from "@x402/mcp";
import type { MCPToolCallback, WrappedToolResult, ToolResult } from "@x402/mcp";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Env } from "../types/index.js";
import { fetchTokenSecurity } from "../services/goplus.js";
import {
  validateBatchTokens,
  runBatch,
  ALLOWED_CHAINS,
  ADDRESS_PATTERN,
} from "../services/batch.js";
import {
  getResourceServer,
  buildAccepts,
  batchPrice,
  SERVICE_NAME,
  SERVICE_TAGS,
  PRICE_SINGLE,
  PRICE_BATCH,
} from "../x402/payments.js";
import { VERSION } from "../version.js";

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

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: SERVICE_NAME,
  version: VERSION,
};

// ─── Tool definitions ───────────────────────────────────────────

export interface McpToolDef {
  name: string;
  description: string;
  price: string;
  inputSchema: Record<string, unknown>;
  outputExample: unknown;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "analyze_token",
    description:
      `EVM token security analysis with risk scoring. Returns security flags, holder info, liquidity data, risk score (0-100), and a human-readable summary. Paid tool: ${PRICE_SINGLE} USDC per call via x402 (payment handled in-protocol; x402-aware MCP clients pay automatically).`,
    price: PRICE_SINGLE,
    inputSchema: {
      type: "object" as const,
      properties: {
        chainId: {
          type: "string",
          description: "Chain ID: '1' for Ethereum, '8453' for Base",
          enum: ALLOWED_CHAINS,
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
    outputExample: {
      token: { name: "Pepe", symbol: "PEPE", chain_id: "1" },
      risk_score: 85,
      risk_level: "LOW",
      summary: "LOW risk. Contract is open source, verified.",
    },
  },
  {
    name: "analyze_tokens_batch",
    description:
      `Batch security analysis for up to 10 EVM tokens in one request. Returns per-token results with security flags, risk scores, and summaries. Paid tool: $0.003 USDC per token, capped at ${PRICE_BATCH}, via x402 (payment handled in-protocol; x402-aware MCP clients pay automatically).`,
    price: PRICE_BATCH,
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
                enum: ALLOWED_CHAINS,
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
    outputExample: {
      results: [
        {
          chainId: "1",
          address: "0x...",
          status: "success",
          data: { risk_score: 85, risk_level: "LOW" },
        },
      ],
      total: 1,
      succeeded: 1,
      failed: 0,
      partial: false,
    },
  },
];

/**
 * Bazaar discovery extension payload for an MCP tool. Used both in the
 * PaymentRequired responses emitted by the payment wrapper and in the
 * .well-known/x402 manifest, so indexers see identical metadata.
 */
export function buildMcpDiscoveryExtension(
  tool: McpToolDef,
): Record<string, unknown> {
  return declareDiscoveryExtension({
    toolName: tool.name,
    description: tool.description,
    transport: "streamable-http",
    inputSchema: tool.inputSchema,
    output: { example: tool.outputExample },
  });
}

// ─── Tool handlers (business logic, payment-agnostic) ────────────

function textResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}

function makeAnalyzeTokenHandler(
  env: Env,
  waitUntil?: (p: Promise<unknown>) => void,
) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const chainId = String(args.chainId ?? "");
    const rawAddress = String(args.address ?? "");

    if (!ALLOWED_CHAINS.includes(chainId)) {
      return textResult(
        {
          error: "invalid_chain",
          message: `Unsupported chain. Allowed: ${ALLOWED_CHAINS.join(", ")}`,
        },
        true,
      );
    }
    if (!ADDRESS_PATTERN.test(rawAddress)) {
      return textResult(
        {
          error: "invalid_address",
          message: "Invalid contract address format.",
        },
        true,
      );
    }

    const result = await fetchTokenSecurity(
      chainId,
      rawAddress.toLowerCase(),
      env.GOPLUS_API_KEY,
      env.TOKEN_CACHE,
      waitUntil,
    );

    switch (result.status) {
      case "success":
        return textResult(result.data);
      case "not_found":
        return textResult(
          {
            error: "token_not_found",
            message: "No security data available for this token.",
          },
          true,
        );
      case "rate_limited":
        return textResult(
          {
            error: "upstream_throttled",
            message: "Data source rate limited. Please retry in 30 seconds.",
          },
          true,
        );
      case "error":
        return textResult(
          {
            error: "upstream_unavailable",
            message: "Security data source temporarily unavailable.",
          },
          true,
        );
    }
  };
}

function makeBatchHandler(
  env: Env,
  waitUntil?: (p: Promise<unknown>) => void,
) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const validationError = validateBatchTokens(args.tokens);
    if (validationError) {
      return textResult(validationError, true);
    }
    const response = await runBatch(
      args.tokens as { chainId: string; address: string }[],
      env,
      waitUntil,
    );
    return textResult(response);
  };
}

// ─── Paid tool dispatch ──────────────────────────────────────────

/**
 * Build the payment-wrapped tool callbacks for this request.
 *
 * The resource server is memoized per isolate (getResourceServer); the
 * wrappers themselves are cheap closures created per request so they can
 * capture env and waitUntil.
 */
/**
 * Price a tool call. The batch tool uses dynamic pricing ($0.003/token,
 * capped at $0.020) based on the actual arguments of this call; unparseable
 * arguments price at the cap and then fail validation (payment cancelled,
 * not settled).
 */
function toolCallPrice(tool: McpToolDef, args: Record<string, unknown>): string {
  if (tool.name !== "analyze_tokens_batch") {
    return tool.price;
  }
  // Malformed args quote 1 token (matching the HTTP route) so auto-paying
  // clients don't sign the cap price for a call that can never succeed —
  // validation rejects it after the payment check and the payment cancels.
  const tokens = args.tokens;
  return batchPrice(Array.isArray(tokens) ? tokens.length : 1);
}

function buildToolCallbacks(
  env: Env,
  args: Record<string, unknown>,
  waitUntil?: (p: Promise<unknown>) => void,
): Record<string, MCPToolCallback> {
  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<ToolResult>
  > = {
    analyze_token: makeAnalyzeTokenHandler(env, waitUntil),
    analyze_tokens_batch: makeBatchHandler(env, waitUntil),
  };

  // Local dev: skip payment entirely when DISABLE_PAYWALL is set.
  if (env.DISABLE_PAYWALL === "true") {
    const passthrough: Record<string, MCPToolCallback> = {};
    for (const [name, handler] of Object.entries(handlers)) {
      passthrough[name] = async (callArgs) =>
        (await handler(callArgs)) as WrappedToolResult;
    }
    return passthrough;
  }

  const server = getResourceServer(env);
  const callbacks: Record<string, MCPToolCallback> = {};
  for (const tool of MCP_TOOLS) {
    const paid = createPaymentWrapper(server, {
      accepts: buildAccepts(toolCallPrice(tool, args), env) as never,
      resource: {
        url: `mcp://tool/${tool.name}`,
        description: tool.description,
        mimeType: "application/json",
        serviceName: SERVICE_NAME,
        tags: SERVICE_TAGS,
      },
      extensions: buildMcpDiscoveryExtension(tool),
    });
    callbacks[tool.name] = paid(handlers[tool.name]);
  }
  return callbacks;
}

// ─── JSON-RPC method dispatcher ──────────────────────────────────

async function handleJsonRpcRequest(
  req: JsonRpcRequest,
  env: Env,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<JsonRpcResponse | null> {
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
        result: {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const p = (params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      };
      const toolName = p.name;
      if (!toolName || !MCP_TOOLS.some((t) => t.name === toolName)) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Unknown tool." },
        };
      }

      const callbacks = buildToolCallbacks(env, p.arguments ?? {}, waitUntil);
      try {
        const result = await callbacks[toolName](p.arguments ?? {}, {
          _meta: p._meta,
        });
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        console.error(
          `MCP tools/call ${toolName} failed:`,
          err instanceof Error ? err.message : err,
        );
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Tool execution failed." },
        };
      }
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
 * initialize + tools/list are free; tools/call executes with x402 payment.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  waitUntil?: (p: Promise<unknown>) => void,
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
      const resp = await handleJsonRpcRequest(req, env, waitUntil);
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
  const resp = await handleJsonRpcRequest(
    body as JsonRpcRequest,
    env,
    waitUntil,
  );
  if (!resp) {
    return withCors(new Response(null, { status: 204 }));
  }

  return withCors(
    new Response(JSON.stringify(resp), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

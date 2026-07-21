import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { FacilitatorConfig } from "@x402/core/http";
import type { Env } from "../types/index.js";

// ─── Service-level Bazaar metadata (shared by HTTP routes and MCP tools) ───

export const SERVICE_NAME = "Token Intel API";
export const SERVICE_TAGS = ["defi", "security", "token", "risk", "evm"];

// ─── Pricing (single source of truth for REST routes and MCP tools) ────────

export const PRICE_SINGLE = "$0.005";
export const PRICE_BATCH = "$0.020";

// ─── USDC payment requirements ─────────────────────────────────────────────

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
export function usdToUsdcBaseUnits(price: string): string {
  const match = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(price);
  if (!match) throw new Error(`Invalid price format: ${price}`);
  const whole = BigInt(match[1]);
  const frac = (match[2] ?? "").padEnd(6, "0");
  return (whole * 1_000_000n + BigInt(frac || "0")).toString();
}

export interface PaymentRequirement {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export function buildAccepts(price: string, env: Env): PaymentRequirement[] {
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

// ─── Shared x402 resource server ───────────────────────────────────────────
//
// One x402ResourceServer per isolate, shared by the HTTP payment middleware
// and the MCP payment wrappers. Rebuilt only if env values change.

let cachedServer: x402ResourceServer | null = null;
let cachedServerKey = "";

export function envCacheKey(env: Env): string {
  return [
    env.X402_NETWORK,
    env.PAY_TO_ADDRESS,
    env.FACILITATOR_URL,
    env.CDP_API_KEY_ID ?? "",
  ].join("|");
}

export function getResourceServer(env: Env): x402ResourceServer {
  const key = envCacheKey(env);
  if (cachedServer && cachedServerKey === key) {
    return cachedServer;
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

  cachedServer = server;
  cachedServerKey = key;
  return server;
}

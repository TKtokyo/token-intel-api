import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createSIWxResourceServerExtension } from "@x402/extensions/sign-in-with-x";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { FacilitatorConfig } from "@x402/core/http";
import type { Env } from "../types/index.js";
import { KVSIWxStorage } from "./siwx.js";

// ─── Service-level Bazaar metadata (shared by HTTP routes and MCP tools) ───

export const SERVICE_NAME = "Token Intel API";
export const SERVICE_TAGS = ["defi", "security", "token", "risk", "evm"];

// ─── Pricing (single source of truth for REST routes and MCP tools) ────────

export const PRICE_SINGLE = "$0.005";
/** Batch: per-token price, capped so no batch ever costs more than before. */
export const BATCH_UNITS_PER_TOKEN = 3_000n; // $0.003 in USDC base units
export const BATCH_UNITS_CAP = 20_000n; // $0.020 cap
/** Advertised maximum batch price (manifest, docs). */
export const PRICE_BATCH = "$0.020";

/** USDC base units (6 decimals) → "$0.009"-style dollar string. */
export function formatUsd(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `$${whole}.${frac}` : `$${whole}`;
}

/** Price for a batch of `count` tokens: $0.003/token, capped at $0.020. */
export function batchPriceUnits(count: number): bigint {
  const n = BigInt(Math.max(1, Math.min(10, Math.floor(count))));
  const units = BATCH_UNITS_PER_TOKEN * n;
  return units > BATCH_UNITS_CAP ? BATCH_UNITS_CAP : units;
}

export function batchPrice(count: number): string {
  return formatUsd(batchPriceUnits(count));
}

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
    env.PUBLIC_ORIGIN ?? "",
    env.SIWX_SESSION_TTL_SECONDS ?? "",
  ].join("|");
}

/** SIWx session length: how long a paid wallet can re-read the same resource. */
export function siwxSessionTtlSeconds(env: Env): number {
  const parsed = parseInt(env.SIWX_SESSION_TTL_SECONDS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600;
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

  // SIWx sessions: a settled payment lets the same wallet re-read the same
  // resource without paying again (KV-backed, TTL-bound). Only routes that
  // declare the sign-in-with-x extension participate.
  server.registerExtension(
    createSIWxResourceServerExtension({
      storage: new KVSIWxStorage(env.TOKEN_CACHE, siwxSessionTtlSeconds(env)),
      origin: env.PUBLIC_ORIGIN ?? "http://localhost:8787",
    }),
  );

  cachedServer = server;
  cachedServerKey = key;
  return server;
}

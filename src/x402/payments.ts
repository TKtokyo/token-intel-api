import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { PERMIT2_ADDRESS } from "@x402/evm";
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

// ─── Settlement asset payment requirements ─────────────────────────────────

interface SettlementAssetBase {
  address: string;
  symbol: string;
  /** Human-readable network label for docs/manifest text. */
  networkLabel: string;
}

// Discriminated on `scheme` so buildAccepts can narrow: exact requires the
// EIP-712 domain, exact-permit2-v2 must not carry one.
type SettlementAssetInfo =
  | (SettlementAssetBase & {
      scheme: "exact";
      eip712: { name: string; version: string };
    })
  | (SettlementAssetBase & { scheme: "exact-permit2-v2" });

// Settlement asset metadata per supported network. All assets here use
// 6 decimals (USDC and USDG alike), so the shared base-unit math holds.
// Values must match what the scheme implementations resolve, so the
// manifest's accepts[] is byte-identical to the middleware-emitted
// PAYMENT-REQUIRED payload.
const ASSET_BY_NETWORK: Record<string, SettlementAssetInfo> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    scheme: "exact",
    networkLabel: "Base mainnet",
    eip712: { name: "USD Coin", version: "2" },
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    symbol: "USDC",
    scheme: "exact",
    networkLabel: "Base Sepolia testnet",
    eip712: { name: "USDC", version: "2" },
  },
  // Robinhood Chain settles in USDG (Global Dollar, Paxos) via the Canopy
  // facilitator's exact-permit2-v2 scheme — there is no native USDC on 4663.
  "eip155:4663": {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    symbol: "USDG",
    scheme: "exact-permit2-v2",
    networkLabel: "Robinhood Chain",
  },
};

function assetForNetwork(network: string): SettlementAssetInfo {
  const asset = ASSET_BY_NETWORK[network];
  if (!asset) {
    throw new Error(`Unsupported X402_NETWORK: ${network}`);
  }
  return asset;
}

/** x402 scheme name for the deployment's network ("exact" on Base). */
export function paymentScheme(env: Env): "exact" | "exact-permit2-v2" {
  return assetForNetwork(env.X402_NETWORK).scheme;
}

// The docs helpers below never throw: a misconfigured X402_NETWORK should
// break the paid routes (buildAccepts throws there), not take down the
// unprotected discovery surface (/, /llms.txt, /openapi.json) with it.

/** e.g. "Base mainnet (USDC)" / "Robinhood Chain (USDG)" — for docs text. */
export function settlementLabel(env: Env): string {
  const asset = ASSET_BY_NETWORK[env.X402_NETWORK];
  return asset ? `${asset.networkLabel} (${asset.symbol})` : env.X402_NETWORK;
}

/** Settlement currency ticker for the deployment ("USDC" or "USDG"). */
export function settlementSymbol(env: Env): string {
  return ASSET_BY_NETWORK[env.X402_NETWORK]?.symbol ?? "USD";
}

// "$0.020" -> "20000" (USDC/USDG have 6 decimals). BigInt-based, no float drift.
export function usdToUsdcBaseUnits(price: string): string {
  const match = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(price);
  if (!match) throw new Error(`Invalid price format: ${price}`);
  const whole = BigInt(match[1]);
  const frac = (match[2] ?? "").padEnd(6, "0");
  return (whole * 1_000_000n + BigInt(frac || "0")).toString();
}

// ─── Canopy exact-permit2-v2 scheme (Robinhood Chain) ──────────────────────
//
// Canopy (facilitator.canopyfinance.io) settles USDG on eip155:4663 with its
// own x402 v2 scheme, "exact-permit2-v2": the buyer signs a Permit2
// PermitWitnessTransferFrom whose witness binds the recipient and a bytes32
// serviceId issued by Canopy's Discovery registration. Constants below mirror
// the facilitator's /supported response; validateFacilitatorSupport flags
// drift at initialize() time.

const CANOPY_PERMIT2_EXTRA = {
  // Canonical Permit2 — imported from @x402/evm so it cannot typo-drift.
  permit2: PERMIT2_ADDRESS,
  spender: "0x43A047aE20bd92eD3a37610062b48Dc314fD17Ff",
  // Single source of truth for the USDG address is ASSET_BY_NETWORK.
  asset: ASSET_BY_NETWORK["eip155:4663"].address,
  schemeVersion: 2,
  payloadVersion: 2,
  serviceIdRequired: true,
  witnessTypeString:
    "X402Witness witness)TokenPermissions(address token,uint256 amount)X402Witness(address to,bytes32 serviceId)",
} as const;

/** extra{} for exact-permit2-v2 accepts: Canopy constants + our serviceId. */
function canopyExtra(serviceId: string | undefined): Record<string, unknown> {
  return {
    ...CANOPY_PERMIT2_EXTRA,
    // Issued by Canopy's POST /discovery/register after it verifies our 402.
    // Payments cannot verify without it; deploy → register → set → redeploy.
    ...(serviceId ? { serviceId } : {}),
  };
}

class CanopyPermit2Scheme implements SchemeNetworkServer {
  readonly scheme = "exact-permit2-v2";

  // Only the prebuilt extra{} is retained — not Env — so the per-isolate
  // cached resource server doesn't pin unrelated secrets.
  constructor(private readonly extra: Record<string, unknown>) {}

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null) {
      const candidate = price as Partial<AssetAmount>;
      if (
        typeof candidate.amount !== "string" ||
        typeof candidate.asset !== "string"
      ) {
        throw new Error(
          `exact-permit2-v2 object price must have string amount and asset: ${JSON.stringify(price)}`,
        );
      }
      return candidate as AssetAmount;
    }
    if (typeof price !== "string") {
      throw new Error(
        `exact-permit2-v2 price must be a "$x.xx" string or AssetAmount, got: ${typeof price}`,
      );
    }
    // usdToUsdcBaseUnits validates the "$x.xx" format and throws otherwise.
    return {
      amount: usdToUsdcBaseUnits(price),
      asset: assetForNetwork(network).address,
    };
  }

  getAssetDecimals(_asset: string, _network: Network): number {
    // USDG uses 6 decimals, matching the base-unit math in this module.
    return 6;
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    // Pinned constants spread LAST so route config or SDK-seeded extra can
    // never override serviceId/spender/permit2 — keeping the middleware's
    // accepts[] byte-identical to buildAccepts (which emits the same object).
    return {
      ...requirements,
      extra: { ...requirements.extra, ...this.extra },
    };
  }

  validateFacilitatorSupport(
    _network: Network,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): string | void {
    const extra = (supportedKind.extra ?? {}) as Record<string, unknown>;
    for (const key of ["permit2", "spender", "asset"] as const) {
      const advertised = extra[key];
      if (
        typeof advertised === "string" &&
        advertised.toLowerCase() !== CANOPY_PERMIT2_EXTRA[key].toLowerCase()
      ) {
        return `Canopy /supported ${key} (${advertised}) differs from pinned constant (${CANOPY_PERMIT2_EXTRA[key]}) — update CANOPY_PERMIT2_EXTRA.`;
      }
    }
  }
}

export interface PaymentRequirement {
  scheme: "exact" | "exact-permit2-v2";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export function buildAccepts(price: string, env: Env): PaymentRequirement[] {
  const asset = assetForNetwork(env.X402_NETWORK);
  return [
    {
      scheme: asset.scheme,
      network: env.X402_NETWORK,
      amount: usdToUsdcBaseUnits(price),
      asset: asset.address,
      payTo: env.PAY_TO_ADDRESS,
      maxTimeoutSeconds: 300,
      // The union discriminates on scheme, so each branch narrows to the
      // fields its scheme requires — no non-null assertions.
      extra:
        asset.scheme === "exact-permit2-v2"
          ? canopyExtra(env.CANOPY_SERVICE_ID)
          : { name: asset.eip712.name, version: asset.eip712.version },
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
    // Secret included so a rotation with an unchanged key ID doesn't leave
    // long-lived isolates holding a stale facilitator client (auth failures).
    // The key stays in isolate memory only and is never logged.
    env.CDP_API_KEY_SECRET ?? "",
    env.CANOPY_SERVICE_ID ?? "",
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
  // Networks that settle via Canopy's scheme (not exact/EIP-3009) get the
  // Canopy implementation registered for this deployment's network only.
  // An exact-network registration wins over the eip155:* wildcard above.
  if (ASSET_BY_NETWORK[env.X402_NETWORK]?.scheme === "exact-permit2-v2") {
    server.register(
      env.X402_NETWORK as Network,
      new CanopyPermit2Scheme(canopyExtra(env.CANOPY_SERVICE_ID)),
    );
  }
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

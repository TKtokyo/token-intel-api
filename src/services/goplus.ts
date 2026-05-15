import type {
  GoPlusResponse,
  GoPlusTokenData,
  GoPlusFetchResult,
  TokenInfo,
  SecurityInfo,
  HolderInfo,
  LiquidityInfo,
  TokenIntelResponse,
  TokenSecurityResult,
} from "../types/index.js";
import { calculateRiskScore } from "./scoring.js";
import { generateSummary } from "./summary.js";
import { cacheGet, cachePut, cacheNegativePut } from "./cache.js";

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1/token_security";

/**
 * Fetch token security data from GoPlus API.
 * Handles rate limiting and errors gracefully.
 */
export async function fetchGoPlus(
  chainId: string,
  address: string,
  apiKey?: string,
): Promise<GoPlusFetchResult> {
  const url = `${GOPLUS_BASE}/${chainId}?contract_addresses=${address}`;

  const headers: Record<string, string> = {};
  if (apiKey && apiKey !== "placeholder") {
    headers["Authorization"] = apiKey;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    return {
      status: "error",
      httpStatus: 0,
      message: err instanceof Error ? err.message : "Network error",
    };
  }

  if (response.status === 429) {
    return { status: "rate_limited", retryAfter: 30 };
  }

  if (!response.ok) {
    return { status: "error", httpStatus: response.status };
  }

  const body = (await response.json()) as GoPlusResponse;

  if (body.code !== 1) {
    return {
      status: "error",
      httpStatus: response.status,
      message: body.message || "GoPlus returned non-OK code",
    };
  }

  // GoPlus returns result keyed by lowercase address
  const tokenData = body.result[address.toLowerCase()];
  if (!tokenData || Object.keys(tokenData).length === 0) {
    return { status: "not_found" };
  }

  return { status: "ok", data: tokenData };
}

// --- Field mapping helpers ---

/** Convert GoPlus "0"/"1" string to boolean, null if field missing */
function flag(value: string | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  return value === "1";
}

/** Parse token info from GoPlus data */
export function mapTokenInfo(
  data: GoPlusTokenData,
  chainId: string,
  address: string,
): TokenInfo {
  return {
    name: data.token_name || "Unknown",
    symbol: data.token_symbol || "???",
    chain_id: chainId,
    address,
    total_supply: data.total_supply || "0",
  };
}

/** Parse security flags from GoPlus data */
export function mapSecurityInfo(data: GoPlusTokenData): SecurityInfo {
  return {
    is_honeypot: flag(data.is_honeypot),
    is_open_source: flag(data.is_open_source),
    is_proxy: flag(data.is_proxy),
    is_mintable: flag(data.is_mintable),
    can_take_back_ownership: flag(data.can_take_back_ownership),
    owner_change_balance: flag(data.owner_change_balance),
    hidden_owner: flag(data.hidden_owner),
    selfdestruct: flag(data.selfdestruct),
    external_call: flag(data.external_call),
    buy_tax: data.buy_tax ?? null,
    sell_tax: data.sell_tax ?? null,
    is_blacklisted: flag(data.is_blacklisted),
    is_whitelisted: flag(data.is_whitelisted),
    is_anti_whale: flag(data.is_anti_whale),
    trading_cooldown: flag(data.trading_cooldown),
  };
}

/** Calculate top 10 holder percentage from holders array */
function calcTop10Percentage(
  holders: GoPlusTokenData["holders"],
): string | null {
  if (!holders || holders.length === 0) return null;
  const top10 = holders.slice(0, 10);
  const total = top10.reduce((sum, h) => sum + parseFloat(h.percent || "0"), 0);
  return (total * 100).toFixed(1);
}

/** Check if any LP is locked */
function isAnyLpLocked(data: GoPlusTokenData): boolean {
  if (!data.holders) return false;
  // Some LP holders have is_locked=1
  return data.holders.some((h) => h.is_locked === 1);
}

/** Parse holder info from GoPlus data */
export function mapHolderInfo(data: GoPlusTokenData): HolderInfo {
  return {
    holder_count: parseInt(data.holder_count || "0", 10),
    top10_percentage: calcTop10Percentage(data.holders),
    creator_percentage: data.creator_percent || "0.0",
    lp_holder_count: parseInt(data.lp_holder_count || "0", 10),
  };
}

/** Parse liquidity info from GoPlus data */
export function mapLiquidityInfo(data: GoPlusTokenData): LiquidityInfo {
  const dexList = (data.dex || [])
    .map((d) => ({
      name: d.name || "Unknown DEX",
      liquidity: d.liquidity || "0",
      pair: d.pair || "",
    }))
    .sort((a, b) => parseFloat(b.liquidity) - parseFloat(a.liquidity))
    .slice(0, 5); // Top 5 by liquidity

  return {
    is_in_dex: data.is_in_dex === "1",
    dex: dexList,
    lp_total_supply: data.lp_total_supply || "0",
    is_lp_locked: isAnyLpLocked(data),
  };
}

/**
 * Full pipeline: cache check → GoPlus fetch → map → score → summarize → cache write.
 * Shared by single GET and batch POST endpoints.
 */
export async function fetchTokenSecurity(
  chainId: string,
  address: string,
  apiKey: string | undefined,
  kv: KVNamespace,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<TokenSecurityResult> {
  const normalizedAddress = address.toLowerCase();

  // --- Cache read ---
  const cached = await cacheGet(kv, chainId, normalizedAddress);
  if (cached.hit) {
    if ("negative" in cached) {
      return { status: "rate_limited" };
    }
    return {
      status: "success",
      data: { ...cached.entry.data, cached: true, data_age_seconds: cached.ageSeconds },
    };
  }

  // --- Fetch from GoPlus ---
  const result = await fetchGoPlus(chainId, normalizedAddress, apiKey);

  if (result.status === "rate_limited") {
    await cacheNegativePut(kv, chainId, normalizedAddress, "rate_limited");
    return { status: "rate_limited" };
  }

  if (result.status === "error") {
    if (result.httpStatus >= 500 || result.httpStatus === 0) {
      await cacheNegativePut(kv, chainId, normalizedAddress, `error_${result.httpStatus}`);
    }
    return { status: "error", message: result.message || "upstream_unavailable" };
  }

  if (result.status === "not_found") {
    return { status: "not_found" };
  }

  // --- Build response ---
  const data = result.data;
  const token = mapTokenInfo(data, chainId, normalizedAddress);
  const security = mapSecurityInfo(data);
  const holders = mapHolderInfo(data);
  const liquidity = mapLiquidityInfo(data);
  const { score, level, factors } = calculateRiskScore(data);
  const summary = generateSummary(score, level, factors, data);

  const response: TokenIntelResponse = {
    token,
    security,
    holders,
    liquidity,
    risk_score: score,
    risk_level: level,
    summary,
    cached: false,
    data_age_seconds: 0,
  };

  // --- Cache write (non-blocking if waitUntil provided) ---
  const cachePromise = cachePut(kv, chainId, normalizedAddress, response);
  if (waitUntil) {
    waitUntil(cachePromise);
  } else {
    await cachePromise;
  }

  return { status: "success", data: response };
}

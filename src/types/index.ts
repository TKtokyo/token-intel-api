export interface Env {
  FACILITATOR_URL: string;
  X402_NETWORK: string;
  PAY_TO_ADDRESS: string;
  GOPLUS_API_KEY: string;
  TOKEN_CACHE: KVNamespace;
  // CDP keys for mainnet facilitator (optional, testnet needs no auth)
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  DISABLE_PAYWALL?: string;
  // Public browser-visible origin, used for SIWx domain/URI binding.
  // Falls back to http://localhost:8787 for local dev.
  PUBLIC_ORIGIN?: string;
  // SIWx session length in seconds (default 3600): how long a wallet that
  // paid for a resource can re-read it without paying again.
  SIWX_SESSION_TTL_SECONDS?: string;
}

// --- GoPlus API types ---

/** Raw GoPlus token_security response fields (all strings) */
export interface GoPlusTokenData {
  token_name?: string;
  token_symbol?: string;
  total_supply?: string;
  holder_count?: string;
  creator_address?: string;
  creator_percent?: string;

  // Security flags ("0" = false, "1" = true)
  is_honeypot?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  hidden_owner?: string;
  can_take_back_ownership?: string;
  selfdestruct?: string;
  external_call?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  is_anti_whale?: string;
  owner_change_balance?: string;
  trading_cooldown?: string;

  // Tax
  buy_tax?: string;
  sell_tax?: string;

  // DEX / Liquidity
  is_in_dex?: string;
  dex?: Array<{
    name?: string;
    liquidity?: string;
    pair?: string;
  }>;
  lp_total_supply?: string;
  lp_holder_count?: string;

  // Holders
  holders?: Array<{
    address?: string;
    balance?: string;
    percent?: string;
    is_locked?: number;
    tag?: string;
    is_contract?: number;
  }>;

  // Other
  trust_list?: string;
}

export interface GoPlusResponse {
  code: number;
  message: string;
  result: Record<string, GoPlusTokenData>;
}

export type GoPlusFetchResult =
  | { status: "ok"; data: GoPlusTokenData }
  | { status: "not_found" }
  | { status: "rate_limited"; retryAfter: number }
  | { status: "error"; httpStatus: number; message?: string };

// --- Scoring types ---

export interface ScoringResult {
  score: number;
  level: "CRITICAL" | "HIGH" | "MODERATE" | "LOW";
  factors: string[];
}

// --- API response types ---

export interface TokenInfo {
  name: string;
  symbol: string;
  chain_id: string;
  address: string;
  total_supply: string;
}

export interface SecurityInfo {
  is_honeypot: boolean | null;
  is_open_source: boolean | null;
  is_proxy: boolean | null;
  is_mintable: boolean | null;
  can_take_back_ownership: boolean | null;
  owner_change_balance: boolean | null;
  hidden_owner: boolean | null;
  selfdestruct: boolean | null;
  external_call: boolean | null;
  buy_tax: string | null;
  sell_tax: string | null;
  is_blacklisted: boolean | null;
  is_whitelisted: boolean | null;
  is_anti_whale: boolean | null;
  trading_cooldown: boolean | null;
}

export interface HolderInfo {
  holder_count: number;
  top10_percentage: string | null;
  creator_percentage: string;
  lp_holder_count: number;
}

export interface DexInfo {
  name: string;
  liquidity: string;
  pair: string;
}

export interface LiquidityInfo {
  is_in_dex: boolean;
  dex: DexInfo[];
  lp_total_supply: string;
  is_lp_locked: boolean;
}

export interface TokenIntelResponse {
  token: TokenInfo;
  security: SecurityInfo;
  holders: HolderInfo;
  liquidity: LiquidityInfo;
  risk_score: number;
  risk_level: string;
  summary: string;
  cached: boolean;
  data_age_seconds: number;
}

// --- Batch endpoint types ---

export interface BatchTokenRequest {
  chainId: string;
  address: string;
}

export interface BatchRequestBody {
  tokens: BatchTokenRequest[];
}

export type BatchItemStatus = "success" | "not_found" | "error";

export interface BatchItemResult {
  chainId: string;
  address: string;
  status: BatchItemStatus;
  data?: TokenIntelResponse;
  error?: string;
}

export interface BatchResponse {
  results: BatchItemResult[];
  total: number;
  succeeded: number;
  failed: number;
  partial: boolean;
}

// --- Shared fetch result for fetchTokenSecurity ---

export type TokenSecurityResult =
  | { status: "success"; data: TokenIntelResponse }
  | { status: "not_found" }
  | { status: "rate_limited" }
  | { status: "error"; message: string };

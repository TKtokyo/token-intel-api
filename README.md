# Token Intelligence API

x402-powered paid API that returns security analysis, deterministic risk scores, and natural language summaries for any EVM token.

**Live (mainnet):** `https://token-intel-api.tatsu77.workers.dev`

## How It Works

```
Client → GET /api/v1/token/{chainId}/{address}
       ← 402 Payment Required (USDC via x402)
       → Payment header + retry
       ← 200 { token, security, risk_score, summary, ... }
```

One HTTP request, one microtransaction ($0.005 USDC), one structured response.

## API

### `GET /api/v1/token/{chainId}/{address}`

**Payment:** $0.005 USDC via x402 protocol on Base mainnet

**Path parameters:**
| Parameter | Description |
|---|---|
| `chainId` | `1` (Ethereum) or `8453` (Base) |
| `address` | ERC-20 token contract address |

**Response (200):**

```json
{
  "token": {
    "name": "Pepe",
    "symbol": "PEPE",
    "chain_id": "1",
    "address": "0x6982508145454ce325ddbe47a25d4ec3d2311933",
    "total_supply": "420690000000000000000000000000000"
  },
  "security": {
    "is_honeypot": false,
    "is_open_source": true,
    "is_proxy": false,
    "is_mintable": false,
    "hidden_owner": false,
    "selfdestruct": false,
    "external_call": false,
    "buy_tax": "0",
    "sell_tax": "0"
  },
  "holders": {
    "holder_count": 320000,
    "top10_percentage": "0.0",
    "creator_percentage": "0.0",
    "lp_holder_count": 500
  },
  "liquidity": {
    "is_in_dex": true,
    "dex": [
      { "name": "UniswapV2", "liquidity": "13000000", "pair": "0x..." }
    ],
    "lp_total_supply": "...",
    "is_lp_locked": false
  },
  "risk_score": 85,
  "risk_level": "LOW",
  "summary": "LOW risk. Contract is open source, verified. Top 10 holders control 0.0%. $13.0M in UniswapV2 pool.",
  "cached": false,
  "data_age_seconds": 0
}
```

**Error responses:**

| Status | Error | Description |
|---|---|---|
| 400 | `invalid_address` | Invalid contract address format |
| 402 | Payment Required | x402 payment needed |
| 404 | `token_not_found` | No data for this token |
| 429 | `upstream_throttled` | GoPlus rate limited (retry in 30s) |
| 503 | `upstream_unavailable` | GoPlus API down |

### `POST /api/v1/tokens`

Batch analysis of up to 10 EVM tokens in a single request.

**Payment:** $0.020 USDC via x402 protocol on Base mainnet

**Request body:**

```json
{
  "tokens": [
    { "chainId": "1", "address": "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
    { "chainId": "8453", "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
  ]
}
```

| Field | Constraint |
|---|---|
| `tokens` | Array of 1–10 token entries |
| `tokens[].chainId` | `1` (Ethereum) or `8453` (Base) |
| `tokens[].address` | ERC-20 contract address (`^0x[a-fA-F0-9]{40}$`) |

Internally each token is analysed concurrently (parallelism 3) under an 8-second deadline. Each result carries an independent status so a partial failure does not fail the whole batch.

**Response (200):**

```json
{
  "results": [
    { "chainId": "1", "address": "0x6982...", "status": "success", "data": { /* same shape as GET /token */ } },
    { "chainId": "8453", "address": "0x8335...", "status": "not_found", "error": "No security data available for this token." }
  ],
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "partial": true
}
```

Per-item `status` is one of `success`, `not_found`, `error`. Top-level status codes: `200` (full or partial success — inspect per-item status), `400` (invalid body), `402` (payment required).

### `GET /health`

Returns `{ "status": "ok", "version": "0.2.0" }`. No payment required.

### `GET /.well-known/x402` / `GET /openapi.json` / `GET /llms.txt`

Free discovery endpoints. The x402 manifest emits the standard `resources[]` array (DiscoveryResource schema) so x402scan and other bazaar consumers can register both paid endpoints.

## Risk Scoring

Deterministic 100-point scale:

| Severity | Deduction | Flags |
|---|---|---|
| CRITICAL | Score = 0 | Honeypot |
| SEVERE | -30 each | Mintable, hidden owner, ownership reclaimable, self-destruct |
| HIGH | -20 each | Tax > 10%, proxy contract |
| MODERATE | -10 each | Not open source, external calls, blacklist function |
| LOW | -5 each | Holder count < 100 |

Risk levels: **CRITICAL** (0-25) / **HIGH** (26-50) / **MODERATE** (51-75) / **LOW** (76-100)

## Quick Start (Client)

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const publicClient = createPublicClient({ chain: base, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPay(
  "https://token-intel-api.tatsu77.workers.dev/api/v1/token/1/0x6982508145454Ce325dDbE47a25d4ec3d2311933"
);
const data = await res.json();
console.log(data.risk_score, data.risk_level, data.summary);
```

**Prerequisites:** USDC on Base mainnet in the signing account (any standard onramp / bridge). The signer also needs a small amount of ETH on Base to ensure transactions can be processed.

## Development

```bash
# Install
npm install

# Local dev (uses .dev.vars for secrets)
npm run dev

# Run E2E tests
PRIVATE_KEY=0x... npx tsx test/client.ts

# Deploy (testnet)
npx wrangler deploy

# Deploy (mainnet, requires CDP keys)
npx wrangler deploy --env production
```

### Environment Variables

| Variable | Where | Description |
|---|---|---|
| `PAY_TO_ADDRESS` | Wrangler secret | EOA address to receive USDC |
| `GOPLUS_API_KEY` | Wrangler secret | GoPlus API key |
| `CDP_API_KEY_ID` | Wrangler secret (production) | Coinbase Developer Platform key ID |
| `CDP_API_KEY_SECRET` | Wrangler secret (production) | CDP key secret |

## Architecture

```
Cloudflare Workers (Hono)
  ├── x402 Payment Middleware (@x402/hono)
  ├── Bazaar Discovery Extension (@x402/extensions/bazaar)
  ├── Cache Layer (Cloudflare KV, 5min TTL)
  ├── GoPlus Security API (upstream data)
  ├── Deterministic Risk Scoring (rule-based)
  └── Template Summary Generator (GPU-free)
```

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Framework:** Hono
- **Payment:** x402 protocol (USDC on Base)
- **Data:** GoPlus Security API
- **Cache:** Cloudflare KV

## License

MIT

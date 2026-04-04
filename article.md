---
title: "x402で有料APIを作ってみた：トークンセキュリティ分析APIの実装記録"
emoji: "💰"
type: "tech"
topics: ["x402", "cloudflare", "web3", "typescript", "hono"]
published: false
---

# x402で有料APIを作ってみた：トークンセキュリティ分析APIの実装記録

## はじめに

HTTP 402 Payment Required——1997年にHTTP仕様に予約されながら、30年近く「将来のために」と放置されていたステータスコード。それを2025年にCoinbaseが「x402」として復活させた。

x402は、HTTPリクエストの中でステーブルコイン（USDC）の支払いを完結させるオープンプロトコルだ。クライアントがAPIにリクエストすると402が返り、支払い条件がJSONで提示される。クライアントが支払いヘッダーを付けてリトライすれば、リソースが返る。**サブスクリプション不要、アカウント登録不要、APIキー不要。**

この記事では、x402を使って**実際に課金できるAPIを1から構築してCloudflare Workersにデプロイした**過程を、コード・SDK のハマりどころ・テスト結果とともに記録する。

### 作ったもの

**Token Intelligence API** — 任意のEVMトークン（Ethereum / Base）のコントラクトアドレスを投げると、セキュリティ分析 + リスクスコア + 自然言語サマリーを返す有料API。

```
GET /api/v1/token/1/0x6982508145454Ce325dDbE47a25d4ec3d2311933
→ 402 Payment Required (USDC $0.005)
→ 支払い → リトライ
→ 200 { risk_score: 85, risk_level: "LOW", summary: "LOW risk. Contract is open source..." }
```

1リクエスト $0.005。変動費ゼロ（Cloudflare Workers + GoPlus無料枠）なので粗利率100%。

**ライブURL（Base mainnet）：** `https://token-intel-api.tatsu77.workers.dev`

---

## 技術スタック

| レイヤー | 技術 |
|---|---|
| ランタイム | Cloudflare Workers |
| フレームワーク | Hono |
| 決済 | x402 (USDC on Base) |
| セキュリティデータ | GoPlus Security API |
| キャッシュ | Cloudflare KV |
| 言語 | TypeScript |

---

## x402の仕組み（3行で）

1. サーバーが保護ルートに `paymentMiddleware` を挟む
2. クライアントが来ると402 + 支払い条件（金額、ネットワーク、受取アドレス）をBase64で返す
3. クライアントSDK（`@x402/fetch`）が自動で支払いを署名・送信し、リトライ→200が返る

**サーバー側は秘密鍵を持たない。** 受取アドレス（EOA）を設定するだけ。支払いの検証と決済はCoinbaseの「Facilitator」サービスが代行する。

---

## 実装：ステップバイステップ

### 1. プロジェクト初期化

```bash
mkdir token-intel-api && cd token-intel-api
npm init -y
npm install hono@4.7.6 @x402/hono@2.4.0 @x402/core@2.4.0 \
  @x402/evm@2.4.0 @x402/extensions@2.4.0 viem@2.23.2 \
  @coinbase/x402@2.1.0 --save-exact
npm install -D wrangler@3.109.2 @x402/fetch@2.4.0 tsx typescript \
  @cloudflare/workers-types --save-exact
```

**重要：** x402パッケージは `^` を使わず完全固定。破壊的変更でミドルウェアが壊れるリスクを排除。

### 2. x402ミドルウェア設定

```typescript
// src/index.ts
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";

app.use("/api/v1/*", async (c, next) => {
  const facilitatorClient = new HTTPFacilitatorClient({
    url: c.env.FACILITATOR_URL,
  });
  const server = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(server);

  const routes: RoutesConfig = {
    "GET /api/v1/token/*/*": {
      accepts: {
        scheme: "exact",
        network: "eip155:8453",  // Base mainnet
        price: "$0.005",
        payTo: c.env.PAY_TO_ADDRESS as `0x${string}`,
      },
      resource: "Token Intelligence Report",
      description: "Security analysis + risk score for any EVM token",
    },
  };

  const middleware = paymentMiddleware(routes, server);
  return middleware(c, next);
});
```

これだけで、`/api/v1/*` 以下のルートがすべて有料になる。未払いリクエストには自動で402が返る。

### 3. GoPlus連携 + リスクスコアリング

GoPlus Security APIからトークンのセキュリティデータを取得し、決定論的にスコアリングする。

```typescript
// スコアリングの核心部分
export function calculateRiskScore(data: GoPlusTokenData): ScoringResult {
  let score = 100;
  const factors: string[] = [];

  // ハニーポット → 即座に0点
  if (data.is_honeypot === "1") {
    return { score: 0, level: "CRITICAL", factors: ["Honeypot detected"] };
  }

  // SEVERE (-30): ミント可能、隠しオーナー、自己破壊
  if (data.is_mintable === "1") { score -= 30; factors.push("Mintable token"); }
  if (data.hidden_owner === "1") { score -= 30; factors.push("Hidden owner"); }

  // HIGH (-20): 高税率、プロキシコントラクト
  if (parseFloat(data.sell_tax || "0") > 0.1) { score -= 20; /* ... */ }
  if (data.is_proxy === "1") { score -= 20; factors.push("Proxy contract"); }

  // フィールドが存在しない → ルールをスキップ（スコアに影響しない）
  // ... 省略 ...

  return { score, level, factors };
}
```

### 4. キャッシュ戦略

Cloudflare KVを使って2種類のキャッシュを実装。

```typescript
// 正のキャッシュ: 5分（同じトークンの再リクエストを高速化）
await kv.put(key, JSON.stringify(entry), { expirationTtl: 300 });

// 負のキャッシュ: 30秒（GoPlus 429/5xx時の連打防止）
await kv.put(key, JSON.stringify({ status: "degraded" }), { expirationTtl: 30 });
```

書き込みは `c.executionCtx.waitUntil()` でノンブロッキング化。レスポンス返却後にバックグラウンドで実行される。

---

## x402 SDKのハマりどころ（実装で発見した差異）

ドキュメントやサンプルコードと実際のSDK v2.4.0の間にいくつかの差異があった。これが本記事の一番の価値だと思う。

### 1. ルートパターンはワイルドカード形式

```typescript
// NG: Express風のパラメータは認識されない
"GET /api/v1/token/:chainId/:address"

// OK: ワイルドカード（*）を使う
"GET /api/v1/token/*/*"
```

x402の内部関数 `parseRoutePattern` はExpress風の `:param` をリテラル文字として扱う。つまり `/token/:chainId` は `/token/:chainId` という文字列にしかマッチしない。

**症状：** 402が返らずに素通りして200になる（ミドルウェアがルートにマッチしない）。

### 2. `price` であって `amount` ではない

```typescript
// NG: 設計書やサンプルにあった形式
accepts: { amount: "5000", ... }

// OK: 実際のSDK
accepts: { price: "$0.005", ... }
```

`price` の型は `Price = Money | AssetAmount` で、`Money = string | number`。`"$0.005"` のようにドル表記が使える。

**症状：** `Cannot read properties of undefined (reading 'replace')` で500エラー。

### 3. `resource` / `description` はRouteConfigの直下

```typescript
// NG: accepts（PaymentOption）の中
accepts: { resource: "...", description: "...", ... }

// OK: RouteConfigの直下
{
  accepts: { scheme: "exact", ... },
  resource: "Token Intelligence Report",
  description: "Security analysis + risk score",
}
```

### 4. RoutesConfig の import 先

```typescript
// NG: @x402/hono は RoutesConfig を re-export していない
import type { RoutesConfig } from "@x402/hono";

// OK: @x402/core/server から直接import
import type { RoutesConfig } from "@x402/core/server";
```

### 5. Cloudflare Workers での環境変数アクセス

Workers では `process.env` が使えない。環境変数はリクエストコンテキスト (`c.env`) 経由でアクセスする必要がある。

```typescript
// x402ミドルウェアをハンドラー内で毎回初期化する
app.use("/api/v1/*", async (c, next) => {
  // c.env はここで初めて利用可能
  const facilitatorClient = new HTTPFacilitatorClient({
    url: c.env.FACILITATOR_URL,
  });
  // ...
});
```

---

## テスト結果

デプロイ済みWorkerに対するE2Eテスト結果：

| テストケース | 期待 | 結果 | 時間 |
|---|---|---|---|
| USDC (Ethereum) | 200 + score >= 50 | 75/MODERATE | 3.8s |
| PEPE (Ethereum) | 200 + score >= 50 | 85/LOW | 3.3s |
| ハニーポット (DokiDokiAzuki) | 200 + score = 0, CRITICAL | 0/CRITICAL | 3.1s |
| 存在しないトークン | 404 | 404 | 1.4s |
| USDC 再リクエスト | cached: true | true (age: 10s) | 2.6s |

**5/5合格。** ハニーポットが正しく0点になり、キャッシュも機能している。

レイテンシの内訳（キャッシュミス時）：
- x402支払い検証: ~1.5s
- KV読み取り: ~5ms
- GoPlus API: ~1.0s
- **合計: ~3.0-3.5s**

---

## Bazaar（サービスディスカバリ）

x402にはBazaarというサービスディスカバリ機能がある。ルート設定にメタデータを宣言すると、Facilitatorが支払い処理時に自動的にカタログに登録する。

```typescript
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

server.registerExtension(bazaarResourceServerExtension);

const routes = {
  "GET /api/v1/token/*/*": {
    accepts: { /* ... */ },
    extensions: {
      ...declareDiscoveryExtension({
        input: { chainId: "1", address: "0x..." },
        inputSchema: {
          properties: {
            chainId: { type: "string", enum: ["1", "8453"] },
            address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          },
        },
        output: {
          example: { risk_score: 80, risk_level: "LOW", /* ... */ },
        },
      }),
    },
  },
};
```

**注意：** 設計書にあった `discoverable: true` や `category` / `tags` フィールドはSDK v2.4.0には存在しない。代わりに `extensions` フィールドと `declareDiscoveryExtension()` を使う。

---

## メインネット構成

本番環境はBase mainnetで稼働している。`@coinbase/x402` パッケージが提供する `createFacilitatorConfig` でCDP Facilitatorに接続する。

```typescript
import { createFacilitatorConfig } from "@coinbase/x402";

// CDP API キーでメインネット facilitator を使う
if (c.env.CDP_API_KEY_ID && c.env.CDP_API_KEY_SECRET) {
  facilitatorConfig = createFacilitatorConfig(
    c.env.CDP_API_KEY_ID,
    c.env.CDP_API_KEY_SECRET,
  );
} else {
  // フォールバック（テスト用）
  facilitatorConfig = { url: c.env.FACILITATOR_URL };
}
```

`wrangler.toml` で環境を分離：

```toml
# デフォルト: production（Base mainnet）
[vars]
FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"
X402_NETWORK = "eip155:8453"

# テスト用（Base Sepolia）
[env.testnet.vars]
FACILITATOR_URL = "https://www.x402.org/facilitator"
X402_NETWORK = "eip155:84532"
```

---

## コスト構造

| 項目 | コスト |
|---|---|
| Cloudflare Workers | $0（無料枠: 10万req/日） |
| Cloudflare KV | $0（無料枠: 10万読み取り/日） |
| GoPlus API | $0（無料枠） |
| **合計** | **$0** |
| **x402収益/req** | **$0.005** |
| **粗利率** | **100%** |

サーバーレス + 無料API + x402 = **変動費ゼロの有料API**。赤字になる構造が存在しない。

---

## 学んだこと

### x402の良い点

- **導入の手軽さ：** ミドルウェア1つでAPIを有料化できる
- **サーバー側の秘密鍵管理不要：** 受取アドレスだけ設定すればFacilitatorが決済処理
- **テストネットも利用可能：** Base Sepolia + Circle Faucetで無料テスト可能
- **SDK がTypeScript完備：** サーバー側もクライアント側も型安全

### 改善の余地

- **ドキュメントとSDKの乖離：** ルートパターン、フィールド名、インポートパスなど、実際に動かすまでわからない差異が多い
- **レイテンシ：** 支払い検証に~1.5sかかる。リアルタイム性が求められるユースケースには厳しい
- **エコシステムの成熟度：** Bazaarのディスカバリは仕組みとしてはあるが、実際にカタログから見つけてもらえるかは別問題

---

## まとめ

x402は「HTTPネイティブな課金」という長年の夢を現実にしている。実装してみると、ミドルウェア1行で有料APIが作れる手軽さは本物だ。

一方で、SDKのドキュメントとの差異や、決済レイテンシなど、プロダクション利用には注意点もある。この記事がこれからx402でAPIを作る人の参考になれば幸いだ。

**リポジトリ：** [GitHub](https://github.com/TKtokyo/token-intel-api)
**ライブAPI（Base mainnet）：** `https://token-intel-api.tatsu77.workers.dev`

---

## 参考リンク

- [x402 公式ドキュメント](https://docs.cdp.coinbase.com/x402/)
- [x402 GitHub](https://github.com/coinbase/x402)
- [x402scan Explorer](https://www.x402scan.com)
- [Circle Faucet（テストUSDC）](https://faucet.circle.com)
- [GoPlus Security API](https://gopluslabs.io)

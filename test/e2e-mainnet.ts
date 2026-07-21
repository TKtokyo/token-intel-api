/**
 * Budget-conscious REAL-PAYMENT E2E against production (Base mainnet).
 *
 * Spends at most $0.008 USDC across 3 calls:
 *   1. GET  single-token analysis (PEPE)      → pays $0.005, settles on-chain
 *   2. GET  the same URL again                → expects FREE via SIWx session
 *   3. POST batch with 1 token                → pays $0.003 (dynamic pricing)
 *
 * The payer wallet may be the same address as PAY_TO_ADDRESS (self-payment):
 * USDC transferWithAuthorization allows from == to, so the balance is
 * unchanged and the facilitator covers gas (no ETH needed).
 *
 * Usage (run in YOUR terminal — never share the private key):
 *   PRIVATE_KEY=0x... npx tsx test/e2e-mainnet.ts
 *
 * Optional: API_BASE to target a different deployment.
 */
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createSIWxClientExtension } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("ERROR: Set PRIVATE_KEY env var (never share it in chat/logs)");
  console.error("  PRIVATE_KEY=0x... npx tsx test/e2e-mainnet.ts");
  process.exit(1);
}

const API_BASE =
  process.env.API_BASE || "https://token-intel-api.tatsu77.workers.dev";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";

// --- Client setup: exact EVM payment scheme + SIWx session extension ---
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: base, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const client = new x402Client();
registerExactEvmScheme(client, { signer });
client.registerExtension(createSIWxClientExtension({ signers: [account] }));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

interface SettleReceipt {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}

function decodeSettleReceipt(res: Response): SettleReceipt | null {
  const header =
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

let totalPaidUnits = 0n;
let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}: ${detail}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  console.log("=== Real-payment E2E (Base mainnet) ===");
  console.log(`API:    ${API_BASE}`);
  console.log(`Wallet: ${account.address}`);
  console.log(`Budget: $0.008 USDC max\n`);

  // --- 1. Paid single-token analysis ($0.005) ---
  console.log("--- 1. GET single (PEPE) — expect paid $0.005 ---");
  const t1 = Date.now();
  const res1 = await fetchWithPay(`${API_BASE}/api/v1/token/1/${PEPE}`);
  const data1 = (await res1.json()) as Record<string, unknown>;
  const receipt1 = decodeSettleReceipt(res1);
  console.log(`  Status: ${res1.status}  Time: ${Date.now() - t1}ms`);
  report("status 200", res1.status === 200, String(res1.status));
  report(
    "risk data",
    typeof data1.risk_score === "number" && typeof data1.summary === "string",
    `score=${data1.risk_score} level=${data1.risk_level}`,
  );
  report(
    "settled on-chain",
    receipt1?.success === true && typeof receipt1.transaction === "string",
    receipt1?.transaction
      ? `https://basescan.org/tx/${receipt1.transaction}`
      : "no PAYMENT-RESPONSE header",
  );
  if (receipt1?.success) totalPaidUnits += 5000n;

  // --- 2. SIWx re-read of the same resource — expect FREE ---
  console.log("\n--- 2. GET same URL — expect FREE via SIWx session ---");
  const t2 = Date.now();
  const res2 = await fetchWithPay(`${API_BASE}/api/v1/token/1/${PEPE}`);
  const data2 = (await res2.json()) as Record<string, unknown>;
  const receipt2 = decodeSettleReceipt(res2);
  console.log(`  Status: ${res2.status}  Time: ${Date.now() - t2}ms`);
  report("status 200", res2.status === 200, String(res2.status));
  report(
    "no settlement (free re-read)",
    receipt2 === null,
    receipt2 === null
      ? "no PAYMENT-RESPONSE header — SIWx session honored"
      : `UNEXPECTED settlement: ${receipt2.transaction}`,
  );
  report(
    "same data shape",
    typeof data2.risk_score === "number",
    `score=${data2.risk_score} cached=${data2.cached}`,
  );
  if (receipt2?.success) totalPaidUnits += 5000n;

  // --- 3. Batch with 1 token — expect paid $0.003 (dynamic price) ---
  console.log("\n--- 3. POST batch (1 token) — expect paid $0.003 ---");
  const t3 = Date.now();
  const res3 = await fetchWithPay(`${API_BASE}/api/v1/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens: [{ chainId: "1", address: PEPE }] }),
  });
  const data3 = (await res3.json()) as Record<string, unknown>;
  const receipt3 = decodeSettleReceipt(res3);
  console.log(`  Status: ${res3.status}  Time: ${Date.now() - t3}ms`);
  report("status 200", res3.status === 200, String(res3.status));
  report(
    "batch result",
    data3.total === 1 && data3.succeeded === 1,
    `total=${data3.total} ok=${data3.succeeded}`,
  );
  report(
    "settled on-chain",
    receipt3?.success === true,
    receipt3?.transaction
      ? `https://basescan.org/tx/${receipt3.transaction}`
      : "no PAYMENT-RESPONSE header",
  );
  if (receipt3?.success) totalPaidUnits += 3000n;

  // --- Summary ---
  const dollars = Number(totalPaidUnits) / 1_000_000;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  console.log(
    `Total settled: ${totalPaidUnits} units ($${dollars.toFixed(3)} USDC)` +
      (account.address ? ` — self-payment, net balance change ≈ $0` : ""),
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

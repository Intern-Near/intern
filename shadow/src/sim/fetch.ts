// node src/sim/fetch.ts [--out fixtures/sim]
//
// Fetches, once, the read-only inputs the simulation keeps as dated fixtures. Nothing is signed or sent anywhere:
// - Hyperliquid 30-minute candles for the six markets of 01 §4, with the public
//   POST https://api.hyperliquid.xyz/info {"type":"candleSnapshot"} (no key). Each raw reply is saved gzipped,
//   byte for byte, as <out>/hl-candles-<date>/<coin>-30m-<page>.json.gz, with fetch.json saying what was asked and
//   when. Hyperliquid keeps only the most recent 5000 candles (its docs), about 104 days at 30 minutes.
// - The live testnet coin's public views get_constants, get_rewards, get_pot and get_rank, and the stand-in lender's
//   get_rate, with NEAR RPC `query` / `call_function` (read-only), saved in <out>/testnet-views-<date>/, so the
//   numbers the simulation cites from 01 can be checked against the deployed contract (test/sim-rules01.test.ts).
//
// Rate limits (Hyperliquid's docs, read 2026-11-13): 1200 weight a minute per IP; candleSnapshot weighs 20 plus more
// per 60 candles returned (about 104 for 5000 candles). Six markets with a pause between calls stay well under it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { HL_INFO_URL } from "../../../runner/src/hyperliquid.ts";
import { isRecord } from "../../../runner/src/json.ts";
import { MARKETS } from "../../../runner/src/markets.ts";
import { CANDLE_MS, candleRequest, parseCandles } from "./prices.ts";

const PAUSE_MS = 3_000;
const MOST_CANDLES = 5_000;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function postText(url: string, body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: await res.text() };
}

async function fetchCandles(outDir: string, now: number): Promise<void> {
  const dir = join(outDir, `hl-candles-${new Date(now).toISOString().slice(0, 10)}`);
  mkdirSync(dir, { recursive: true });
  const url = HL_INFO_URL.mainnet;
  const requests: Record<string, unknown>[] = [];
  for (const { market, hl_name } of MARKETS) {
    let start = now - MOST_CANDLES * CANDLE_MS;
    for (let page = 0; ; page++) {
      const body = candleRequest(hl_name, start, now);
      const { status, text } = await postText(url, body);
      if (status !== 200) throw new Error(`candleSnapshot ${hl_name}: HTTP ${status}: ${text.slice(0, 200)}`);
      const candles = parseCandles(text, hl_name);
      const file = `${hl_name}-30m-${page}.json.gz`;
      writeFileSync(join(dir, file), gzipSync(Buffer.from(text, "utf8")));
      const first = candles[0];
      const last = candles[candles.length - 1];
      requests.push({
        market,
        coin: hl_name,
        page,
        request: JSON.parse(body),
        status,
        candles: candles.length,
        first_open: first ? new Date(first.t).toISOString() : null,
        last_open: last ? new Date(last.t).toISOString() : null,
        file,
      });
      console.log(`${hl_name} page ${page}: ${candles.length} candles`);
      await sleep(PAUSE_MS);
      // Hyperliquid's docs say ranged replies may be cut short; page on from the last candle until the range is done.
      if (!last || last.t + CANDLE_MS >= now || last.t < start) break;
      start = last.t + CANDLE_MS;
    }
  }
  writeJson(join(dir, "fetch.json"), {
    about:
      "Raw replies of Hyperliquid's read-only POST /info candleSnapshot, gzipped byte for byte. Read by shadow/src/sim/load.ts.",
    url,
    fetched_at: new Date(now).toISOString(),
    interval: "30m",
    docs: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint",
    requests,
  });
}

interface Deployments {
  testnet: { coin: string; lender: string; rpc: string };
}

async function view(
  rpc: string,
  account: string,
  method: string,
): Promise<{ value: unknown; block_height: number }> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: account,
      method_name: method,
      args_base64: Buffer.from("{}").toString("base64"),
    },
  });
  const { status, text } = await postText(rpc, body);
  const reply: unknown = JSON.parse(text);
  const result = isRecord(reply) && isRecord(reply.result) ? reply.result : null;
  if (status !== 200 || !result || !Array.isArray(result.result) || typeof result.block_height !== "number") {
    throw new Error(`${account} ${method}: HTTP ${status}: ${text.slice(0, 300)}`);
  }
  const bytes = Uint8Array.from(result.result as number[]);
  return { value: JSON.parse(Buffer.from(bytes).toString("utf8")), block_height: result.block_height };
}

async function fetchViews(outDir: string, now: number): Promise<void> {
  const dir = join(outDir, `testnet-views-${new Date(now).toISOString().slice(0, 10)}`);
  mkdirSync(dir, { recursive: true });
  const dep = (
    JSON.parse(
      readFileSync(new URL("../../../interface/deployments.json", import.meta.url), "utf8"),
    ) as Deployments
  ).testnet;
  const calls: [string, string][] = [
    [dep.coin, "get_constants"],
    [dep.coin, "get_rewards"],
    [dep.coin, "get_pot"],
    [dep.coin, "get_rank"],
    [dep.lender, "get_rate"],
  ];
  const saved: Record<string, unknown>[] = [];
  for (const [account, method] of calls) {
    const { value, block_height } = await view(dep.rpc, account, method);
    const file = `${account === dep.lender ? "lender-" : ""}${method}.json`;
    writeJson(join(dir, file), value);
    saved.push({ account, method, block_height, file });
    console.log(`${account} ${method}: block ${block_height}`);
  }
  writeJson(join(dir, "fetch.json"), {
    about:
      "Read-only NEAR RPC views (query, call_function, finality final) of the live testnet coin and its stand-in lender.",
    rpc: dep.rpc,
    fetched_at: new Date(now).toISOString(),
    calls: saved,
  });
}

const outDir = resolve(flag("--out") ?? "fixtures/sim");
const now = Date.now();
await fetchCandles(outDir, now);
await fetchViews(outDir, now);
console.log(`saved under ${outDir}`);

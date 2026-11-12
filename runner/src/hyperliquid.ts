import { isRecord } from "./json.ts";
import { MARKETS, type Market, type Network } from "./markets.ts";

/** Hyperliquid's read-only info endpoints. Both answered POST {"type":"meta"} on 2026-11-11. */
export const HL_INFO_URL: Readonly<Record<Network, string>> = {
  testnet: "https://api.hyperliquid-testnet.xyz/info",
  mainnet: "https://api.hyperliquid.xyz/info",
};

/** One perp market in Hyperliquid's `meta.universe`. Its position in the array is its asset index. */
export interface HlAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted: boolean;
  onlyIsolated: boolean;
}

/** Reads a `meta` object (the reply to {"type":"meta"}, or the first item of {"type":"metaAndAssetCtxs"}). */
function readMeta(data: unknown): HlAsset[] {
  if (!isRecord(data) || !Array.isArray(data.universe)) {
    throw new Error("Hyperliquid meta: no `universe` array");
  }
  return data.universe.map((a: unknown, i: number): HlAsset => {
    if (
      !isRecord(a) ||
      typeof a.name !== "string" ||
      typeof a.szDecimals !== "number" ||
      !Number.isInteger(a.szDecimals) ||
      typeof a.maxLeverage !== "number" ||
      !Number.isInteger(a.maxLeverage)
    ) {
      throw new Error(`Hyperliquid meta: asset ${i} has an unexpected shape`);
    }
    return {
      name: a.name,
      szDecimals: a.szDecimals,
      maxLeverage: a.maxLeverage,
      isDelisted: a.isDelisted === true,
      onlyIsolated: a.onlyIsolated === true,
    };
  });
}

/** Parses the body of POST /info {"type":"meta"}. Throws on any unexpected shape. */
export function parseMeta(body: string): HlAsset[] {
  return readMeta(JSON.parse(body));
}

async function postInfo(network: Network, type: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(HL_INFO_URL[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Hyperliquid ${network} /info ${type}: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return body;
}

/** Reads Hyperliquid's perp market list. Read-only. Returns the raw body too, so it can be saved as a fixture. */
export async function fetchMeta(
  network: Network,
  fetchFn: typeof fetch,
): Promise<{ body: string; assets: HlAsset[] }> {
  const body = await postInfo(network, "meta", fetchFn);
  return { body, assets: parseMeta(body) };
}

/** A price row for one of our six markets. Prices are Hyperliquid's own decimal strings, untouched. */
export interface PriceRow {
  market: Market;
  hl_name: string;
  /** Mark price in USD. For kSHIB and kPEPE it is per 1,000 coins. */
  mark_px: string;
  /** Price 24 hours ago, same unit. */
  prev_day_px: string;
  /** The highest leverage Hyperliquid allows on this market. */
  max_leverage: number;
}

const PRICE = /^[0-9]+(\.[0-9]+)?$/;

/**
 * Reads the six markets' prices from the body of POST /info {"type":"metaAndAssetCtxs"}: a two-item array of
 * `meta` and one context per market, in the same order. Each market is looked up at 01 §4's index and its name
 * is checked, so a moved market fails loudly instead of returning another coin's price.
 */
export function parsePrices(body: string, network: Network): PriceRow[] {
  const data: unknown = JSON.parse(body);
  if (!Array.isArray(data) || data.length !== 2 || !Array.isArray(data[1])) {
    throw new Error("Hyperliquid metaAndAssetCtxs: expected [meta, contexts]");
  }
  const assets = readMeta(data[0]);
  const contexts: unknown[] = data[1];
  if (contexts.length !== assets.length) {
    throw new Error("Hyperliquid metaAndAssetCtxs: market list and contexts differ in length");
  }
  return MARKETS.map((row): PriceRow => {
    const index = row.hl_asset[network];
    const asset = assets[index];
    const ctx = contexts[index];
    if (asset?.name !== row.hl_name) {
      throw new Error(
        `Hyperliquid ${network}: index ${index} is ${asset?.name ?? "missing"}, not ${row.hl_name}`,
      );
    }
    if (!isRecord(ctx) || typeof ctx.markPx !== "string" || typeof ctx.prevDayPx !== "string") {
      throw new Error(`Hyperliquid ${network}: no prices for ${row.hl_name}`);
    }
    if (!PRICE.test(ctx.markPx) || !PRICE.test(ctx.prevDayPx)) {
      throw new Error(`Hyperliquid ${network}: unexpected price format for ${row.hl_name}`);
    }
    return {
      market: row.market,
      hl_name: row.hl_name,
      mark_px: ctx.markPx,
      prev_day_px: ctx.prevDayPx,
      max_leverage: asset.maxLeverage,
    };
  });
}

/** Current prices of the six markets. Read-only. Returns the raw body and the exact call, for the record. */
export async function fetchPrices(
  network: Network,
  fetchFn: typeof fetch,
): Promise<{ body: string; rows: PriceRow[]; source: string }> {
  const body = await postInfo(network, "metaAndAssetCtxs", fetchFn);
  const source = `POST ${HL_INFO_URL[network]} {"type":"metaAndAssetCtxs"}`;
  return { body, rows: parsePrices(body, network), source };
}

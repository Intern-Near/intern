/**
 * The six markets, copied from 01-SHARED-INTERFACE.md section 4 (interface version 1.0).
 * Engine 1 will publish the same table as intern/interface/markets.json; switch to that file once it exists.
 * Hyperliquid's indexes differ per network and can change, so `npm run check` compares this table with
 * Hyperliquid's live market list.
 */
export type Market = "DOGE" | "SHIB" | "PEPE" | "PENGU" | "WIF" | "TRUMP";
export type Network = "testnet" | "mainnet";

export interface MarketRow {
  readonly market: Market;
  /** Hyperliquid's name. kSHIB and kPEPE are priced per 1,000 coins. */
  readonly hl_name: string;
  /** Position in Hyperliquid's `meta.universe`, per network. */
  readonly hl_asset: Readonly<Record<Network, number>>;
  readonly sz_decimals: number;
}

export const MARKETS: readonly MarketRow[] = [
  { market: "DOGE", hl_name: "DOGE", hl_asset: { testnet: 173, mainnet: 12 }, sz_decimals: 0 },
  { market: "SHIB", hl_name: "kSHIB", hl_asset: { testnet: 29, mainnet: 38 }, sz_decimals: 0 },
  { market: "PEPE", hl_name: "kPEPE", hl_asset: { testnet: 12, mainnet: 15 }, sz_decimals: 0 },
  { market: "PENGU", hl_name: "PENGU", hl_asset: { testnet: 139, mainnet: 163 }, sz_decimals: 0 },
  { market: "WIF", hl_name: "WIF", hl_asset: { testnet: 78, mainnet: 98 }, sz_decimals: 0 },
  { market: "TRUMP", hl_name: "TRUMP", hl_asset: { testnet: 150, mainnet: 174 }, sz_decimals: 1 },
];

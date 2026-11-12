import type { Packable, Sig } from "./hash.ts";

// Hyperliquid testnet's two endpoints, as plain fetch (browser and Node).

export const HL_TESTNET = "https://api.hyperliquid-testnet.xyz";

export interface Market {
  name: string;
  asset: number;
  szDecimals: number;
  maxLeverage: number;
}

export interface Reply {
  status: "ok" | "err";
  response: unknown;
}

export async function info(
  body: Record<string, unknown>,
  url = HL_TESTNET,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchFn(`${url}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid /info ${JSON.stringify(body)}: HTTP ${res.status}`);
  return res.json();
}

export async function exchange(
  action: Packable,
  nonce: number,
  signature: Sig,
  opts: { l1: boolean; url?: string; fetchFn?: typeof fetch },
): Promise<Reply> {
  const body: Record<string, unknown> = { action, nonce, signature };
  if (opts.l1) body.vaultAddress = null; // L1 actions name no vault; user-signed actions carry no such field
  const res = await (opts.fetchFn ?? fetch)(`${opts.url ?? HL_TESTNET}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Reply;
  } catch {
    return { status: "err", response: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
}

/** Markets by name, with their asset index (their place in the universe). */
export async function markets(url = HL_TESTNET, fetchFn: typeof fetch = fetch): Promise<Map<string, Market>> {
  const meta = (await info({ type: "meta" }, url, fetchFn)) as {
    universe: { name: string; szDecimals: number; maxLeverage: number }[];
  };
  return new Map(meta.universe.map((m, asset) => [m.name, { ...m, asset }]));
}

export async function mids(url = HL_TESTNET, fetchFn: typeof fetch = fetch): Promise<Record<string, string>> {
  return (await info({ type: "allMids" }, url, fetchFn)) as Record<string, string>;
}

export interface Position {
  coin: string;
  /** Signed size: positive long, negative short. */
  szi: number;
  entryPx: number | null;
  unrealizedPnl: number;
  marginUsed: number;
}

export interface Account {
  accountValue: number;
  withdrawable: number;
  positions: Position[];
}

export async function account(
  user: string,
  url = HL_TESTNET,
  fetchFn: typeof fetch = fetch,
): Promise<Account> {
  const s = (await info({ type: "clearinghouseState", user }, url, fetchFn)) as {
    marginSummary?: { accountValue?: string };
    withdrawable?: string;
    assetPositions?: {
      position: {
        coin: string;
        szi: string;
        entryPx: string | null;
        unrealizedPnl: string;
        marginUsed: string;
      };
    }[];
  };
  return {
    accountValue: Number(s.marginSummary?.accountValue ?? 0),
    withdrawable: Number(s.withdrawable ?? 0),
    positions: (s.assetPositions ?? []).map(({ position: p }) => ({
      coin: p.coin,
      szi: Number(p.szi),
      entryPx: p.entryPx === null ? null : Number(p.entryPx),
      unrealizedPnl: Number(p.unrealizedPnl),
      marginUsed: Number(p.marginUsed),
    })),
  };
}

/** The trading keys (agents) a user has approved, lower-case. */
export async function agentsOf(
  user: string,
  url = HL_TESTNET,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const list = (await info({ type: "extraAgents", user }, url, fetchFn)) as { address: string }[] | null;
  return (list ?? []).map((a) => a.address.toLowerCase());
}

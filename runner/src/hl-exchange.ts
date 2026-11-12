import { isRecord } from "./json.ts";

/**
 * Hyperliquid testnet, for the runner: delivering the orders the contract signed, and reading back what happened.
 *
 * Only testnet addresses are in this file, on purpose: the runner never sends anything to Hyperliquid mainnet.
 * Shapes are from Hyperliquid's API docs (exchange-endpoint, info-endpoint, nonces-and-api-wallets pages, read
 * 2026-11-11), its official Python SDK 0.24.0 (`exchange.py` `_post_action`, `info.py`), the research probe's real
 * replies (`research-scripts/hl_guard_e2e_output.txt`) and live read-only replies saved in `fixtures/hl/info/`.
 */
export const HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";
export const HL_TESTNET_EXCHANGE = "https://api.hyperliquid-testnet.xyz/exchange";

async function postJson(
  url: string,
  body: string,
  fetchFn: typeof fetch,
): Promise<{ status: number; body: string }> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.text() };
}

/** One /info request and Hyperliquid's reply exactly as it came, kept as evidence of what a result was worked out from. */
export interface InfoRecord {
  request: Record<string, unknown>;
  http_status: number;
  reply: string;
  fetched_at: string;
}

/** Receives every /info reply of a read, for saving. */
export type Keep = (r: InfoRecord) => void;

async function info(request: Record<string, unknown>, fetchFn: typeof fetch, keep?: Keep): Promise<unknown> {
  const reply = await postJson(HL_TESTNET_INFO, JSON.stringify(request), fetchFn);
  keep?.({ request, http_status: reply.status, reply: reply.body, fetched_at: new Date().toISOString() });
  if (reply.status !== 200) {
    throw new Error(
      `Hyperliquid testnet /info ${String(request.type)}: HTTP ${reply.status}: ${reply.body.slice(0, 200)}`,
    );
  }
  return JSON.parse(reply.body);
}

// ---------------------------------------------------------------- prices

/** Mid prices of every market, by Hyperliquid name: POST /info {"type":"allMids"} (the SDK's `all_mids`). */
export async function fetchMids(fetchFn: typeof fetch): Promise<Record<string, string>> {
  const data = await info({ type: "allMids" }, fetchFn);
  if (!isRecord(data)) throw new Error("Hyperliquid allMids: not an object");
  const mids: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (typeof v === "string") mids[k] = v;
  return mids;
}

// ---------------------------------------------------------------- delivering a signed action

export interface SignedForDelivery {
  action: Record<string, unknown>;
  nonce: number;
  expires_after: number;
  signature: { r: string; s: string; v: number };
}

/**
 * The body of POST /exchange: `{action, nonce, signature, vaultAddress, expiresAfter}` (the SDK's `_post_action`;
 * the research probe sent exactly this and Hyperliquid testnet recovered the contract's address). The action and
 * the signature are sent exactly as the contract gave them.
 */
export function exchangeBody(a: SignedForDelivery): string {
  return JSON.stringify({
    action: a.action,
    nonce: a.nonce,
    signature: a.signature,
    vaultAddress: null,
    expiresAfter: a.expires_after,
  });
}

/** Why an action is not sent, or null when it can be. */
export function cannotDeliver(a: SignedForDelivery, nowMs: number, marginMs = 2_000): string | null {
  // After expiresAfter Hyperliquid rejects the action, and counts it five times against the rate limit (its docs).
  if (nowMs >= a.expires_after - marginMs) return `expired at ${new Date(a.expires_after).toISOString()}`;
  // Hyperliquid's own form is v = 27 or 28 (the probe: 27 + recovery id, accepted). 01 does not say (item N).
  if (a.signature.v !== 27 && a.signature.v !== 28)
    return `signature v is ${a.signature.v}, not 27 or 28 (item N)`;
  return null;
}

export type OrderStatus =
  | { resting: { oid: number } }
  | { filled: { totalSz: string; avgPx: string; oid: number } }
  | { error: string };

export type ExchangeReply =
  | { kind: "ok"; type: string; statuses: OrderStatus[] }
  | { kind: "err"; message: string };

/**
 * Reads a reply of POST /exchange. Documented forms: `{"status":"ok","response":{"type":"default"}}` (update
 * leverage); `{"status":"ok","response":{"type":"order","data":{"statuses":[…]}}}` where each status is
 * `{"resting":{"oid":…}}`, `{"filled":{"totalSz":…,"avgPx":…,"oid":…}}` or `{"error":"…"}`; and
 * `{"status":"err","response":"<message>"}` (seen in the probe). Anything else throws.
 */
export function parseExchangeReply(body: string): ExchangeReply {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data)) throw new Error("Hyperliquid /exchange: reply is not an object");
  if (data.status === "err") return { kind: "err", message: String(data.response) };
  if (data.status !== "ok" || !isRecord(data.response) || typeof data.response.type !== "string") {
    throw new Error(`Hyperliquid /exchange: unexpected reply ${body.slice(0, 200)}`);
  }
  const type = data.response.type;
  if (type !== "order") return { kind: "ok", type, statuses: [] };
  const d = data.response.data;
  if (!isRecord(d) || !Array.isArray(d.statuses))
    throw new Error("Hyperliquid /exchange: order reply has no statuses");
  const statuses = d.statuses.map((s: unknown): OrderStatus => {
    if (isRecord(s) && typeof s.error === "string") return { error: s.error };
    if (isRecord(s) && isRecord(s.resting) && typeof s.resting.oid === "number")
      return { resting: { oid: s.resting.oid } };
    if (
      isRecord(s) &&
      isRecord(s.filled) &&
      typeof s.filled.totalSz === "string" &&
      typeof s.filled.avgPx === "string" &&
      typeof s.filled.oid === "number"
    ) {
      return { filled: { totalSz: s.filled.totalSz, avgPx: s.filled.avgPx, oid: s.filled.oid } };
    }
    throw new Error(`Hyperliquid /exchange: unexpected order status ${JSON.stringify(s).slice(0, 200)}`);
  });
  return { kind: "ok", type, statuses };
}

/**
 * The address in Hyperliquid's refusal "User or API Wallet 0x… does not exist.", lower case, or null for any other
 * reply. Hyperliquid recovers the signer from the signature first, so this names the address that signed: if it is
 * the contract's, the signature is right and the account simply has no funds yet (seen in the research and by
 * Engine 1 on testnet).
 */
export function missingAccount(body: string): string | null {
  let reply: ExchangeReply;
  try {
    reply = parseExchangeReply(body);
  } catch {
    return null;
  }
  if (reply.kind !== "err") return null;
  const m = /^User or API Wallet (0x[0-9a-fA-F]{40}) does not exist\.?$/.exec(reply.message.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** POST /exchange on testnet with the exact body given. No retry: a signed action is sent once. */
export async function postExchange(
  body: string,
  fetchFn: typeof fetch,
): Promise<{ status: number; body: string }> {
  return postJson(HL_TESTNET_EXCHANGE, body, fetchFn);
}

// ---------------------------------------------------------------- reading back: fills and funding

/** One fill (field names as in the docs and in live replies). Amounts stay Hyperliquid's decimal strings. */
export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  dir: string;
  closedPnl: string;
  fee: string;
  feeToken: string;
  oid: number;
  tid: number;
}

export function readFills(data: unknown): Fill[] {
  if (!Array.isArray(data)) throw new Error("Hyperliquid fills: not a list");
  return data.map((f: unknown, i: number): Fill => {
    if (
      !isRecord(f) ||
      typeof f.coin !== "string" ||
      typeof f.px !== "string" ||
      typeof f.sz !== "string" ||
      (f.side !== "B" && f.side !== "A") ||
      typeof f.time !== "number" ||
      typeof f.dir !== "string" ||
      typeof f.closedPnl !== "string" ||
      typeof f.fee !== "string" ||
      typeof f.feeToken !== "string" ||
      typeof f.oid !== "number" ||
      typeof f.tid !== "number"
    ) {
      throw new Error(`Hyperliquid fills: entry ${i} has an unexpected shape`);
    }
    return {
      coin: f.coin,
      px: f.px,
      sz: f.sz,
      side: f.side,
      time: f.time,
      dir: f.dir,
      closedPnl: f.closedPnl,
      fee: f.fee,
      feeToken: f.feeToken,
      oid: f.oid,
      tid: f.tid,
    };
  });
}

/** One funding payment on a position. `usdc` > 0 means the account received it (checked on live records). */
export interface FundingPayment {
  time: number;
  coin: string;
  usdc: string;
  szi: string;
}

export function readFunding(data: unknown): FundingPayment[] {
  if (!Array.isArray(data)) throw new Error("Hyperliquid userFunding: not a list");
  return data.map((r: unknown, i: number): FundingPayment => {
    const d = isRecord(r) ? r.delta : undefined;
    if (
      !isRecord(r) ||
      typeof r.time !== "number" ||
      !isRecord(d) ||
      d.type !== "funding" ||
      typeof d.coin !== "string" ||
      typeof d.usdc !== "string" ||
      typeof d.szi !== "string"
    ) {
      throw new Error(`Hyperliquid userFunding: entry ${i} has an unexpected shape`);
    }
    return { time: r.time, coin: d.coin, usdc: d.usdc, szi: d.szi };
  });
}

/**
 * Pages through a time-range query. Hyperliquid caps each reply (the docs give 2,000 fills and, for time ranges,
 * 500 elements); when a reply is full, the next page starts at its last time (inclusive), and repeats are removed.
 */
async function pagedByTime<T extends { time: number }>(
  fetchPage: (startTime: number) => Promise<T[]>,
  key: (x: T) => string,
  startTime: number,
  endTime: number,
): Promise<T[]> {
  const seen = new Map<string, T>();
  for (let from = startTime; ; ) {
    const page = await fetchPage(from);
    let added = 0;
    for (const x of page) {
      if (x.time < startTime || x.time > endTime) continue;
      if (!seen.has(key(x))) {
        seen.set(key(x), x);
        added++;
      }
    }
    const last = page.at(-1)?.time;
    if (page.length < 500 || added === 0 || last === undefined || last >= endTime) break;
    from = last;
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

/** The account's fills from `startTime` to `endTime` (ms, both inclusive): POST /info {"type":"userFillsByTime"}. */
export function fetchFills(
  user: string,
  startTime: number,
  endTime: number,
  fetchFn: typeof fetch,
  keep?: Keep,
): Promise<Fill[]> {
  return pagedByTime(
    async (from) =>
      readFills(await info({ type: "userFillsByTime", user, startTime: from, endTime }, fetchFn, keep)),
    (f) => String(f.tid),
    startTime,
    endTime,
  );
}

/** Funding paid or received from `startTime` to `endTime`: POST /info {"type":"userFunding"}. */
export function fetchFunding(
  user: string,
  startTime: number,
  endTime: number,
  fetchFn: typeof fetch,
  keep?: Keep,
): Promise<FundingPayment[]> {
  return pagedByTime(
    async (from) =>
      readFunding(await info({ type: "userFunding", user, startTime: from, endTime }, fetchFn, keep)),
    (f) => `${f.time}:${f.coin}`,
    startTime,
    endTime,
  );
}

/** The account's open perp positions, by Hyperliquid name, with their signed size: POST /info {"type":"clearinghouseState"}. */
export async function fetchOpenPositions(
  user: string,
  fetchFn: typeof fetch,
  keep?: Keep,
): Promise<Record<string, string>> {
  const data = await info({ type: "clearinghouseState", user }, fetchFn, keep);
  if (!isRecord(data) || !Array.isArray(data.assetPositions)) {
    throw new Error("Hyperliquid clearinghouseState: no assetPositions");
  }
  const out: Record<string, string> = {};
  for (const ap of data.assetPositions) {
    const p = isRecord(ap) ? ap.position : undefined;
    if (!isRecord(p) || typeof p.coin !== "string" || typeof p.szi !== "string") {
      throw new Error("Hyperliquid clearinghouseState: unexpected position shape");
    }
    out[p.coin] = p.szi;
  }
  return out;
}

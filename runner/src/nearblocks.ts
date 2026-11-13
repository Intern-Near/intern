import { isRecord } from "./json.ts";

/**
 * A read-only client for one endpoint of NearBlocks' public API (testnet), used to find the transaction behind a
 * contract call: NEAR's RPC has no "transactions of an account" query. Checked on 2026-11-13 against the API's own
 * description (https://api-testnet.nearblocks.io/openapi.json, version 3) and by running it:
 *   GET /v3/accounts/{account}/receipts?method=<name>&before_ts=<19-digit ns>&limit=<1..100>
 * answers {"data": [receipt, ...], "meta": {"next_page": ...}}, newest first; each receipt carries `transaction_hash`,
 * `predecessor_account_id`, `receiver_account_id`, `actions[].method`, `outcome.status` and `block.block_timestamp`
 * (nanoseconds, a string), the block the receipt ran in. No key is sent. NearBlocks asks for attribution ("Powered by
 * Nearblocks.io APIs") when its data is shown to others; its free rate limit is not stated (UNVERIFIED): an HTTP 429
 * is reported, never retried in a loop.
 */
export const NEARBLOCKS_TESTNET_API = "https://api-testnet.nearblocks.io";

/**
 * The explorer page of a testnet transaction. The form `https://testnet.nearblocks.io/txns/<hash>` is the link NEAR's own
 * explorer (explorer.testnet.near.org/transactions/<hash>) gave for a transaction on 2026-11-13; the page itself sits
 * behind a browser check, so it was not fetched.
 */
export const txLink = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;

export interface NearblocksExchange {
  url: string;
  status: number;
  body: string;
  fetched_at: string;
}

export interface ReceiptRow {
  receipt_id: string;
  transaction_hash: string;
  predecessor_account_id: string;
  receiver_account_id: string;
  methods: string[];
  /** The receipt's block time in nanoseconds (a decimal string). */
  block_timestamp_ns: string;
  block_height: number | null;
  /** NearBlocks' `outcome.status`: true when the receipt succeeded. */
  ok: boolean | null;
}

export class NearblocksError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

function readRow(v: unknown, i: number): ReceiptRow {
  const where = `NearBlocks receipt ${i}`;
  if (!isRecord(v)) throw new NearblocksError(`${where}: not an object`, null);
  const block = isRecord(v.block) ? v.block : {};
  const text = (o: Record<string, unknown>, k: string): string => {
    const x = o[k];
    if (typeof x !== "string") throw new NearblocksError(`${where}: ${k} is not a string`, null);
    return x;
  };
  const ts = text(block, "block_timestamp");
  if (!/^\d+$/.test(ts)) throw new NearblocksError(`${where}: block_timestamp is not a whole number`, null);
  const height = Number(block.block_height);
  return {
    receipt_id: text(v, "receipt_id"),
    transaction_hash: text(v, "transaction_hash"),
    predecessor_account_id: text(v, "predecessor_account_id"),
    receiver_account_id: text(v, "receiver_account_id"),
    methods: Array.isArray(v.actions)
      ? v.actions.flatMap((a: unknown) => (isRecord(a) && typeof a.method === "string" ? [a.method] : []))
      : [],
    block_timestamp_ns: ts,
    block_height: Number.isSafeInteger(height) ? height : null,
    ok: isRecord(v.outcome) && typeof v.outcome.status === "boolean" ? v.outcome.status : null,
  };
}

/** One page of an account's receipts calling `method`, newest first, before `beforeNs` (exclusive) when given. */
export async function receiptsCalling(
  fetchFn: typeof fetch,
  q: { account: string; method: string; beforeNs?: bigint; limit: number },
  record?: (e: NearblocksExchange) => void,
): Promise<{ rows: ReceiptRow[]; next: string | null }> {
  const params = new URLSearchParams({ method: q.method, limit: String(q.limit) });
  if (q.beforeNs !== undefined) {
    const ns = q.beforeNs.toString();
    if (ns.length !== 19)
      throw new NearblocksError(`before_ts must be 19 digits of nanoseconds, not ${ns}`, null);
    params.set("before_ts", ns);
  }
  const url = `${NEARBLOCKS_TESTNET_API}/v3/accounts/${encodeURIComponent(q.account)}/receipts?${params}`;
  const res = await fetchFn(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  record?.({ url, status: res.status, body, fetched_at: new Date().toISOString() });
  if (res.status === 429)
    throw new NearblocksError("NearBlocks answered HTTP 429: its rate limit, try later", 429);
  if (res.status !== 200)
    throw new NearblocksError(`NearBlocks answered HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new NearblocksError("NearBlocks' reply is not JSON", res.status);
  }
  if (!isRecord(data) || !Array.isArray(data.data))
    throw new NearblocksError("NearBlocks' reply has no data list", res.status);
  const next = isRecord(data.meta) && typeof data.meta.next_page === "string" ? data.meta.next_page : null;
  return { rows: data.data.map(readRow), next };
}

/** The block time in milliseconds, as a contract sees it (`env::block_timestamp_ms()`: nanoseconds / 10^6). */
export const blockMs = (row: ReceiptRow): number => Number(BigInt(row.block_timestamp_ns) / 1_000_000n);

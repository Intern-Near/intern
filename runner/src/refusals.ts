import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ChainVerdict, readVerdict } from "./contract.ts";
import { usd } from "./fills-check.ts";
import { isRecord } from "./json.ts";
import { type RpcExchange, rpcCall } from "./near-rpc.ts";
import { blockMs, type NearblocksExchange, receiptsCalling, txLink } from "./nearblocks.ts";
import { REFUSAL_CODES } from "./rules.ts";
import { coinEvents } from "./verify-round.ts";

/**
 * The refusal catalogue: for each of the sixteen NOPE codes (01 §7), the refusals a coin contract has recorded
 * (`get_refusals`, 01 §8: newest first, `from` is the highest id to return, `limit` at most 100), how many, and the
 * first one with its round and numbers. Where it can be found read-only, the first one's transaction too: NearBlocks
 * lists the coin's `propose` receipts by time (src/nearblocks.ts), a refusal's `at` is the block time of the proposal
 * that made it, and the transaction is then read from NEAR RPC (`tx`, an archival node for old ones) to confirm that
 * it returned that very refusal. Nothing is signed or sent.
 */

/** The test copy of the coin (5-minute rounds, stand-in AI check). Not in deployments.json; verify.sh and tools/view.py
 * add it the same way (fixtures/chain/testnet-accounts.md). */
export const COIN_FAST = "coin-fast.desk-lab-2026.testnet";

/** 01 §8: `limit` is capped at 100. */
const PAGE = 100;

export interface Refusal {
  id: number;
  round_id: number;
  code: string;
  at: number;
  asked: string | null;
  limit: string | null;
  /** 01 §8.1 `Decision`, as the contract returned it; null when the answer could not be read. */
  decision: Record<string, unknown> | null;
  is_first: boolean;
  credited_to: string | null;
}

/** The codes as interface/refusal-codes.json describes them (the owner's file; the runner's copy when it is absent). */
export interface CodeInfo {
  check: number;
  code: string;
  light: number | null;
  fails_when: string | null;
  asked: string | null;
  limit: string | null;
}

const CODES_FILE = fileURLToPath(new URL("../../interface/refusal-codes.json", import.meta.url));

export function readCodeTable(file = CODES_FILE): { codes: CodeInfo[]; source: string } {
  if (existsSync(file)) {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    const rows = isRecord(data) && Array.isArray(data.codes) ? data.codes : [];
    const codes = rows.flatMap((r: unknown): CodeInfo[] =>
      isRecord(r) && typeof r.code === "string" && typeof r.check === "number"
        ? [
            {
              check: r.check,
              code: r.code,
              light: typeof r.light === "number" ? r.light : null,
              fails_when: typeof r.fails_when === "string" ? r.fails_when : null,
              asked: typeof r.asked === "string" ? r.asked : null,
              limit: typeof r.limit === "string" ? r.limit : null,
            },
          ]
        : [],
    );
    if (codes.length > 0) return { codes, source: "interface/refusal-codes.json" };
  }
  return {
    codes: REFUSAL_CODES.map((code, i) => ({
      check: i + 1,
      code,
      light: null,
      fails_when: null,
      asked: null,
      limit: null,
    })),
    source: "runner/src/rules.ts (interface/refusal-codes.json is not here)",
  };
}

function readRefusal(v: unknown, i: number): Refusal {
  const where = `get_refusals[${i}]`;
  if (!isRecord(v)) throw new Error(`${where}: not an object`);
  const whole = (k: string): number => {
    const x = v[k];
    if (typeof x !== "number" || !Number.isSafeInteger(x))
      throw new Error(`${where}.${k}: not a whole number`);
    return x;
  };
  const textOrNull = (k: string): string | null => {
    const x = v[k];
    if (x === null || x === undefined) return null;
    if (typeof x !== "string") throw new Error(`${where}.${k}: not a string or null`);
    return x;
  };
  if (typeof v.code !== "string") throw new Error(`${where}.code: not a string`);
  if (typeof v.is_first !== "boolean") throw new Error(`${where}.is_first: not true or false`);
  return {
    id: whole("id"),
    round_id: whole("round_id"),
    code: v.code,
    at: whole("at"),
    asked: textOrNull("asked"),
    limit: textOrNull("limit"),
    decision: isRecord(v.decision) ? v.decision : null,
    is_first: v.is_first,
    credited_to: textOrNull("credited_to"),
  };
}

/** Every refusal the coin keeps, oldest first, read page by page from the newest. */
export async function readAllRefusals(
  view: (method: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Refusal[]> {
  const all: Refusal[] = [];
  for (let from: number | undefined; ; ) {
    const args: Record<string, unknown> = { limit: PAGE };
    if (from !== undefined) args.from = from;
    const page = await view("get_refusals", args);
    if (!Array.isArray(page)) throw new Error("get_refusals: expected a list");
    const rows = page.map(readRefusal);
    for (const r of rows) {
      const prev = all[all.length - 1];
      if (prev !== undefined && r.id >= prev.id) throw new Error("get_refusals: ids do not go down");
      if (from !== undefined && r.id > from) throw new Error(`get_refusals: id ${r.id} above from ${from}`);
      all.push(r);
    }
    const last = rows[rows.length - 1];
    if (rows.length < PAGE || last === undefined || last.id <= 1) return all.reverse();
    from = last.id - 1;
  }
}

// ---------------------------------------------------------------- finding the transaction

export interface TxFound {
  tx_hash: string;
  link: string;
  /** The account that sent it (the receipt's predecessor: the runner of that time). */
  sender: string;
  block_height: number | null;
  /** True when the RPC shows the transaction returned this very refusal (id and code). */
  confirmed: boolean;
  /** The RPC node the transaction was read from; null when it could not be read. */
  read_from: string | null;
  note: string;
}

export interface LookupDeps {
  fetchFn: typeof fetch;
  /** NEAR RPC URLs for `tx`: the regular node, then archival ones (near-rpc.ts). */
  rpcs: readonly string[];
  record?: (e: RpcExchange) => void;
  recordNearblocks?: (e: NearblocksExchange) => void;
}

/** The verdict a `propose` transaction returned, from its first receipt (as verify-round reads it), or null. */
export function proposeVerdict(tx: unknown): { verdict: ChainVerdict; refusedEvent: boolean } | null {
  if (!isRecord(tx)) return null;
  const txOutcome =
    isRecord(tx.transaction_outcome) && isRecord(tx.transaction_outcome.outcome)
      ? tx.transaction_outcome.outcome
      : {};
  const first = isRecord(txOutcome.status) ? txOutcome.status.SuccessReceiptId : undefined;
  const receipts = Array.isArray(tx.receipts_outcome) ? tx.receipts_outcome : [];
  const receipt = receipts.find((r: unknown) => isRecord(r) && r.id === first);
  const outcome = isRecord(receipt) && isRecord(receipt.outcome) ? receipt.outcome : null;
  const status = outcome && isRecord(outcome.status) ? outcome.status : null;
  if (outcome === null || status === null || typeof status.SuccessValue !== "string") return null;
  try {
    const verdict = readVerdict(JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")));
    const events = coinEvents(Array.isArray(outcome.logs) ? outcome.logs : []);
    const refusedEvent =
      verdict.verdict === "NOPE" &&
      events.some(
        (e) =>
          e.event === "refused" && e.data.refusal_id === verdict.refusal_id && e.data.code === verdict.code,
      );
    return { verdict, refusedEvent };
  } catch {
    return null;
  }
}

/**
 * The transaction of the proposal that made `refusal`: NearBlocks' propose receipts at that millisecond, each checked
 * with the RPC. Throws when NearBlocks has none or cannot be read; returns an unconfirmed find when the RPC cannot.
 */
export async function findRefusalTx(deps: LookupDeps, coin: string, refusal: Refusal): Promise<TxFound> {
  const { rows } = await receiptsCalling(
    deps.fetchFn,
    { account: coin, method: "propose", beforeNs: (BigInt(refusal.at) + 1n) * 1_000_000n, limit: 10 },
    deps.recordNearblocks,
  );
  const candidates = rows.filter((r) => r.receiver_account_id === coin && blockMs(r) === refusal.at);
  if (candidates.length === 0)
    throw new Error(
      `NearBlocks lists no propose receipt to ${coin} at ${new Date(refusal.at).toISOString()}`,
    );
  const notes: string[] = [];
  for (const c of candidates) {
    try {
      const a = await rpcCall(
        deps.rpcs,
        "tx",
        { tx_hash: c.transaction_hash, sender_account_id: c.predecessor_account_id, wait_until: "NONE" },
        deps.fetchFn,
        deps.record,
      );
      const v = proposeVerdict(a.result);
      if (
        v?.verdict.verdict === "NOPE" &&
        v.verdict.refusal_id === refusal.id &&
        v.verdict.code === refusal.code
      )
        return {
          tx_hash: c.transaction_hash,
          link: txLink(c.transaction_hash),
          sender: c.predecessor_account_id,
          block_height: c.block_height,
          confirmed: true,
          read_from: a.url,
          note: `it returned NOPE ${refusal.code}, refusal ${refusal.id}${v.refusedEvent ? ", and logged the refused event" : ""}`,
        };
      notes.push(`${c.transaction_hash} returned ${v === null ? "no readable verdict" : v.verdict.verdict}`);
    } catch (e) {
      notes.push(`${c.transaction_hash} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only !== undefined && notes[0]?.includes("could not be read"))
    return {
      tx_hash: only.transaction_hash,
      link: txLink(only.transaction_hash),
      sender: only.predecessor_account_id,
      block_height: only.block_height,
      confirmed: false,
      read_from: null,
      note: `the only propose receipt NearBlocks lists at that millisecond; ${notes[0]}`,
    };
  throw new Error(`no propose transaction at that time returned refusal ${refusal.id}: ${notes.join("; ")}`);
}

// ---------------------------------------------------------------- the catalogue

/**
 * Codes whose two numbers are dollars with 6 decimals (01 §7's asked and limit: notional and min_notional, margin and
 * the per-bet limit, at_risk + margin and the per-round limit; 01 §2 Usdc). QUOTE_MISMATCH's "quote amount" is left as
 * a raw number: 01 does not give its unit.
 */
const DOLLAR_CODES = new Set(["ZERO_MARGIN", "OVER_TRADE_LIMIT", "OVER_ROUND_LIMIT"]);

/** One refusal in plain words: what was asked, what the limit was, and the bet when there was one. */
export function describeRefusal(r: Refusal, info: CodeInfo | undefined): string {
  const parts: string[] = [];
  const d = r.decision;
  if (d !== null && d.action === "BET") {
    const margin =
      typeof d.margin === "string" && /^\d+$/.test(d.margin) ? `$${usd(BigInt(d.margin))}` : String(d.margin);
    parts.push(`${String(d.market)} ${String(d.side).toLowerCase()} ${margin} at ${String(d.leverage)}x`);
  } else if (d !== null && d.action === "SKIP") parts.push("a skip");
  else parts.push("no decision recorded");
  const num = (v: string | null): string | null =>
    v === null ? null : DOLLAR_CODES.has(r.code) && /^\d+$/.test(v) ? `$${usd(BigInt(v))}` : v;
  const asked = num(r.asked);
  const limit = num(r.limit);
  if (asked !== null) parts.push(`asked ${asked}${info?.asked ? ` (${info.asked})` : ""}`);
  if (limit !== null) parts.push(`limit ${limit}${info?.limit ? ` (${info.limit})` : ""}`);
  if (r.credited_to !== null) parts.push(`credited to ${r.credited_to}`);
  return parts.join("; ");
}

export interface CodeEntry {
  check: number;
  code: string;
  light: number | null;
  fails_when: string | null;
  count: number;
  first: {
    refusal_id: number;
    round_id: number;
    at: number;
    at_iso: string;
    is_first: boolean;
    asked: string | null;
    limit: string | null;
    decision: Record<string, unknown> | null;
    credited_to: string | null;
    detail: string;
    tx: TxFound | null;
    /** Why there is no transaction, when there is none. */
    tx_note: string | null;
  } | null;
}

export interface CoinCatalogue {
  coin: string;
  refusals: number;
  ids: { first: number | null; last: number | null };
  codes: CodeEntry[];
  /** Codes on chain that are not among the sixteen (none expected). */
  unknown_codes: { code: string; count: number }[];
  with_example: string[];
  without_example: string[];
}

/** Groups a coin's refusals by code, in check order; finds the first example's transaction when `lookup` is given. */
export async function catalogue(
  coin: string,
  refusals: readonly Refusal[],
  table: readonly CodeInfo[],
  lookup: ((r: Refusal) => Promise<TxFound>) | null,
): Promise<CoinCatalogue> {
  const codes: CodeEntry[] = [];
  for (const info of [...table].sort((a, b) => a.check - b.check)) {
    const mine = refusals.filter((r) => r.code === info.code);
    const first = mine[0];
    let tx: TxFound | null = null;
    let txNote: string | null = null;
    if (first !== undefined) {
      if (lookup === null) txNote = "not looked up (--no-tx)";
      else
        try {
          tx = await lookup(first);
        } catch (e) {
          txNote = e instanceof Error ? e.message : String(e);
        }
    }
    codes.push({
      check: info.check,
      code: info.code,
      light: info.light,
      fails_when: info.fails_when,
      count: mine.length,
      first:
        first === undefined
          ? null
          : {
              refusal_id: first.id,
              round_id: first.round_id,
              at: first.at,
              at_iso: new Date(first.at).toISOString(),
              is_first: first.is_first,
              asked: first.asked,
              limit: first.limit,
              decision: first.decision,
              credited_to: first.credited_to,
              detail: describeRefusal(first, info),
              tx,
              tx_note: txNote,
            },
    });
  }
  const known = new Set(table.map((c) => c.code));
  const unknown = new Map<string, number>();
  for (const r of refusals) if (!known.has(r.code)) unknown.set(r.code, (unknown.get(r.code) ?? 0) + 1);
  return {
    coin,
    refusals: refusals.length,
    ids: { first: refusals[0]?.id ?? null, last: refusals[refusals.length - 1]?.id ?? null },
    codes,
    unknown_codes: [...unknown].map(([code, count]) => ({ code, count })),
    with_example: codes.filter((c) => c.count > 0).map((c) => c.code),
    without_example: codes.filter((c) => c.count === 0).map((c) => c.code),
  };
}

export interface RefusalsReport {
  tool: "refusals";
  checked_at: string;
  rpc: string;
  nearblocks: string | null;
  codes_source: string;
  coins: CoinCatalogue[];
  summary: {
    refusals: number;
    /** Codes with at least one example on any of the coins. */
    with_example: string[];
    without_example: string[];
    first_tx_found: number;
    first_tx_confirmed: number;
    first_tx_missing: number;
  };
}

export function summarize(
  coins: CoinCatalogue[],
  meta: { checked_at: string; rpc: string; nearblocks: string | null; codes_source: string },
): RefusalsReport {
  const order = coins[0]?.codes.map((c) => c.code) ?? [];
  const seen = new Set(coins.flatMap((c) => c.with_example));
  const firsts = coins.flatMap((c) => c.codes.flatMap((e) => (e.first ? [e.first] : [])));
  return {
    tool: "refusals",
    ...meta,
    coins,
    summary: {
      refusals: coins.reduce((n, c) => n + c.refusals, 0),
      with_example: order.filter((c) => seen.has(c)),
      without_example: order.filter((c) => !seen.has(c)),
      first_tx_found: firsts.filter((f) => f.tx !== null).length,
      first_tx_confirmed: firsts.filter((f) => f.tx?.confirmed).length,
      first_tx_missing: firsts.filter((f) => f.tx === null).length,
    },
  };
}

/** The catalogue as plain lines. */
export function renderRefusals(rep: RefusalsReport): string[] {
  const out = [
    `refusal catalogue, ${rep.checked_at}, testnet (${rep.rpc}). Codes: ${rep.codes_source}.${rep.nearblocks ? ` Transactions found with NearBlocks (${rep.nearblocks}) and confirmed with the RPC.` : ""} Read-only.`,
  ];
  for (const c of rep.coins) {
    out.push(
      "",
      `${c.coin}: ${c.refusals} refusal(s)${c.ids.first === null ? "" : `, ids ${c.ids.first} to ${c.ids.last}`}`,
    );
    for (const e of c.codes) {
      if (e.first === null) continue;
      const f = e.first;
      out.push(
        `  ${String(e.check).padStart(2)} ${e.code.padEnd(20)} ${String(e.count).padStart(3)}  first: refusal ${f.refusal_id}, round ${f.round_id}, ${f.at_iso}: ${f.detail}`,
      );
      if (rep.nearblocks !== null)
        out.push(
          f.tx
            ? `     ${"".padEnd(24)}tx ${f.tx.link}: ${f.tx.confirmed ? `confirmed on ${f.tx.read_from}` : "NOT confirmed"}, ${f.tx.note}`
            : `     ${"".padEnd(24)}tx not found: ${f.tx_note ?? "?"}`,
        );
    }
    for (const u of c.unknown_codes)
      out.push(`  ?? ${u.code.padEnd(20)} ${String(u.count).padStart(3)}  (not one of the sixteen codes)`);
    out.push(`  no example yet (${c.without_example.length}): ${c.without_example.join(", ") || "none"}`);
  }
  const s = rep.summary;
  out.push(
    "",
    `SUMMARY  ${s.refusals} refusal(s) on ${rep.coins.length} coin(s); ${s.with_example.length} of 16 codes have an example (${s.with_example.join(", ") || "none"}); no example anywhere yet: ${s.without_example.join(", ") || "none"}. ${rep.nearblocks === null ? "Transactions not looked up (--no-tx)." : `First examples' transactions: ${s.first_tx_confirmed} confirmed, ${s.first_tx_found - s.first_tx_confirmed} found but not confirmed, ${s.first_tx_missing} not found.`}`,
  );
  return out;
}
